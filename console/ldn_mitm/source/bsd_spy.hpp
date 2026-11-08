/* Modified by LANywhere Self-host, 2026-11-07 to 2026-11-08. */
/*
 * LANywhere: observación (sin cambios) de los sockets de los juegos, servicio bsd:u.
 *
 * Primer paso del plan: saber qué hace un juego en modo inalámbrico local (UDP/TCP, direcciones, puertos,
 * volumen) antes de redirigir su tráfico por el servidor. Cada comando se reenvía tal cual al servicio real;
 * los demás comandos de bsd:u los reenvía el propio servidor mitm.
 *
 * This program is free software; you can redistribute it and/or modify it under the terms and conditions of
 * the GNU General Public License, version 2, as published by the Free Software Foundation.
 */
#pragma once
#include <stratosphere.hpp>
#include "tcp_stream_hooks.hpp"

#define AMS_IBSD_SPY(C, H)                                                                                                                                  \
    AMS_SF_METHOD_INFO(C, H,  2, Result, Socket,  (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, s32 domain, s32 type, s32 protocol),           \
                                                  (out_ret, out_errno, domain, type, protocol))                                                         \
    AMS_SF_METHOD_INFO(C, H,  5, Result, Select, (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, ams::mitm::tcpstream::NativeSelectData input, const ams::sf::InAutoSelectBuffer &read_in, const ams::sf::InAutoSelectBuffer &write_in, const ams::sf::InAutoSelectBuffer &except_in, const ams::sf::OutAutoSelectBuffer &read_out, const ams::sf::OutAutoSelectBuffer &write_out, const ams::sf::OutAutoSelectBuffer &except_out), \
                                                  (out_ret, out_errno, input, read_in, write_in, except_in, read_out, write_out, except_out))             \
    AMS_SF_METHOD_INFO(C, H,  6, Result, Poll,    (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, u32 nfds, s32 timeout,                        \
                                                   const ams::sf::InAutoSelectBuffer &fds_in, const ams::sf::OutAutoSelectBuffer &fds_out),             \
                                                  (out_ret, out_errno, nfds, timeout, fds_in, fds_out))                                                 \
    AMS_SF_METHOD_INFO(C, H,  8, Result, Recv,    (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, s32 fd, s32 flags,                            \
                                                   const ams::sf::OutAutoSelectBuffer &data),                                                           \
                                                  (out_ret, out_errno, fd, flags, data))                                                                \
    AMS_SF_METHOD_INFO(C, H,  9, Result, RecvFrom,(ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, ams::sf::Out<u32> out_addrlen, s32 fd,       \
                                                   s32 flags, const ams::sf::OutAutoSelectBuffer &data, const ams::sf::OutAutoSelectBuffer &addr),      \
                                                  (out_ret, out_errno, out_addrlen, fd, flags, data, addr))                                             \
    AMS_SF_METHOD_INFO(C, H, 20, Result, Fcntl,   (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, s32 fd, s32 cmd, s32 arg),                    \
                                                  (out_ret, out_errno, fd, cmd, arg))                                                                   \
    AMS_SF_METHOD_INFO(C, H, 21, Result, SetSockOpt, (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, s32 fd, s32 level, s32 optname,           \
                                                   const ams::sf::InAutoSelectBuffer &optval),                                                          \
                                                  (out_ret, out_errno, fd, level, optname, optval))                                                     \
    AMS_SF_METHOD_INFO(C, H, 10, Result, Send,    (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, s32 fd, s32 flags,                            \
                                                   const ams::sf::InAutoSelectBuffer &data),                                                            \
                                                  (out_ret, out_errno, fd, flags, data))                                                                \
    AMS_SF_METHOD_INFO(C, H, 11, Result, SendTo,  (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, s32 fd, s32 flags,                            \
                                                   const ams::sf::InAutoSelectBuffer &data, const ams::sf::InAutoSelectBuffer &addr),                   \
                                                  (out_ret, out_errno, fd, flags, data, addr))                                                          \
    AMS_SF_METHOD_INFO(C, H, 12, Result, Accept, (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, ams::sf::Out<u32> out_addrlen, s32 fd, const ams::sf::OutAutoSelectBuffer &addr), (out_ret, out_errno, out_addrlen, fd, addr)) \
    AMS_SF_METHOD_INFO(C, H, 13, Result, Bind,    (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, s32 fd, const ams::sf::InAutoSelectBuffer &addr), \
                                                  (out_ret, out_errno, fd, addr))                                                                       \
    AMS_SF_METHOD_INFO(C, H, 14, Result, Connect, (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, s32 fd, const ams::sf::InAutoSelectBuffer &addr), \
                                                  (out_ret, out_errno, fd, addr))                                                                       \
    AMS_SF_METHOD_INFO(C, H, 15, Result, GetPeerName, (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, ams::sf::Out<u32> out_addrlen, s32 fd, const ams::sf::OutAutoSelectBuffer &addr), (out_ret, out_errno, out_addrlen, fd, addr)) \
    AMS_SF_METHOD_INFO(C, H, 16, Result, GetSockName, (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, ams::sf::Out<u32> out_addrlen, s32 fd, const ams::sf::OutAutoSelectBuffer &addr), (out_ret, out_errno, out_addrlen, fd, addr)) \
    AMS_SF_METHOD_INFO(C, H, 17, Result, GetSockOpt, (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, ams::sf::Out<u32> out_len, s32 fd, s32 level, s32 option, const ams::sf::OutAutoSelectBuffer &value), (out_ret, out_errno, out_len, fd, level, option, value)) \
    AMS_SF_METHOD_INFO(C, H, 18, Result, Listen,  (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, s32 fd, s32 backlog),                         \
                                                  (out_ret, out_errno, fd, backlog))                                                                    \
    AMS_SF_METHOD_INFO(C, H, 22, Result, Shutdown, (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, s32 fd, s32 how), (out_ret, out_errno, fd, how)) \
    AMS_SF_METHOD_INFO(C, H, 23, Result, ShutdownAllSockets, (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, s32 how), (out_ret, out_errno, how)) \
    AMS_SF_METHOD_INFO(C, H, 24, Result, Write, (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, s32 fd, const ams::sf::InAutoSelectBuffer &data), (out_ret, out_errno, fd, data)) \
    AMS_SF_METHOD_INFO(C, H, 25, Result, Read, (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, s32 fd, const ams::sf::OutAutoSelectBuffer &data), (out_ret, out_errno, fd, data)) \
    AMS_SF_METHOD_INFO(C, H, 26, Result, Close,   (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, s32 fd), (out_ret, out_errno, fd))              \
    AMS_SF_METHOD_INFO(C, H, 27, Result, DuplicateSocket, (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, ams::mitm::tcpstream::NativeDuplicateData input), (out_ret, out_errno, input)) \
    AMS_SF_METHOD_INFO(C, H, 29, Result, RecvMMsg, (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, ams::mitm::tcpstream::NativeRecvMmsgData input, const ams::sf::OutMapAliasBuffer &buffer), (out_ret, out_errno, input, buffer)) \
    AMS_SF_METHOD_INFO(C, H, 30, Result, SendMMsg, (ams::sf::Out<s32> out_ret, ams::sf::Out<s32> out_errno, ams::mitm::tcpstream::NativeSendMmsgData input, const ams::sf::OutMapAliasBuffer &buffer), (out_ret, out_errno, input, buffer))

AMS_SF_DEFINE_MITM_INTERFACE(ams::mitm::bsd, IBsdSpy, AMS_IBSD_SPY, 0x5357424F)

namespace ams::mitm::bsd {

    class BsdSpyService : public sf::MitmServiceImplBase {
        private:
            Result EnsureUdpPort(s32 fd, u16 *port, s32 *err, bool bind_if_needed);
            Result ReceiveVirtual(s32 fd, s32 flags, const sf::OutAutoSelectBuffer &data,
                                  const sf::OutAutoSelectBuffer *addr, bool *handled, s32 *ret, s32 *err, u32 *addrlen);
        public:
            BsdSpyService(std::shared_ptr<::Service> &&service, const sm::MitmProcessInfo &client);
            ~BsdSpyService();

            // Solo los juegos (aplicaciones): ni el sistema ni este mismo sysmodule.
            static bool ShouldMitm(const sm::MitmProcessInfo &client_info) {
                return ncm::IsApplicationId(client_info.program_id);
            }

            Result Socket(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 domain, s32 type, s32 protocol);
            Result Select(sf::Out<s32> out_ret, sf::Out<s32> out_errno, tcpstream::NativeSelectData input,
                          const sf::InAutoSelectBuffer &read_in, const sf::InAutoSelectBuffer &write_in, const sf::InAutoSelectBuffer &except_in,
                          const sf::OutAutoSelectBuffer &read_out, const sf::OutAutoSelectBuffer &write_out, const sf::OutAutoSelectBuffer &except_out);
            Result Poll(sf::Out<s32> out_ret, sf::Out<s32> out_errno, u32 nfds, s32 timeout, const sf::InAutoSelectBuffer &fds_in,
                        const sf::OutAutoSelectBuffer &fds_out);
            Result Recv(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, s32 flags, const sf::OutAutoSelectBuffer &data);
            Result RecvFrom(sf::Out<s32> out_ret, sf::Out<s32> out_errno, sf::Out<u32> out_addrlen, s32 fd, s32 flags,
                            const sf::OutAutoSelectBuffer &data, const sf::OutAutoSelectBuffer &addr);
            Result Fcntl(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, s32 cmd, s32 arg);
            Result SetSockOpt(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, s32 level, s32 optname, const sf::InAutoSelectBuffer &optval);
            Result Send(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, s32 flags, const sf::InAutoSelectBuffer &data);
            Result SendTo(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, s32 flags, const sf::InAutoSelectBuffer &data,
                          const sf::InAutoSelectBuffer &addr);
            Result Bind(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, const sf::InAutoSelectBuffer &addr);
            Result Connect(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, const sf::InAutoSelectBuffer &addr);
            Result Accept(sf::Out<s32> out_ret, sf::Out<s32> out_errno, sf::Out<u32> out_addrlen, s32 fd, const sf::OutAutoSelectBuffer &addr);
            Result GetPeerName(sf::Out<s32> out_ret, sf::Out<s32> out_errno, sf::Out<u32> out_addrlen, s32 fd, const sf::OutAutoSelectBuffer &addr);
            Result GetSockName(sf::Out<s32> out_ret, sf::Out<s32> out_errno, sf::Out<u32> out_addrlen, s32 fd, const sf::OutAutoSelectBuffer &addr);
            Result GetSockOpt(sf::Out<s32> out_ret, sf::Out<s32> out_errno, sf::Out<u32> out_len, s32 fd, s32 level, s32 option, const sf::OutAutoSelectBuffer &value);
            Result Listen(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, s32 backlog);
            Result Shutdown(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, s32 how);
            Result ShutdownAllSockets(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 how);
            Result Write(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, const sf::InAutoSelectBuffer &data);
            Result Read(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd, const sf::OutAutoSelectBuffer &data);
            Result Close(sf::Out<s32> out_ret, sf::Out<s32> out_errno, s32 fd);
            Result DuplicateSocket(sf::Out<s32> out_ret, sf::Out<s32> out_errno, tcpstream::NativeDuplicateData input);
            Result RecvMMsg(sf::Out<s32> out_ret, sf::Out<s32> out_errno, tcpstream::NativeRecvMmsgData input,const sf::OutMapAliasBuffer &buffer);
            Result SendMMsg(sf::Out<s32> out_ret, sf::Out<s32> out_errno, tcpstream::NativeSendMmsgData input,const sf::OutMapAliasBuffer &buffer);
    };
    static_assert(IsIBsdSpy<BsdSpyService>);

}
