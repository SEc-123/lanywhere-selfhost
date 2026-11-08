/* Modified by LANywhere Self-host, 2026-11-07 to 2026-11-08. */
/*
 * LANywhere: observación de los sockets de los juegos (ver bsd_spy.hpp).
 *
 * This program is free software; you can redistribute it and/or modify it under the terms and conditions of
 * the GNU General Public License, version 2, as published by the Free Software Foundation.
 */
#include "bsd_spy.hpp"
#include "lanywhere_relay.hpp"
#include "virtual_receive.hpp"
#include "udp_port_policy.hpp"
#include "bsd_ipc_abi.hpp"
#include <cstdio>
#include <cstring>
#include <arpa/inet.h>
#include <cerrno>
#include <fcntl.h>
#include <sys/socket.h>
#include <sys/time.h>

namespace ams::mitm::bsd {

    namespace {

        constexpr const char LogPath[] = "sdmc:/lanywhere/bsd.log";
        constexpr TimeSpan SummaryInterval = TimeSpan::FromSeconds(5);
        constexpr size_t MaxSockets = 64, MaxDestinations = 8;

        struct Destination { u32 ip; u16 port; u32 packets; u64 bytes; };
        struct SocketStats {
            bool used;
            s32 fd;
            u64 program_id;
            s32 type, protocol;
            u16 bound_port;  // el de bind(): los paquetes de la sala para ese puerto son de este socket
            u32 peer_ip;     // connect() a otro miembro de la sala (UDP): send() va por el servidor
            u16 peer_port;
            u32 sent_packets;
            u64 sent_bytes;
            Destination dest[MaxDestinations];
            size_t dest_count;
        };

        constinit os::SdkMutex g_lock;
        SocketStats g_sockets[MaxSockets];
        os::Tick g_last_summary;
        u32 g_overflow;

        // Lecturas: cómo recibe el juego (recv / recvfrom / poll) y cuánto.
        struct RecvStats { u32 recv_calls, recv_data, recv_eagain, recvfrom_calls, recvfrom_data, recvfrom_eagain, poll_calls, poll_ready; u64 bytes; };
        RecvStats g_recv;

        // Registro de depuración de los sockets del juego: solo si existe sdmc:/lanywhere/debug.flag (se mira una
        // vez; escribir en la SD con cada operación de red es trabajo de más para una partida normal).
        bool DebugEnabled() {
            static int enabled = -1;
            if (enabled < 0) {
                fs::DirectoryEntryType type;
                enabled = R_SUCCEEDED(fs::GetEntryType(std::addressof(type), "sdmc:/lanywhere/debug.flag")) ? 1 : 0;
            }
            return enabled == 1;
        }

        // Escritura directa al archivo (append); con g_lock tomado.
        void WriteLine(const char *fmt, ...) {
            if (!DebugEnabled()) {
                return;
            }
            char line[256];
            std::va_list vl;
            va_start(vl, fmt);
            const int len = util::VSNPrintf(line, sizeof(line) - 1, fmt, vl);
            va_end(vl);
            if (len <= 0) {
                return;
            }
            line[std::min<int>(len, sizeof(line) - 2)] = '\n';

            fs::FileHandle file;
            if (R_FAILED(fs::OpenFile(std::addressof(file), LogPath, fs::OpenMode_Write | fs::OpenMode_AllowAppend))) {
                static_cast<void>(fs::CreateDirectory("sdmc:/lanywhere"));  // puede existir ya
                if (R_FAILED(fs::CreateFile(LogPath, 0)) || R_FAILED(fs::OpenFile(std::addressof(file), LogPath, fs::OpenMode_Write | fs::OpenMode_AllowAppend))) {
                    return;
                }
            }
            s64 size = 0;
            if (R_SUCCEEDED(fs::GetFileSize(std::addressof(size), file))) {
                static_cast<void>(fs::WriteFile(file, size, line, std::min<int>(len, sizeof(line) - 2) + 1, fs::WriteOption::Flush));
            }
            fs::CloseFile(file);
        }

        const char *FormatAddr(char *out, size_t size, const void *data, size_t len) {
            if (len < sizeof(sockaddr_in)) {
                util::SNPrintf(out, size, "(addr %zu bytes)", len);
                return out;
            }
            const sockaddr_in *a = static_cast<const sockaddr_in *>(data);
            const u32 ip = ntohl(a->sin_addr.s_addr);
            util::SNPrintf(out, size, "%u.%u.%u.%u:%u", ip >> 24, (ip >> 16) & 0xFF, (ip >> 8) & 0xFF, ip & 0xFF, ntohs(a->sin_port));
            return out;
        }

        SocketStats *Find(s32 fd, u64 program_id, bool create) {
            SocketStats *free_slot = nullptr;
            for (auto &s : g_sockets) {
                if (s.used && s.fd == fd && s.program_id == program_id) {
                    return std::addressof(s);
                }
                if (!s.used && free_slot == nullptr) {
                    free_slot = std::addressof(s);
                }
            }
            if (create && free_slot != nullptr) {
                std::memset(free_slot, 0, sizeof(*free_slot));
                free_slot->used = true;
                free_slot->fd = fd;
                free_slot->program_id = program_id;
            }
            return create ? free_slot : nullptr;
        }

        void Summary(const SocketStats &s, const char *why) {
            WriteLine("  fd %d (%s/%d) %s: %u paquetes, %llu bytes enviados a %zu destinos", s.fd,
                      s.type == 1 ? "TCP" : s.type == 2 ? "UDP" : "?", s.protocol, why, s.sent_packets,
                      static_cast<unsigned long long>(s.sent_bytes), s.dest_count);
            for (size_t i = 0; i < s.dest_count; i++) {
                const auto &d = s.dest[i];
                WriteLine("    -> %u.%u.%u.%u:%u  %u paquetes, %llu bytes", d.ip >> 24, (d.ip >> 16) & 0xFF, (d.ip >> 8) & 0xFF, d.ip & 0xFF,
                          d.port, d.packets, static_cast<unsigned long long>(d.bytes));
            }
        }

        void MaybeSummary() {
            const os::Tick now = os::GetSystemTick();
            if ((now - g_last_summary).ToTimeSpan() < SummaryInterval) {
                return;
            }
            g_last_summary = now;
            WriteLine("[%lld s] resumen", static_cast<long long>(now.ToTimeSpan().GetSeconds()));
            for (const auto &s : g_sockets) {
                if (s.used && s.sent_packets) {
                    Summary(s, "activo");
                }
            }
            if (g_overflow) {
                WriteLine("  (%u sockets sin registrar: tabla llena)", g_overflow);
            }
            const auto &r = g_recv;
            WriteLine("  lecturas: recv %u (%u con datos, %u EAGAIN), recvfrom %u (%u con datos, %u EAGAIN), poll %u (%u listos), %llu bytes",
                      r.recv_calls, r.recv_data, r.recv_eagain, r.recvfrom_calls, r.recvfrom_data, r.recvfrom_eagain, r.poll_calls, r.poll_ready,
                      static_cast<unsigned long long>(r.bytes));
        }

        struct Out { s32 ret; s32 err; };
        // Values crossing the forwarded bsd:u IPC boundary are Horizon values,
        // not devkitA64/newlib's POSIX constants (notably O_NONBLOCK and errno).
        constexpr s32 ErrnoAgain = static_cast<s32>(socket::Errno::EAgain);
        constexpr s32 ErrnoIo = static_cast<s32>(socket::Errno::EIo);
        constexpr s32 ErrnoFamily = static_cast<s32>(socket::Errno::EAfNoSupport);
        constexpr s32 ErrnoAddr = static_cast<s32>(socket::Errno::EAddrNotAvail);
        constexpr s32 ErrnoBuffers = static_cast<s32>(socket::Errno::ENoBufs);
        constexpr s32 ErrnoMsgSize = static_cast<s32>(socket::Errno::EMsgSize);
        constexpr s32 ErrnoHost = static_cast<s32>(socket::Errno::EHostUnreach);
        constexpr s32 BsdNonblock = static_cast<s32>(socket::FcntlFlag::O_NonBlock);
        constexpr s32 BsdGetFl = static_cast<s32>(socket::FcntlCommand::F_GetFl);
        constexpr s32 BsdPeek = static_cast<s32>(socket::MsgFlag::Msg_Peek);
        constexpr s32 BsdDontWait = static_cast<s32>(socket::MsgFlag::Msg_DontWait);
        static_assert(BsdNonblock == NativeNonblock && BsdDontWait == NativeDontWait && ErrnoAgain == NativeAgain &&
                      ErrnoMsgSize == NativeMessageSize && ErrnoHost == NativeHostUnreachable);
        struct PollFd { s32 fd; s16 events; s16 revents; };
        constexpr s16 PollIn = 0x0001, PollRdNorm = 0x0040;
        constexpr s32 PollSliceMs = 5;
        constexpr size_t MaxPollFds = 64;

        tcpstream::Owner TcpOwner(const sm::MitmProcessInfo &client) {
            return {client.process_id.value,client.program_id.value};
        }
        u32 TcpDispatch(void *context,uint32_t command,const void *input,size_t input_size,
                        void *output,size_t output_size,const tcpstream::IpcBuffer *buffers,size_t count) {
            AMS_ASSERT(count<=8&&input_size<=UINT32_MAX&&output_size<=UINT32_MAX);
            SfDispatchParams params{};u32 attrs[8]{};
            for(size_t i=0;i<count;i++) {
                attrs[i]=SfBufferAttr_HipcAutoSelect|(buffers[i].output?SfBufferAttr_Out:SfBufferAttr_In);
                params.buffers[i]={buffers[i].data,buffers[i].size};
            }
            static_assert(sizeof(attrs)==sizeof(params.buffer_attrs));
            std::memcpy(&params.buffer_attrs,attrs,sizeof(attrs));
            return serviceDispatchImpl(static_cast<::Service*>(context),command,input,static_cast<u32>(input_size),output,static_cast<u32>(output_size),params);
        }
        void TcpAddress(const sf::OutAutoSelectBuffer &out,tcpstream::Endpoint endpoint) {
            const auto addr=tcpstream::MakeAddress(endpoint);
            if(out.GetSize())std::memcpy(out.GetPointer(),&addr,std::min(out.GetSize(),sizeof(addr)));
        }

        ssize_t TakeRoomPacket(s32 fd, u64 program_id, void *buffer, size_t size, sockaddr_in *from, s32 flags);

    }

    BsdSpyService::BsdSpyService(std::shared_ptr<::Service> &&service,const sm::MitmProcessInfo &client)
        :sf::MitmServiceImplBase(std::forward<std::shared_ptr<::Service>>(service),client) {
        tcpstream::Global().ClientOpen(TcpOwner(client));
    }
    BsdSpyService::~BsdSpyService() {
        tcpstream::Global().ClientClose(TcpOwner(m_client_info));
    }

    // Ask the forwarded bsd service about the *game's* descriptor, not this sysmodule's socket table.
    // For implicit UDP binding, reserve a real ephemeral port so getsockname() and the relay agree.
    Result BsdSpyService::EnsureUdpPort(s32 fd, u16 *port, s32 *err, bool bind_if_needed) {
        *port = 0;
        *err = 0;
        Result ipc_result = 0, ipc_failure = 0;
        const auto resolved = ResolveUdpPort(bind_if_needed, [&]() -> PortResult {
            sockaddr_in addr{};
            struct { s32 ret; s32 err; u32 addrlen; } out{};
            ipc_result = serviceDispatchInOut(m_forward_service.get(), 16, fd, out,
                .buffer_attrs = { SfBufferAttr_HipcAutoSelect | SfBufferAttr_Out },
                .buffers = { { std::addressof(addr), sizeof(addr) } });
            if (R_FAILED(ipc_result)) { ipc_failure = ipc_result; return {0, ErrnoIo}; }
            if (out.ret < 0) return {0, out.err};
            if (out.addrlen < sizeof(addr) || addr.sin_family != AF_INET) return {0, ErrnoFamily};
            return {ntohs(addr.sin_port), 0};
        }, [&]() {
            sockaddr_in any{};
            any.sin_len = sizeof(any);
            any.sin_family = AF_INET;
            Out bound{};
            ipc_result = serviceDispatchInOut(m_forward_service.get(), 13, fd, bound,
                .buffer_attrs = { SfBufferAttr_HipcAutoSelect | SfBufferAttr_In },
                .buffers = { { std::addressof(any), sizeof(any) } });
            if (R_FAILED(ipc_result)) { ipc_failure = ipc_result; return ErrnoIo; }
            return bound.ret < 0 ? bound.err : 0;
        }, ErrnoAddr);
        R_TRY(ipc_failure);
        *port = resolved.port;
        *err = resolved.error;
        if (*port) {
            std::scoped_lock lk(g_lock);
            if (auto *s = Find(fd, m_client_info.program_id.value, false)) s->bound_port = *port;
            else { *port = 0; *err = ErrnoBuffers; }
        }
        R_SUCCEED();
    }

    Result BsdSpyService::Poll(sf::Out<s32> out_ret, sf::Out<s32> out_errno, u32 nfds, s32 timeout, const sf::InAutoSelectBuffer &fds_in,
                               const sf::OutAutoSelectBuffer &fds_out) {
        // Los paquetes de la sala no pasan por el socket real, así que el poll de la consola no despierta con ellos:
        // si el juego espera datos en un socket de la sala, se espera a trozos cortos mirando también la cola.
        if(nfds>MaxPollFds||fds_in.GetSize()/sizeof(PollFd)<nfds||fds_out.GetSize()/sizeof(PollFd)<nfds){out_ret.SetValue(-1);out_errno.SetValue(22);R_SUCCEED();}
        const size_t n = nfds;
        const PollFd *in_fds = reinterpret_cast<const PollFd *>(fds_in.GetPointer());
        const auto owner=TcpOwner(m_client_info);
        u16 ports[MaxPollFds] = {};
        bool room = false;
        for(size_t i=0;i<n;i++)room=room||tcpstream::NeedsPollSlices(tcpstream::Global(),owner,in_fds[i].fd);
        if (lanywhere::InRoom()) {
            std::scoped_lock lk(g_lock);
            for (size_t i = 0; i < n; i++) {
                if (!(in_fds[i].events & (PollIn | PollRdNorm))) continue;
                if (auto *s = Find(in_fds[i].fd, m_client_info.program_id.value, false); s != nullptr && s->type==2 && s->bound_port) {
                    ports[i] = s->bound_port;
                    room = true;
                }
            }
        }

        const os::Tick start = os::GetSystemTick();
        Out out = {};
        for (;;) {
            s32 slice = timeout;
            if (room && timeout != 0) {
                const s64 elapsed = (os::GetSystemTick() - start).ToTimeSpan().GetMilliSeconds();
                slice = timeout < 0 ? PollSliceMs : static_cast<s32>(std::clamp<s64>(timeout - elapsed, 0, PollSliceMs));
            }
            PollFd request[MaxPollFds]{};
            for(size_t i=0;i<n;i++) {
                request[i]=in_fds[i];request[i].revents=0;
                if(tcpstream::Global().GetStatus(owner,request[i].fd).state==tcpstream::State::Pending)
                    request[i].events&=~(0x004|0x100|0x001|0x040);
            }
            const struct { u32 nfds; s32 timeout; } in = { nfds, slice };
            R_TRY(serviceDispatchInOut(m_forward_service.get(), 6, in, out,
                .buffer_attrs = { SfBufferAttr_HipcAutoSelect | SfBufferAttr_In, SfBufferAttr_HipcAutoSelect | SfBufferAttr_Out },
                .buffers = { { request, n*sizeof(PollFd) }, { fds_out.GetPointer(), n*sizeof(PollFd) } },
            ));
            if (!room || out.ret < 0) break;
            PollFd *out_fds = reinterpret_cast<PollFd *>(fds_out.GetPointer());
            s32 ready = 0;
            for (size_t i = 0; i < n; i++) {
                out_fds[i].revents=tcpstream::FilterPoll(tcpstream::Global(),owner,in_fds[i].fd,in_fds[i].events,out_fds[i].revents);
                if (ports[i] && lanywhere::HasData(ports[i])) {
                    out_fds[i].revents |= in_fds[i].events & (PollIn | PollRdNorm);
                }
                if (out_fds[i].revents) ready++;
            }
            out.ret = ready;
            if (ready > 0 || timeout == 0 || (timeout > 0 && (os::GetSystemTick() - start).ToTimeSpan().GetMilliSeconds() >= timeout)) break;
            os::SleepThread(TimeSpan::FromMilliSeconds(1));
        }
        out_ret.SetValue(out.ret);
        out_errno.SetValue(out.err);

        std::scoped_lock lk(g_lock);
        g_recv.poll_calls++;
        if (out.ret > 0) {
            g_recv.poll_ready++;
        }
        MaybeSummary();
        R_SUCCEED();
    }

    Result BsdSpyService::Select(sf::Out<s32> ret,sf::Out<s32> error,tcpstream::NativeSelectData input,
        const sf::InAutoSelectBuffer &read_in,const sf::InAutoSelectBuffer &write_in,const sf::InAutoSelectBuffer &except_in,
        const sf::OutAutoSelectBuffer &read_out,const sf::OutAutoSelectBuffer &write_out,const sf::OutAutoSelectBuffer &except_out) {
        constexpr size_t SetBytes=128; // Horizon fd_set: at most 1024 descriptors.
        if(input.nfds<0||input.nfds>1024||input.null_timeout>1||
            (!input.null_timeout&&(input.seconds<0||input.seconds>86400||input.microseconds<0||input.microseconds>=1000000))){ret.SetValue(-1);error.SetValue(22);R_SUCCEED();}
        // These bytes represent C ABI padding in libnx's timeval structure;
        // unlike our stream protocol reserved bytes, they are not required zero.
        const sf::InAutoSelectBuffer *ins[3]={&read_in,&write_in,&except_in};
        const sf::OutAutoSelectBuffer *outs[3]={&read_out,&write_out,&except_out};
        u8 original[3][SetBytes]{},request[3][SetBytes]{};size_t sizes[3]{};
        const size_t needed=(static_cast<size_t>(input.nfds)+7)/8;
        for(size_t set=0;set<3;set++){
            sizes[set]=ins[set]->GetSize();
            if(sizes[set]>SetBytes||(sizes[set]&&(sizes[set]<needed||outs[set]->GetSize()<sizes[set]))){ret.SetValue(-1);error.SetValue(22);R_SUCCEED();}
            if(sizes[set])std::memcpy(original[set],ins[set]->GetPointer(),sizes[set]);
        }
        auto bit=[](const u8 *set,int fd){return (set[fd/8]&(1u<<(fd%8)))!=0;};
        auto put=[](u8 *set,int fd,bool value){if(value)set[fd/8]|=1u<<(fd%8);else set[fd/8]&=~(1u<<(fd%8));};
        const auto owner=TcpOwner(m_client_info);bool sliced=lanywhere::InRoom();
        for(int fd=0;fd<input.nfds;fd++)if((bit(original[0],fd)||bit(original[1],fd)||bit(original[2],fd))&&tcpstream::NeedsPollSlices(tcpstream::Global(),owner,fd))sliced=true;
        const s64 duration=input.null_timeout?-1:input.seconds*1000000+input.microseconds;
        const auto start=os::GetSystemTick();tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);
        for(;;){
            std::memcpy(request,original,sizeof(request));auto current=input;
            const s64 elapsed=(os::GetSystemTick()-start).ToTimeSpan().GetMicroSeconds();
            if(sliced){const s64 slice=duration<0?5000:std::clamp<s64>(duration-elapsed,0,5000);current.null_timeout=0;current.seconds=0;current.microseconds=slice;}
            for(int fd=0;fd<input.nfds;fd++)if(tcpstream::Global().GetStatus(owner,fd).state==tcpstream::State::Pending)
                for(auto &set:request)put(set,fd,false);
            tcpstream::IpcBuffer buffers[6]{};
            for(size_t set=0;set<3;set++){buffers[set]={request[set],sizes[set],false};buffers[set+3]={outs[set]->GetPointer(),sizes[set],true};}
            auto result=forward.Call(5,&current,sizeof(current),buffers,6);R_TRY(result.ipc);
            if(result.ret<0){ret.SetValue(result.ret);error.SetValue(result.error);R_SUCCEED();}
            int ready=0;
            for(int fd=0;fd<input.nfds;fd++){
                const auto status=tcpstream::Global().GetStatus(owner,fd);
                bool udp_ready=false;
                if(sizes[0]&&bit(original[0],fd)&&lanywhere::InRoom()){
                    u16 port=0;{std::scoped_lock lock(g_lock);auto *s=Find(fd,m_client_info.program_id.value,false);if(s&&s->type==2)port=s->bound_port;}
                    udp_ready=port&&lanywhere::HasData(port);
                }
                for(size_t set=0;set<3;set++)if(sizes[set]){
                    auto *data=static_cast<u8*>(outs[set]->GetPointer());
                    if(status.state==tcpstream::State::Pending)put(data,fd,false);
                    else if(status.state==tcpstream::State::Failed&&set<2&&bit(original[set],fd))put(data,fd,true);
                    else if(set==0&&bit(original[0],fd)&&(udp_ready||tcpstream::Global().PendingAccept(owner,fd)))put(data,fd,true);
                    if(bit(data,fd))ready++;
                }
            }
            if(!sliced||ready||duration==0||(duration>0&&(os::GetSystemTick()-start).ToTimeSpan().GetMicroSeconds()>=duration)){
                ret.SetValue(sliced?ready:result.ret);error.SetValue(0);R_SUCCEED();
            }
            os::SleepThread(TimeSpan::FromMilliSeconds(1));
        }
    }

    Result BsdSpyService::Recv(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, s32 flags, const sf::OutAutoSelectBuffer &data) {
        tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);
        const auto gate=tcpstream::GateGameIo(tcpstream::Global(),TcpOwner(m_client_info),forward,fd,flags,false);
        if(gate.handled){R_TRY(gate.result.ipc);out_ret.SetValue(gate.result.ret);out_errno.SetValue(gate.result.error);R_SUCCEED();}
        bool handled = false; s32 ret = 0, err = 0; u32 len = 0;
        R_TRY(ReceiveVirtual(fd, flags, data, nullptr, &handled, &ret, &err, &len));
        if (handled) {
            out_ret.SetValue(ret);
            out_errno.SetValue(err);
            R_SUCCEED();
        }

        const struct { s32 fd, flags; } in = { fd, flags };
        Out out = {};
        R_TRY(serviceDispatchInOut(m_forward_service.get(), 8, in, out,
            .buffer_attrs = { SfBufferAttr_HipcAutoSelect | SfBufferAttr_Out },
            .buffers = { { data.GetPointer(), data.GetSize() } },
        ));
        out_ret.SetValue(out.ret);
        out_errno.SetValue(out.err);

        std::scoped_lock lk(g_lock);
        g_recv.recv_calls++;
        if (out.ret > 0) {
            g_recv.recv_data++;
            g_recv.bytes += out.ret;
        } else if (out.err == ErrnoAgain) {
            g_recv.recv_eagain++;
        }
        MaybeSummary();
        R_SUCCEED();
    }

    namespace {

        // Paquete de la sala para el puerto del socket, si lo hay: tamaño entregado o -1.
        ssize_t TakeRoomPacket(s32 fd, u64 program_id, void *buffer, size_t size, sockaddr_in *from, s32 flags) {
            if (!lanywhere::InRoom()) {
                return -1;
            }
            u16 port = 0;
            {
                std::scoped_lock lk(g_lock);
                if (auto *s = Find(fd, program_id, false)) {
                    port = s->bound_port;
                }
            }
            if (port == 0) {
                return -1;
            }
            u32 src_ip;
            u16 src_port;
            const ssize_t n = lanywhere::ReceiveData(port, buffer, size, std::addressof(src_ip), std::addressof(src_port), (flags & BsdPeek) != 0);
            if (n >= 0 && from != nullptr) {
                std::memset(from, 0, sizeof(*from));
                from->sin_len = sizeof(*from);
                from->sin_family = AF_INET;
                from->sin_port = htons(src_port);
                from->sin_addr.s_addr = htonl(src_ip);
            }
            return n;
        }

    }

    Result BsdSpyService::RecvFrom(sf::Out<s32> out_ret, sf::Out<s32> out_errno, sf::Out<u32> out_addrlen, s32 fd, s32 flags,
                                   const sf::OutAutoSelectBuffer &data, const sf::OutAutoSelectBuffer &addr) {
        const auto owner=TcpOwner(m_client_info);tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);
        const auto gate=tcpstream::GateGameIo(tcpstream::Global(),owner,forward,fd,flags,false);
        if(gate.handled){R_TRY(gate.result.ipc);out_ret.SetValue(gate.result.ret);out_errno.SetValue(gate.result.error);out_addrlen.SetValue(0);R_SUCCEED();}
        bool handled = false; s32 ret = 0, err = 0; u32 len = 0;
        R_TRY(ReceiveVirtual(fd, flags, data, &addr, &handled, &ret, &err, &len));
        if (handled) {
            out_ret.SetValue(ret);
            out_errno.SetValue(err);
            out_addrlen.SetValue(len);
            std::scoped_lock lk(g_lock);
            g_recv.recvfrom_calls++;
            if (ret >= 0) { g_recv.recvfrom_data++; g_recv.bytes += ret; }
            R_SUCCEED();
        }

        const struct { s32 fd, flags; } in = { fd, flags };
        struct { s32 ret; s32 err; u32 addrlen; } out = {};
        R_TRY(serviceDispatchInOut(m_forward_service.get(), 9, in, out,
            .buffer_attrs = { SfBufferAttr_HipcAutoSelect | SfBufferAttr_Out, SfBufferAttr_HipcAutoSelect | SfBufferAttr_Out },
            .buffers = { { data.GetPointer(), data.GetSize() }, { addr.GetPointer(), addr.GetSize() } },
        ));
        out_ret.SetValue(out.ret);
        out_errno.SetValue(out.err);
        out_addrlen.SetValue(out.addrlen);
        tcpstream::Endpoint tcp_peer{};
        if(out.ret>=0&&out.addrlen&&tcpstream::Global().Addresses(owner,fd,nullptr,&tcp_peer)){TcpAddress(addr,tcp_peer);out_addrlen.SetValue(16);}

        std::scoped_lock lk(g_lock);
        g_recv.recvfrom_calls++;
        if (out.ret > 0) {
            g_recv.recvfrom_data++;
            g_recv.bytes += out.ret;
        } else if (out.err == ErrnoAgain) {
            g_recv.recvfrom_eagain++;
        }
        MaybeSummary();
        R_SUCCEED();
    }

    Result BsdSpyService::ReceiveVirtual(s32 fd, s32 flags, const sf::OutAutoSelectBuffer &data,
                                        const sf::OutAutoSelectBuffer *addr, bool *handled, s32 *ret, s32 *err, u32 *addrlen) {
        *handled = false;
        if(tcpstream::Global().IsStreamSocket(TcpOwner(m_client_info),fd))R_SUCCEED();
        if (!lanywhere::InRoom()) R_SUCCEED();
        {
            std::scoped_lock lk(g_lock);
            auto *s = Find(fd, m_client_info.program_id.value, false);
            if (!s || s->type != 2 || !s->bound_port) R_SUCCEED();
        }
        *handled = true;
        const struct { s32 fd, cmd, arg; } fcntl_in = {fd, BsdGetFl, 0};
        Out fcntl_out{};
        R_TRY(serviceDispatchInOut(m_forward_service.get(), 20, fcntl_in, fcntl_out));
        if (fcntl_out.ret < 0) { *ret = -1; *err = fcntl_out.err; R_SUCCEED(); }
        const bool nonblocking = NativeWouldNotBlock(fcntl_out.ret, flags);
        timeval timeout{};
        const struct { s32 fd, level, option; } opt_in = {fd, static_cast<s32>(socket::Level::Sol_Socket), static_cast<s32>(socket::Option::So_RcvTimeo)};
        struct { s32 ret, err; u32 len; } opt_out{};
        R_TRY(serviceDispatchInOut(m_forward_service.get(), 17, opt_in, opt_out,
            .buffer_attrs = { SfBufferAttr_HipcAutoSelect | SfBufferAttr_Out },
            .buffers = { { std::addressof(timeout), sizeof(timeout) } }));
        if (opt_out.ret < 0) { *ret = -1; *err = opt_out.err; R_SUCCEED(); }
        const s64 timeout_ms = static_cast<s64>(timeout.tv_sec) * 1000 + (timeout.tv_usec + 999) / 1000;
        Result ipc_result = 0;
        ReceiveResult result{};
        *handled = WaitVirtualReceive(nonblocking, timeout_ms, ErrnoAgain,
            [] { return os::GetSystemTick().ToTimeSpan().GetMilliSeconds(); },
            [] { return lanywhere::InRoom(); },
            [&](ReceiveResult *out) {
                sockaddr_in from{};
                const ssize_t room = TakeRoomPacket(fd, m_client_info.program_id.value, data.GetPointer(), data.GetSize(), addr ? &from : nullptr, flags);
                if (room < 0) return false;
                u32 length = 0;
                if (addr) {
                    const size_t count = std::min(addr->GetSize(), sizeof(from));
                    if (count) std::memcpy(addr->GetPointer(), &from, count);
                    length = static_cast<u32>(count);
                }
                *out = {static_cast<s32>(room), 0, length}; return true;
            },
            [&]() -> ReceiveResult {
                const struct { s32 fd, flags; } in = {fd, flags | BsdDontWait};
                struct { s32 ret, err; u32 addrlen; } recv{};
                if (addr) {
                    ipc_result = serviceDispatchInOut(m_forward_service.get(), 9, in, recv,
                        .buffer_attrs = { SfBufferAttr_HipcAutoSelect | SfBufferAttr_Out, SfBufferAttr_HipcAutoSelect | SfBufferAttr_Out },
                        .buffers = { { data.GetPointer(), data.GetSize() }, { addr->GetPointer(), addr->GetSize() } });
                } else {
                    Out native{};
                    ipc_result = serviceDispatchInOut(m_forward_service.get(), 8, in, native,
                        .buffer_attrs = { SfBufferAttr_HipcAutoSelect | SfBufferAttr_Out },
                        .buffers = { { data.GetPointer(), data.GetSize() } });
                    recv.ret = native.ret; recv.err = native.err;
                }
                return R_FAILED(ipc_result) ? ReceiveResult{-1, ErrnoIo, 0} : ReceiveResult{recv.ret, recv.err, recv.addrlen};
            },
            [&](int slice) {
                PollFd poll_in{fd, PollIn, 0}, poll_out{};
                const struct { u32 nfds; s32 timeout; } args = {1, slice};
                Out polled{};
                ipc_result = serviceDispatchInOut(m_forward_service.get(), 6, args, polled,
                    .buffer_attrs = { SfBufferAttr_HipcAutoSelect | SfBufferAttr_In, SfBufferAttr_HipcAutoSelect | SfBufferAttr_Out },
                    .buffers = { { &poll_in, sizeof(poll_in) }, { &poll_out, sizeof(poll_out) } });
                return R_FAILED(ipc_result) ? ErrnoIo : (polled.ret < 0 ? polled.err : 0);
            }, &result);
        R_TRY(ipc_result);
        *ret = result.ret; *err = result.error; *addrlen = result.addrlen;
        R_SUCCEED();
    }

    Result BsdSpyService::Fcntl(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, s32 cmd, s32 arg) {
        const struct { s32 fd, cmd, arg; } in = { fd, cmd, arg };
        Out out = {};
        R_TRY(serviceDispatchInOut(m_forward_service.get(), 20, in, out));
        const auto owner=TcpOwner(m_client_info);
        if(cmd==0&&out.ret>=0&&tcpstream::Global().IsStreamSocket(owner,fd)&&!tcpstream::Global().Duplicated(owner,fd,out.ret)){
            tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);forward.Close(out.ret);out.ret=-1;out.err=105;
        }
        out_ret.SetValue(out.ret);
        out_errno.SetValue(out.err);

        std::scoped_lock lk(g_lock);
        WriteLine("[%016lx] fcntl(fd %d, cmd %d, arg 0x%x) = %d (errno %d)", m_client_info.program_id.value, fd, cmd, arg, out.ret, out.err);
        R_SUCCEED();
    }

    Result BsdSpyService::SetSockOpt(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, s32 level, s32 optname, const sf::InAutoSelectBuffer &optval) {
        const auto owner=TcpOwner(m_client_info);
        if(level==0xffff&&optname==0x10000&&tcpstream::Global().GetStatus(owner,fd).state!=tcpstream::State::Unmanaged){
            out_ret.SetValue(-1);out_errno.SetValue(95);R_SUCCEED();
        }
        const struct { s32 fd, level, optname; } in = { fd, level, optname };
        Out out = {};
        R_TRY(serviceDispatchInOut(m_forward_service.get(), 21, in, out,
            .buffer_attrs = { SfBufferAttr_HipcAutoSelect | SfBufferAttr_In },
            .buffers = { { optval.GetPointer(), optval.GetSize() } },
        ));
        out_ret.SetValue(out.ret);
        out_errno.SetValue(out.err);
        if(out.ret==0&&level==0xffff&&optname==0x10000&&optval.GetSize()>=sizeof(s32)){
            s32 exempt=0;std::memcpy(&exempt,optval.GetPointer(),sizeof(exempt));tcpstream::Global().ShutdownExempt(owner,fd,exempt!=0);
        }

        s32 value = 0;
        if (optval.GetSize() >= sizeof(s32)) {
            std::memcpy(std::addressof(value), optval.GetPointer(), sizeof(s32));
        }
        std::scoped_lock lk(g_lock);
        WriteLine("[%016lx] setsockopt(fd %d, nivel 0x%x, opción 0x%x, valor %d, %zu bytes) = %d (errno %d)", m_client_info.program_id.value, fd, level,
                  optname, value, optval.GetSize(), out.ret, out.err);
        R_SUCCEED();
    }

    Result BsdSpyService::Socket(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 domain, s32 type, s32 protocol) {
        const struct { s32 domain, type, protocol; } in = { domain, type, protocol };
        Out out = {};
        R_TRY(serviceDispatchInOut(m_forward_service.get(), 2, in, out));
        out_ret.SetValue(out.ret);
        out_errno.SetValue(out.err);

        if(out.ret>=0&&domain==AF_INET&&(type&0xff)==SOCK_STREAM)
            tcpstream::Global().SocketCreated(TcpOwner(m_client_info),out.ret,type);

        std::scoped_lock lk(g_lock);
        WriteLine("[%016lx] socket(dom %d, tipo %d, proto %d) = %d (errno %d)", m_client_info.program_id.value, domain, type, protocol, out.ret, out.err);
        if (out.ret >= 0) {
            if (auto *s = Find(out.ret, m_client_info.program_id.value, true)) {
                s->type = type & 0xFF;
                s->protocol = protocol;
            } else {
                g_overflow++;
            }
        }
        R_SUCCEED();
    }

    Result BsdSpyService::Send(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, s32 flags, const sf::InAutoSelectBuffer &data) {
        tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);
        const auto gate=tcpstream::GateGameIo(tcpstream::Global(),TcpOwner(m_client_info),forward,fd,flags,true);
        if(gate.handled){R_TRY(gate.result.ipc);out_ret.SetValue(gate.result.ret);out_errno.SetValue(gate.result.error);R_SUCCEED();}
        if (lanywhere::InRoom()&&!tcpstream::Global().IsStreamSocket(TcpOwner(m_client_info),fd)) {
            u32 peer_ip = 0;
            u16 peer_port = 0, src_port = 0;
            {
                std::scoped_lock lk(g_lock);
                if (auto *s = Find(fd, m_client_info.program_id.value, false); s != nullptr && s->peer_ip) {
                    peer_ip = s->peer_ip;
                    peer_port = s->peer_port;
                    src_port = s->bound_port;
                    s->sent_packets++;
                    s->sent_bytes += data.GetSize();
                }
            }
            if (peer_ip) {
                const bool sent = lanywhere::SendData(peer_ip, src_port, peer_port, data.GetPointer(), data.GetSize());
                const int send_error = sent ? 0 : NativeSendError(errno == EMSGSIZE);
                out_ret.SetValue(sent ? static_cast<s32>(data.GetSize()) : -1);
                out_errno.SetValue(send_error);
                R_SUCCEED();
            }
        }
        const struct { s32 fd, flags; } in = { fd, flags };
        Out out = {};
        R_TRY(serviceDispatchInOut(m_forward_service.get(), 10, in, out,
            .buffer_attrs = { SfBufferAttr_HipcAutoSelect | SfBufferAttr_In },
            .buffers = { { data.GetPointer(), data.GetSize() } },
        ));
        out_ret.SetValue(out.ret);
        out_errno.SetValue(out.err);

        std::scoped_lock lk(g_lock);
        WriteLine("[%016lx] send(fd %d, %zu bytes) = %d (errno %d)", m_client_info.program_id.value, fd, data.GetSize(), out.ret, out.err);
        MaybeSummary();
        R_SUCCEED();
    }

    Result BsdSpyService::SendTo(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, s32 flags, const sf::InAutoSelectBuffer &data,
                                 const sf::InAutoSelectBuffer &addr) {
        const auto owner=TcpOwner(m_client_info);tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);
        const auto gate=tcpstream::GateGameIo(tcpstream::Global(),owner,forward,fd,flags,true);
        if(gate.handled){R_TRY(gate.result.ipc);out_ret.SetValue(gate.result.ret);out_errno.SetValue(gate.result.error);R_SUCCEED();}
        tcpstream::Endpoint tcp_peer{},destination{};
        if(tcpstream::Global().Addresses(owner,fd,nullptr,&tcp_peer)){
            if(addr.GetSize()&&(!tcpstream::ReadAddress(addr.GetPointer(),addr.GetSize(),&destination)||destination.ip!=tcp_peer.ip||destination.port!=tcp_peer.port)){
                out_ret.SetValue(-1);out_errno.SetValue(106);R_SUCCEED();
            }
            const s32 input[2]={fd,flags};const tcpstream::IpcBuffer b{const_cast<u8*>(data.GetPointer()),data.GetSize(),false};const auto r=forward.Call(10,input,sizeof(input),&b,1);R_TRY(r.ipc);out_ret.SetValue(r.ret);out_errno.SetValue(r.error);R_SUCCEED();
        }
        if(tcpstream::Global().IsStreamSocket(owner,fd)&&tcpstream::ReadAddress(addr.GetPointer(),addr.GetSize(),&destination)&&lanywhere::InRoom()&&lanywhere::IsVirtual(destination.ip)){
            out_ret.SetValue(-1);out_errno.SetValue(107);R_SUCCEED();
        }
        // En una sala, lo que va a la red virtual (otro miembro o broadcast) sale por el servidor.
        if (lanywhere::InRoom() && addr.GetSize() >= sizeof(sockaddr_in)) {
            const sockaddr_in *a = reinterpret_cast<const sockaddr_in *>(addr.GetPointer());
            const u32 dst = ntohl(a->sin_addr.s_addr);
            if (lanywhere::IsVirtual(dst)) {
                u16 src_port = 0;
                s32 port_err = 0;
                bool udp = false;
                {
                    std::scoped_lock lk(g_lock);
                    if (auto *s = Find(fd, m_client_info.program_id.value, false); s != nullptr && s->type == 2) {
                        udp = true;
                        src_port = s->bound_port;
                        s->sent_packets++;
                        s->sent_bytes += data.GetSize();
                    }
                }
                if (udp) {
                    if (!src_port) R_TRY(EnsureUdpPort(fd, &src_port, &port_err, true));
                    if (!src_port) { out_ret.SetValue(-1); out_errno.SetValue(port_err ? port_err : ErrnoAddr); R_SUCCEED(); }
                    const bool sent = lanywhere::SendData(dst, src_port, ntohs(a->sin_port), data.GetPointer(), data.GetSize());
                    const int send_error = sent ? 0 : NativeSendError(errno == EMSGSIZE);
                    out_ret.SetValue(sent ? static_cast<s32>(data.GetSize()) : -1);
                    out_errno.SetValue(send_error);
                    R_SUCCEED();
                }
            }
        }

        const struct { s32 fd, flags; } in = { fd, flags };
        Out out = {};
        R_TRY(serviceDispatchInOut(m_forward_service.get(), 11, in, out,
            .buffer_attrs = { SfBufferAttr_HipcAutoSelect | SfBufferAttr_In, SfBufferAttr_HipcAutoSelect | SfBufferAttr_In },
            .buffers = { { data.GetPointer(), data.GetSize() }, { addr.GetPointer(), addr.GetSize() } },
        ));
        out_ret.SetValue(out.ret);
        out_errno.SetValue(out.err);

        std::scoped_lock lk(g_lock);
        if (auto *s = Find(fd, m_client_info.program_id.value, true)) {
            s->sent_packets++;
            s->sent_bytes += data.GetSize();
            if (addr.GetSize() >= sizeof(sockaddr_in)) {
                const sockaddr_in *a = reinterpret_cast<const sockaddr_in *>(addr.GetPointer());
                const u32 ip = ntohl(a->sin_addr.s_addr);
                const u16 port = ntohs(a->sin_port);
                size_t i = 0;
                while (i < s->dest_count && !(s->dest[i].ip == ip && s->dest[i].port == port)) {
                    i++;
                }
                if (i == s->dest_count && s->dest_count < MaxDestinations) {
                    s->dest[s->dest_count++] = { ip, port, 0, 0 };
                }
                if (i < s->dest_count) {
                    s->dest[i].packets++;
                    s->dest[i].bytes += data.GetSize();
                }
            }
        }
        MaybeSummary();
        R_SUCCEED();
    }

    Result BsdSpyService::Bind(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, const sf::InAutoSelectBuffer &addr) {
        // En una sala la IP del juego es virtual: no existe en la consola, así que se escucha en todas.
        sockaddr_in local = {};
        const void *bind_addr = addr.GetPointer();
        size_t bind_size = addr.GetSize();
        if (lanywhere::InRoom() && bind_size >= sizeof(sockaddr_in)) {
            std::memcpy(std::addressof(local), bind_addr, sizeof(local));
            if (lanywhere::IsVirtual(ntohl(local.sin_addr.s_addr))) {
                local.sin_addr.s_addr = 0;
                bind_addr = std::addressof(local);
                bind_size = sizeof(local);
            }
        }
        Out out = {};
        R_TRY(serviceDispatchInOut(m_forward_service.get(), 13, fd, out,
            .buffer_attrs = { SfBufferAttr_HipcAutoSelect | SfBufferAttr_In },
            .buffers = { { bind_addr, bind_size } },
        ));
        out_ret.SetValue(out.ret);
        out_errno.SetValue(out.err);

        const auto owner=TcpOwner(m_client_info);
        if(out.ret==0&&tcpstream::Global().IsStreamSocket(owner,fd)) {
            tcpstream::Endpoint endpoint{};
            if(tcpstream::ReadAddress(addr.GetPointer(),addr.GetSize(),&endpoint)) {
                if(!endpoint.port){tcpstream::Forward f(m_forward_service.get(),TcpDispatch);tcpstream::Endpoint actual{};const auto named=f.Name(fd,&actual);if(!named.ipc&&named.ret==0)endpoint.port=actual.port;}
                tcpstream::Global().Bound(owner,fd,endpoint);
            }
        }

        if (out.ret == 0 && addr.GetSize() >= sizeof(sockaddr_in) &&
            ntohs(reinterpret_cast<const sockaddr_in *>(addr.GetPointer())->sin_port) == 0) {
            u16 actual = 0; s32 err = 0;
            R_TRY(EnsureUdpPort(fd, &actual, &err, false));
        }
        char a[48];
        std::scoped_lock lk(g_lock);
        WriteLine("[%016lx] bind(fd %d, %s) = %d (errno %d)", m_client_info.program_id.value, fd, FormatAddr(a, sizeof(a), addr.GetPointer(), addr.GetSize()), out.ret, out.err);
        if (out.ret == 0 && addr.GetSize() >= sizeof(sockaddr_in)) {
            if (auto *s = Find(fd, m_client_info.program_id.value, true)) {
                const u16 requested = ntohs(reinterpret_cast<const sockaddr_in *>(addr.GetPointer())->sin_port);
                if (requested) s->bound_port = requested;
            }
        }
        R_SUCCEED();
    }

    Result BsdSpyService::Connect(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, const sf::InAutoSelectBuffer &addr) {
        if(addr.GetSize()>=28) {
            const auto *a=static_cast<const u8*>(addr.GetPointer());
            const u8 zero[10]{};
            if(a[1]==28&&!std::memcmp(a+8,zero,sizeof(zero))&&a[18]==0xff&&a[19]==0xff) {
                const u32 mapped=static_cast<u32>(a[20])<<24|static_cast<u32>(a[21])<<16|static_cast<u32>(a[22])<<8|a[23];
                if((lanywhere::InRoom()&&lanywhere::IsVirtual(mapped))||tcpstream::Global().IsVirtualDestination(TcpOwner(m_client_info),mapped)){
                    out_ret.SetValue(-1);out_errno.SetValue(97);R_SUCCEED();
                }
            }
        }
        tcpstream::Endpoint destination{};
        if(tcpstream::ReadAddress(addr.GetPointer(),addr.GetSize(),&destination)) {
            const auto owner=TcpOwner(m_client_info);
            const bool scoped=(lanywhere::InRoom()&&lanywhere::IsVirtual(destination.ip))||
                              tcpstream::Global().IsVirtualDestination(owner,destination.ip);
            tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);
            const auto result=tcpstream::ConnectGame(tcpstream::Global(),owner,forward,fd,destination,scoped);
            if(result.handled){R_TRY(result.result.ipc);if(result.result.error==95)lanywhere::ReportTcpUnavailable();out_ret.SetValue(result.result.ret);out_errno.SetValue(result.result.error);R_SUCCEED();}
        }
        // UDP "conectado" a otro miembro de la sala: no hay ruta real; send() lo manda por el servidor.
        if (lanywhere::InRoom() && addr.GetSize() >= sizeof(sockaddr_in)) {
            const sockaddr_in *a = reinterpret_cast<const sockaddr_in *>(addr.GetPointer());
            const u32 dst = ntohl(a->sin_addr.s_addr);
            bool udp = false;
            u16 port = 0;
            {
                std::scoped_lock lk(g_lock);
                if (auto *s = Find(fd, m_client_info.program_id.value, false); s != nullptr && s->type == 2) {
                    udp = true;
                    port = s->bound_port;
                }
            }
            if (udp && lanywhere::IsVirtual(dst) && !port) {
                s32 err = 0;
                R_TRY(EnsureUdpPort(fd, &port, &err, true));
                if (!port) { out_ret.SetValue(-1); out_errno.SetValue(err ? err : ErrnoAddr); R_SUCCEED(); }
            }
            std::scoped_lock lk(g_lock);
            auto *s = Find(fd, m_client_info.program_id.value, false);
            if (s != nullptr && s->type == 2 && lanywhere::IsVirtual(dst)) {
                s->peer_ip = dst;
                s->peer_port = ntohs(a->sin_port);
                char text[48];
                WriteLine("[%016lx] connect(fd %d, %s) a la sala (puerto local %u)", m_client_info.program_id.value, fd,
                          FormatAddr(text, sizeof(text), addr.GetPointer(), addr.GetSize()), s->bound_port);
                out_ret.SetValue(0);
                out_errno.SetValue(0);
                R_SUCCEED();
            }
        }
        Out out = {};
        R_TRY(serviceDispatchInOut(m_forward_service.get(), 14, fd, out,
            .buffer_attrs = { SfBufferAttr_HipcAutoSelect | SfBufferAttr_In },
            .buffers = { { addr.GetPointer(), addr.GetSize() } },
        ));
        out_ret.SetValue(out.ret);
        out_errno.SetValue(out.err);

        char a[48];
        std::scoped_lock lk(g_lock);
        WriteLine("[%016lx] connect(fd %d, %s) = %d (errno %d)", m_client_info.program_id.value, fd, FormatAddr(a, sizeof(a), addr.GetPointer(), addr.GetSize()), out.ret, out.err);
        R_SUCCEED();
    }

    Result BsdSpyService::Listen(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, s32 backlog) {
        const struct { s32 fd, backlog; } in = { fd, backlog };
        Out out = {};
        R_TRY(serviceDispatchInOut(m_forward_service.get(), 18, in, out));
        out_ret.SetValue(out.ret);
        out_errno.SetValue(out.err);

        if(out.ret==0) {
            const auto owner=TcpOwner(m_client_info);
            if(tcpstream::Global().IsStreamSocket(owner,fd)) {
                tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);tcpstream::Endpoint address{};
                const auto named=forward.Name(fd,&address);
                // Keep an explicit logical bind address already recorded; only
                // an implicitly bound listener needs this kernel-assigned port.
                if(!named.ipc&&named.ret==0)tcpstream::Global().AssignedPort(owner,fd,address.port);
                tcpstream::Global().Listening(owner,fd,backlog);
            }
        }

        std::scoped_lock lk(g_lock);
        WriteLine("[%016lx] listen(fd %d, %d) = %d (errno %d)", m_client_info.program_id.value, fd, backlog, out.ret, out.err);
        R_SUCCEED();
    }

    Result BsdSpyService::Close(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd) {
        Out out = {};
        R_TRY(serviceDispatchInOut(m_forward_service.get(), 26, fd, out));
        out_ret.SetValue(out.ret);
        out_errno.SetValue(out.err);

        if(out.ret==0||out.err==9)tcpstream::Global().Closed(TcpOwner(m_client_info),fd);

        std::scoped_lock lk(g_lock);
        if (auto *s = Find(fd, m_client_info.program_id.value, false)) {
            if (s->sent_packets) {
                Summary(*s, "cerrado");
            }
            s->used = false;
        }
        R_SUCCEED();
    }

    Result BsdSpyService::Accept(sf::Out<s32> ret,sf::Out<s32> error,sf::Out<u32> length,s32 fd,const sf::OutAutoSelectBuffer &addr) {
        const auto owner=TcpOwner(m_client_info);tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);
        const auto result=tcpstream::AcceptGame(tcpstream::Global(),owner,forward,fd);
        if(result.handled){R_TRY(result.result.ipc);ret.SetValue(result.result.ret);error.SetValue(result.result.error);length.SetValue(result.result.ret>=0?16:0);if(result.result.ret>=0)TcpAddress(addr,result.peer);R_SUCCEED();}
        const tcpstream::IpcBuffer b{addr.GetPointer(),addr.GetSize(),true};const auto r=forward.Call(12,&fd,sizeof(fd),&b,1,true);R_TRY(r.ipc);
        ret.SetValue(r.ret);error.SetValue(r.error);length.SetValue(r.length);
        if(r.ret>=0)tcpstream::Global().SocketCreated(owner,r.ret,SOCK_STREAM);
        R_SUCCEED();
    }
    Result BsdSpyService::GetPeerName(sf::Out<s32> ret,sf::Out<s32> error,sf::Out<u32> length,s32 fd,const sf::OutAutoSelectBuffer &addr) {
        const auto owner=TcpOwner(m_client_info);const auto status=tcpstream::Global().GetStatus(owner,fd);tcpstream::Endpoint peer{};
        if(status.state!=tcpstream::State::Unmanaged){
            if(status.state!=tcpstream::State::Connected){ret.SetValue(-1);error.SetValue(107);length.SetValue(0);R_SUCCEED();}
            if(tcpstream::Global().Addresses(owner,fd,nullptr,&peer)){TcpAddress(addr,peer);ret.SetValue(0);error.SetValue(0);length.SetValue(16);R_SUCCEED();}
        }
        tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);const tcpstream::IpcBuffer b{addr.GetPointer(),addr.GetSize(),true};const auto r=forward.Call(15,&fd,sizeof(fd),&b,1,true);R_TRY(r.ipc);ret.SetValue(r.ret);error.SetValue(r.error);length.SetValue(r.length);R_SUCCEED();
    }
    Result BsdSpyService::GetSockName(sf::Out<s32> ret,sf::Out<s32> error,sf::Out<u32> length,s32 fd,const sf::OutAutoSelectBuffer &addr) {
        tcpstream::Endpoint local{};
        if(tcpstream::Global().Addresses(TcpOwner(m_client_info),fd,&local,nullptr)){TcpAddress(addr,local);ret.SetValue(0);error.SetValue(0);length.SetValue(16);R_SUCCEED();}
        tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);const tcpstream::IpcBuffer b{addr.GetPointer(),addr.GetSize(),true};const auto r=forward.Call(16,&fd,sizeof(fd),&b,1,true);R_TRY(r.ipc);ret.SetValue(r.ret);error.SetValue(r.error);length.SetValue(r.length);R_SUCCEED();
    }
    Result BsdSpyService::GetSockOpt(sf::Out<s32> ret,sf::Out<s32> error,sf::Out<u32> length,s32 fd,s32 level,s32 option,const sf::OutAutoSelectBuffer &value) {
        const auto owner=TcpOwner(m_client_info);
        if(level==0xffff&&option==0x1007&&tcpstream::Global().GetStatus(owner,fd).state!=tcpstream::State::Unmanaged){
            if(value.GetSize()<sizeof(s32)){ret.SetValue(-1);error.SetValue(22);length.SetValue(0);R_SUCCEED();}
            const s32 pending=tcpstream::Global().TakeSocketError(owner,fd);std::memcpy(value.GetPointer(),&pending,sizeof(pending));ret.SetValue(0);error.SetValue(0);length.SetValue(sizeof(pending));R_SUCCEED();
        }
        const s32 input[3]={fd,level,option};tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);const tcpstream::IpcBuffer b{value.GetPointer(),value.GetSize(),true};const auto r=forward.Call(17,input,sizeof(input),&b,1,true);R_TRY(r.ipc);ret.SetValue(r.ret);error.SetValue(r.error);length.SetValue(r.length);R_SUCCEED();
    }
    Result BsdSpyService::Shutdown(sf::Out<s32> ret,sf::Out<s32> error,s32 fd,s32 how) {
        const s32 input[2]={fd,how};tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);const auto r=forward.Call(22,input,sizeof(input));R_TRY(r.ipc);
        if(r.ret==0){int ignored=0;tcpstream::Global().Shutdown(TcpOwner(m_client_info),fd,how,&ignored);}
        ret.SetValue(r.ret);error.SetValue(r.error);R_SUCCEED();
    }
    Result BsdSpyService::ShutdownAllSockets(sf::Out<s32> ret,sf::Out<s32> error,s32 how) {
        tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);const auto r=forward.Call(23,&how,sizeof(how));R_TRY(r.ipc);
        if(r.ret==0)tcpstream::Global().ShutdownAll(TcpOwner(m_client_info),how);
        ret.SetValue(r.ret);error.SetValue(r.error);R_SUCCEED();
    }
    Result BsdSpyService::DuplicateSocket(sf::Out<s32> ret,sf::Out<s32> error,tcpstream::NativeDuplicateData input) {
        if(input.padding||input.reserved){ret.SetValue(-1);error.SetValue(22);R_SUCCEED();}
        const auto owner=TcpOwner(m_client_info);tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);auto r=forward.Call(27,&input,sizeof(input));R_TRY(r.ipc);
        if(r.ret>=0&&tcpstream::Global().IsStreamSocket(owner,input.fd)&&!tcpstream::Global().Duplicated(owner,input.fd,r.ret)){forward.Close(r.ret);r.ret=-1;r.error=105;}
        ret.SetValue(r.ret);error.SetValue(r.error);R_SUCCEED();
    }
    Result BsdSpyService::Read(sf::Out<s32> ret,sf::Out<s32> error,s32 fd,const sf::OutAutoSelectBuffer &data) {
        tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);const auto gate=tcpstream::GateGameIo(tcpstream::Global(),TcpOwner(m_client_info),forward,fd,0,false);
        if(gate.handled){R_TRY(gate.result.ipc);ret.SetValue(gate.result.ret);error.SetValue(gate.result.error);R_SUCCEED();}
        const tcpstream::IpcBuffer b{data.GetPointer(),data.GetSize(),true};const auto r=forward.Call(25,&fd,sizeof(fd),&b,1);R_TRY(r.ipc);ret.SetValue(r.ret);error.SetValue(r.error);R_SUCCEED();
    }
    Result BsdSpyService::Write(sf::Out<s32> ret,sf::Out<s32> error,s32 fd,const sf::InAutoSelectBuffer &data) {
        tcpstream::Forward forward(m_forward_service.get(),TcpDispatch);const auto gate=tcpstream::GateGameIo(tcpstream::Global(),TcpOwner(m_client_info),forward,fd,0,true);
        if(gate.handled){R_TRY(gate.result.ipc);ret.SetValue(gate.result.ret);error.SetValue(gate.result.error);R_SUCCEED();}
        const tcpstream::IpcBuffer b{const_cast<u8*>(data.GetPointer()),data.GetSize(),false};const auto r=forward.Call(24,&fd,sizeof(fd),&b,1);R_TRY(r.ipc);ret.SetValue(r.ret);error.SetValue(r.error);R_SUCCEED();
    }
    Result BsdSpyService::RecvMMsg(sf::Out<s32> ret,sf::Out<s32> error,tcpstream::NativeRecvMmsgData input,const sf::OutMapAliasBuffer &buffer) {
        if(tcpstream::Global().GetStatus(TcpOwner(m_client_info),input.fd).state!=tcpstream::State::Unmanaged){ret.SetValue(-1);error.SetValue(95);R_SUCCEED();}
        Out out{};R_TRY(serviceDispatchInOut(m_forward_service.get(),29,input,out,.buffer_attrs={SfBufferAttr_HipcMapAlias|SfBufferAttr_Out},.buffers={{buffer.GetPointer(),buffer.GetSize()}}));ret.SetValue(out.ret);error.SetValue(out.err);R_SUCCEED();
    }
    Result BsdSpyService::SendMMsg(sf::Out<s32> ret,sf::Out<s32> error,tcpstream::NativeSendMmsgData input,const sf::OutMapAliasBuffer &buffer) {
        if(tcpstream::Global().GetStatus(TcpOwner(m_client_info),input.fd).state!=tcpstream::State::Unmanaged){ret.SetValue(-1);error.SetValue(95);R_SUCCEED();}
        Out out{};R_TRY(serviceDispatchInOut(m_forward_service.get(),30,input,out,.buffer_attrs={SfBufferAttr_HipcMapAlias|SfBufferAttr_Out},.buffers={{buffer.GetPointer(),buffer.GetSize()}}));ret.SetValue(out.ret);error.SetValue(out.err);R_SUCCEED();
    }

}
