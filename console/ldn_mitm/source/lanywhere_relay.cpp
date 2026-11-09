/* Modified by LANywhere Self-host, 2026-11-07 to 2026-11-08. */
/*
 * LANywhere: cliente del servidor de salas (ver lanywhere_relay.hpp y docs/PROTOCOL.md).
 *
 * This program is free software; you can redistribute it and/or modify it under the terms and conditions of
 * the GNU General Public License, version 2, as published by the Free Software Foundation.
 */
#include "lanywhere_relay.hpp"
#include "tcp_stream_proxy.hpp"
#include "udp_reassembly.hpp"
#include "udp_fragment_writer.hpp"
#include "udp_heartbeat.hpp"
#include "transport_recovery.hpp"
#include "udp_send_policy.hpp"
#include "relay_queue.hpp"
#include "ldn_types.hpp"
#include "../../../common/relay_profile.h"
#include <algorithm>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdarg>
#include <cerrno>
#include "game_identity_cache.hpp"
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/time.h>

namespace ams::mitm::lanywhere {

    namespace {

        constexpr const char ConfigPath[] = "sdmc:/lanywhere/config.ini";
#if RELAY_PROFILE_FIXED
        static_assert(RELAY_PROFILE_PORT > 0 && RELAY_PROFILE_PORT <= 65535);
        constexpr const char ConfigError[] = "Invalid server or network settings";
#else
        constexpr u16 DefaultPort = 11460;
        constexpr const char ConfigError[] = "Set a valid server IPv4 and port in the LANywhere app";
#endif
        constexpr s64 MaxConfigSize = 511;
        constexpr const char LogPath[] = "sdmc:/lanywhere/relay.log";
        constexpr u32 UdpMagic = 0x594E414C;
        constexpr int ConnectTimeoutMs = 5000;
        constexpr int MatchIoTimeoutMs = 900;
        constexpr u8 Features = 1;
        constexpr u32 CapabilityMatch = 1, CapabilityPages = 2, CapabilityFragment = 4, CapabilityHeartbeat = 8, CapabilityFilteredFind = 16, CapabilityProvider = 32, CapabilityMetadata = 64;
        constexpr size_t NetworkInfoSize = 0x480;
        constexpr size_t MatchTicketSize = 16, MatchFilterSize = 96;
        constexpr size_t GroupRecordSize = CodeLength + NetworkInfoSize;
        static_assert(sizeof(ldn::NetworkInfo) == NetworkInfoSize);
        static_assert(sizeof(ldn::ScanFilter) == MatchFilterSize && offsetof(ldn::ScanFilter, flag) == 92);
        static_assert(offsetof(ldn::ScanFilter, ssid) == 42 && offsetof(ldn::ScanFilter, networkType) == 32);
        static_assert(offsetof(ldn::IntentId, sceneId) == 10 && offsetof(ldn::NetworkId, sessionId) == 16);
        static_assert(sizeof(ldn::NodeInfo) == 64 && offsetof(ldn::NodeInfo, localCommunicationVersion) == 46);
        static_assert(offsetof(ldn::NetworkInfo, ldn) == 0x50 && offsetof(ldn::LdnNetworkInfo, nodes) == 24);
        static_assert(offsetof(ldn::LdnNetworkInfo, nodeCountMax) == 22 && offsetof(ldn::LdnNetworkInfo, nodeCount) == 23);
        constexpr TimeSpan KeepAliveInterval = TimeSpan::FromSeconds(5);
        constexpr TimeSpan ReconnectWindow = TimeSpan::FromSeconds(55);  // el servidor guarda el puesto 60 s

        enum : u8 { T_Create = 0x01, T_Join = 0x02, T_Leave = 0x03, T_Relay = 0x04, T_Ping = 0x05, T_Resume = 0x06, T_Publish = 0x07, T_Find = 0x08,
                    T_SelectProvider = 0x20, T_SetMetadata = 0x21, T_FindMetadataPage = 0x22,
                    T_Reserve = 0x09, T_Cancel = 0x0a, T_Caps = 0x0b, T_FindPage = 0x0c, T_FindFilter = 0x0d,
                    T_Room = 0x81, T_MemberJoined = 0x82, T_MemberLeft = 0x83, T_RelayIn = 0x84, T_Error = 0x85, T_Pong = 0x86, T_Groups = 0x87,
                    T_ProviderSelected = 0xa0, T_MetadataPage = 0xa2,
                    T_Reservation = 0x88, T_CapsReply = 0x89, T_Page = 0x8a };
        enum : u8 { U_Register = 0x01, U_Data = 0x02, U_KeepAlive = 0x03, U_RegisterV2 = 0x04,
                    U_DataFragment = 0x05, U_Heartbeat = 0x06, U_Registered = 0x81, U_DataIn = 0x82,
                    U_RegisteredV2 = 0x84, U_DataFragmentIn = 0x85, U_HeartbeatAck = 0x86 };

        struct Control { u8 from; LdnMsg msg; u16 size; u8 data[MaxControl]; };
        constexpr size_t ControlQueueSize = 16;

        constinit os::SdkMutex g_lock;        // estado de la sala
        constinit os::SdkMutex g_queue_lock;  // cola de paquetes
        constinit os::SdkMutex g_send_lock;   // escrituras en el TCP (hilo de la sala e hilos de ldn)
        constinit os::SdkMutex g_room_lifecycle_lock;
        constinit os::SdkMutex g_match_lock;
        u8 g_room_ticket[MatchTicketSize];
        RelayState g_state = RelayState::Idle;
        bool g_recovering = false;
        char g_code[CodeLength + 1];
        char g_error[64];
        u64 g_game_id;
        u8 g_my_index;
        u32 g_my_ip, g_token;
        std::atomic<u32> g_net_ip;  // copia de g_my_ip sin cerrojo: la consulta bsd en cada envío
        Member g_members[MaxMembers];
        u32 g_sent, g_received;
        u32 g_udp_features;
        u32 g_capabilities;
        std::atomic<u64> g_stream_epoch{1};
        std::atomic<bool> g_stream_ready{false};
        char g_room_provider[33] = "self";
        u64 g_host_program_id;
        GameIdentity g_last_metadata{};
        bool g_metadata_sent;
        bool g_public_group_sent;
        bool g_metadata_fingerprint_valid;
        u8 g_metadata_fingerprint[32];
        u64 g_metadata_lcid;
        os::Tick g_metadata_checked{0};
        std::atomic<u32> g_fragment_id{0};
        std::atomic<u32> g_heartbeat_sequence{0};
        u32 g_send_retries, g_send_failures;  // envíos al servidor con el búfer de salida lleno
        int g_tcp = -1, g_udp = -1;
        sockaddr_in g_server;
        os::Tick g_last_keepalive;
        bool g_public = true;  // The saved visibility preference applies to external networks.
        char g_nick[NickLength];  // apodo (config.ini "apodo="); nunca el nombre de usuario de la consola

        RelayQueue g_queue;
        FragmentAssembly g_fragments;
        Control g_controls[ControlQueueSize];
        size_t g_control_head, g_control_count;

        alignas(os::ThreadStackAlignment) u8 g_thread_stack[0x4000];
        os::ThreadType g_thread;
        bool g_thread_started;

        constinit os::SdkMutex g_log_lock;

        void SetError(const char *msg) {
            util::Strlcpy(g_error, msg, sizeof(g_error));
            g_state = RelayState::Error;
        }

        u16 le16(const u8 *p) { return p[0] | p[1] << 8; }
        u32 le32(const u8 *p) { return p[0] | p[1] << 8 | p[2] << 16 | static_cast<u32>(p[3]) << 24; }
        u64 le64(const u8 *p) { return le32(p) | static_cast<u64>(le32(p + 4)) << 32; }
        void put16(u8 *p, u16 v) { p[0] = v; p[1] = v >> 8; }
        void put32(u8 *p, u32 v) { for (int i = 0; i < 4; i++) p[i] = v >> (8 * i); }
        void put64(u8 *p, u64 v) { for (int i = 0; i < 8; i++) p[i] = v >> (8 * i); }

        // Fixed builds read only preferences from the SD card. An active room keeps its own endpoint.
        bool LoadServer(sockaddr_in *server = nullptr, char *provider = nullptr) {
            if (provider) util::Strlcpy(provider, "self", 33);
            bool validProvider = true, providerSeen = false, selectedSelf = true;
#if RELAY_PROFILE_FIXED
            constexpr const char host[] = RELAY_PROFILE_IPV4;
            constexpr u16 port = RELAY_PROFILE_PORT;
            constexpr bool validPort = true;
#else
            char host[64] = {};
            u16 port = DefaultPort;
            bool validPort = true;
#endif
            g_nick[0] = '\0';
            g_public = true;
            fs::FileHandle file;
            Result open_result = fs::OpenFile(std::addressof(file), ConfigPath, fs::OpenMode_Read);
            if (fs::ResultPathNotFound::Includes(open_result))
                open_result = fs::OpenFile(std::addressof(file), "sdmc:/lanywhere/config.ini.bak", fs::OpenMode_Read);
            if (R_FAILED(open_result) && !fs::ResultPathNotFound::Includes(open_result)) return false;
            if (R_SUCCEEDED(open_result)) {
                char text[MaxConfigSize + 1] = {};
                s64 size = 0;
                size_t read = 0;
                if (R_SUCCEEDED(fs::GetFileSize(std::addressof(size), file)) &&
                    size >= 0 && size <= MaxConfigSize &&
                    R_SUCCEEDED(fs::ReadFile(std::addressof(read), file, 0, text, static_cast<size_t>(size))) &&
                    read == static_cast<size_t>(size) && std::memchr(text, '\0', read) == nullptr) {
                    text[read] = '\0';
                    char *rest = nullptr;
                    for (char *line = ::strtok_r(text, "\r\n", &rest); line; line = ::strtok_r(nullptr, "\r\n", &rest)) {
#if !RELAY_PROFILE_FIXED
                        if (std::strncmp(line, "server=", 7) == 0) util::Strlcpy(host, line + 7, sizeof(host));
                        if (std::strncmp(line, "port=", 5) == 0) {
                            const char *value = line + 5;
                            char *end = nullptr;
                            const unsigned long number = std::strtoul(value, &end, 10);
                            validPort = value[0] >= '0' && value[0] <= '9' && *end == '\0' && number > 0 && number <= 65535;
                            if (validPort) port = static_cast<u16>(number);
                        }
#endif
                        if (std::strncmp(line, "network=", 8) == 0) {
                            const char *value = line + 8;
                            validProvider = !providerSeen && (!std::strcmp(value, "self") || !std::strcmp(value, "lanywhere-public") ||
                                !std::strcmp(value, "lanplay-nl") || !std::strcmp(value, "lanplay-br") || !std::strcmp(value, "lanplay-id") ||
                                !std::strcmp(value, "lanplay-nl-jaysea-rust") || !std::strcmp(value, "lanplay-nl-r3ps4j-rust") || !std::strcmp(value, "lanplay-nl-r3ps4j-11452") || !std::strcmp(value, "lanplay-de-servegame") ||
                                !std::strcmp(value, "lanplay-cn-jax") || !std::strcmp(value, "lanplay-cn-gugu") ||
                                !std::strcmp(value, "lanplay-cn-olunira") || !std::strcmp(value, "lanplay-cn-shanghai"));
                            providerSeen = true;
                            if (!validProvider) break;
                            selectedSelf = std::strcmp(value, "self") == 0;
                            if (provider) util::Strlcpy(provider, value, 33);
                        }
                        if (std::strncmp(line, "public=", 7) == 0) g_public = line[7] != '0';
                        if (std::strncmp(line, "apodo=", 6) == 0) util::Strlcpy(g_nick, line + 6, sizeof(g_nick));
                    }
                } else validProvider = false;
                fs::CloseFile(file);
            }
            if (selectedSelf) g_public = true; // Every self-hosted game room is discoverable.
            if (!server) return validProvider;
            *server = {};
            server->sin_family = AF_INET;
            server->sin_port = htons(port);
            return validProvider && validPort && ::inet_pton(AF_INET, host, std::addressof(server->sin_addr)) == 1 &&
                   server->sin_addr.s_addr != INADDR_ANY && server->sin_addr.s_addr != INADDR_BROADCAST;
        }

        bool ResolveDiscoveryRoute(const DiscoveryRoute &route, sockaddr_in *server, char provider[33]) {
            const char *end = static_cast<const char *>(std::memchr(route.provider, '\0', sizeof(route.provider)));
            if (!end || !route.ipv4 || route.ipv4 == INADDR_BROADCAST || !route.port ||
                (std::strcmp(route.provider, "self") && std::strcmp(route.provider, "lanywhere-public") &&
                 std::strcmp(route.provider, "lanplay-nl") && std::strcmp(route.provider, "lanplay-br") &&
                 std::strcmp(route.provider, "lanplay-id") && std::strcmp(route.provider, "lanplay-nl-jaysea-rust") &&
                 std::strcmp(route.provider, "lanplay-nl-r3ps4j-rust") && std::strcmp(route.provider, "lanplay-nl-r3ps4j-11452") && std::strcmp(route.provider, "lanplay-de-servegame") &&
                 std::strcmp(route.provider, "lanplay-cn-jax") && std::strcmp(route.provider, "lanplay-cn-gugu") &&
                 std::strcmp(route.provider, "lanplay-cn-olunira") && std::strcmp(route.provider, "lanplay-cn-shanghai"))) return false;
            *server = {};
            server->sin_family = AF_INET;
            server->sin_addr.s_addr = route.ipv4;
            server->sin_port = route.port;
            util::Strlcpy(provider, route.provider, 33);
            return true;
        }

        // A card selection is a short-lived intent, separate from the saved network
        // and from the provider of an active room.
        constexpr u64 HostRouteEpoch = UINT64_MAX;
        constexpr u64 SelectionLifetimeMs = 180'000;
        DiscoveryRoute g_selection{};
        u64 g_selection_until_ms = 0, g_selection_epoch = 0;

        u64 SelectionNowMs() {
            return static_cast<u64>(os::GetSystemTick().ToTimeSpan().GetMilliSeconds());
        }

        void ClearSelectionLocked() {
            g_selection = {};
            g_selection_until_ms = 0;
        }

        void SelectRouteLocked(const DiscoveryRoute &route, const char *code) {
            do { ++g_selection_epoch; } while (!g_selection_epoch || g_selection_epoch == HostRouteEpoch);
            g_selection = route;
            g_selection.selection_epoch = g_selection_epoch;
            util::Strlcpy(g_selection.selected_code, code, sizeof(g_selection.selected_code));
            g_selection_until_ms = SelectionNowMs() + SelectionLifetimeMs;
        }

        bool PinnedRouteCurrentLocked(const DiscoveryRoute &route) {
            if (!route.selection_epoch) return false;
            sockaddr_in server{};
            if (!LoadServer(&server) || server.sin_addr.s_addr != route.ipv4 || server.sin_port != route.port)
                return false;
            if (route.selection_epoch == HostRouteEpoch) return std::strcmp(route.provider, "self") == 0;
            return route.selection_epoch == g_selection.selection_epoch &&
                route.selected_game_id == g_selection.selected_game_id &&
                std::memcmp(route.selected_code, g_selection.selected_code, sizeof(route.selected_code)) == 0 &&
                std::strcmp(route.provider, g_selection.provider) == 0 &&
                SelectionNowMs() < g_selection_until_ms;
        }

        // Called with g_lock held. A reserved match pins self; a discovery route
        // carries its provider explicitly and must never be treated as self.
        bool ChooseEnterRoute(const sockaddr_in *pinned, const DiscoveryRoute *discovery_route,
                              sockaddr_in *server, char provider[33]) {
            if (pinned && discovery_route) return false;
            if (discovery_route) return ResolveDiscoveryRoute(*discovery_route, server, provider);
            if (pinned) {
                *server = *pinned;
                util::Strlcpy(provider, "self", 33);
                return true;
            }
            return LoadServer(server, provider);
        }

        void CloseSockets() {
            u64 old_epoch;
            {
                std::scoped_lock lk(g_send_lock);
                g_stream_ready = false;
                old_epoch = g_stream_epoch.fetch_add(1);
                if (g_tcp >= 0) { ::close(g_tcp); g_tcp = -1; }
                if (g_udp >= 0) { ::close(g_udp); g_udp = -1; }
            }
            tcpstream::ResetTransport(old_epoch);
        }

        bool SendFrameTo(int fd, u8 type, const void *body, size_t size, const void *extra, size_t extra_size) {
            u8 frame[3 + 2 + MaxControl];
            if (size + extra_size > sizeof(frame) - 3 || fd < 0) {
                return false;
            }
            put16(frame, static_cast<u16>(size + extra_size + 1));
            frame[2] = type;
            if (size) std::memcpy(frame + 3, body, size);
            if (extra_size) std::memcpy(frame + 3 + size, extra, extra_size);
            const size_t total = 3 + size + extra_size;
            for (size_t sent = 0; sent < total; ) {
                const ssize_t n = ::send(fd, frame + sent, total - sent, 0);
                if (n <= 0) return false;
                sent += n;
            }
            return true;
        }

        bool SendFrame(u8 type, const void *body, size_t size, const void *extra = nullptr, size_t extra_size = 0) {
            std::scoped_lock lk(g_send_lock);
            return SendFrameTo(g_tcp, type, body, size, extra, extra_size);
        }

        void EnqueueControl(u8 from, LdnMsg msg, const u8 *data, size_t size) {
            if (size > MaxControl) return;
            std::scoped_lock lk(g_queue_lock);
            if (g_control_count == ControlQueueSize) {
                g_control_head = (g_control_head + 1) % ControlQueueSize;
                g_control_count--;
            }
            Control &c = g_controls[(g_control_head + g_control_count) % ControlQueueSize];
            c.from = from;
            c.msg = msg;
            c.size = static_cast<u16>(size);
            if (size) std::memcpy(c.data, data, size);
            g_control_count++;
        }

        // Lee una trama completa (bloqueando como mucho timeout_ms). Devuelve su tamaño de cuerpo o -1.
        ssize_t ReadFrame(int fd, u8 *type, u8 *body, size_t body_size, int timeout_ms) {
            const os::Tick start = os::GetSystemTick();
            auto wait = [&] {
                const s64 remaining = timeout_ms - (os::GetSystemTick() - start).ToTimeSpan().GetMilliSeconds();
                pollfd p = { fd, POLLIN, 0 };
                return remaining > 0 && ::poll(std::addressof(p), 1, static_cast<int>(remaining)) > 0;
            };
            u8 head[3];
            size_t got = 0;
            while (got < sizeof(head)) {
                if (!wait()) return -1;
                const ssize_t n = ::recv(fd, head + got, sizeof(head) - got, 0);
                if (n <= 0) return -1;
                got += n;
            }
            const size_t len = le16(head) - 1;
            *type = head[2];
            if (len > body_size) return -1;
            got = 0;
            while (got < len) {
                if (!wait()) return -1;
                const ssize_t n = ::recv(fd, body + got, len - got, 0);
                if (n <= 0) return -1;
                got += n;
            }
            return static_cast<ssize_t>(len);
        }

        bool UdpSendTo(int fd, const sockaddr_in &server, u32 token, u8 type, const void *body, size_t size) {
            u8 buf[9 + 8 + MaxPayload];
            put32(buf, UdpMagic);
            buf[4] = type;
            put32(buf + 5, token);
            if (size) std::memcpy(buf + 9, body, size);
            // El juego envía a ráfagas (los datos de la carrera, por ejemplo): si el búfer de salida está lleno, se
            // espera un poco en lugar de perder el paquete.
            for (int tries = 0;; tries++) {
                if (::sendto(fd, buf, 9 + size, 0, reinterpret_cast<const sockaddr *>(std::addressof(server)), sizeof(server)) >= 0) return true;
                const int err = errno;
                if ((err == ENOBUFS || err == EAGAIN || err == EWOULDBLOCK) && tries < 40) {
                    if (++g_send_retries % 200 == 1) Log("udp: búfer de salida lleno, reintentando (%u veces)", g_send_retries);
                    svcSleepThread(500'000);
                    continue;
                }
                if (++g_send_failures % 50 == 1) Log("udp: envío perdido (%u en total), errno %d", g_send_failures, err);
                return false;
            }
        }

        bool UdpSend(u8 type, const void *body, size_t size) {
            return UdpSendTo(g_udp, g_server, g_token, type, body, size);
        }

        ssize_t UdpReceiveFrom(int fd, const sockaddr_in &server, void *buffer, size_t size) {
            sockaddr_in sender{};
            socklen_t length = sizeof(sender);
            const ssize_t received = ::recvfrom(fd, buffer, size, 0, reinterpret_cast<sockaddr *>(&sender), &length);
            if (received < 0 || length < sizeof(sender) || sender.sin_family != AF_INET ||
                sender.sin_addr.s_addr != server.sin_addr.s_addr || sender.sin_port != server.sin_port) {
                return -1;
            }
            return received;
        }

        void AddMember(const u8 *m) {
            const u8 index = m[0];
            if (index >= MaxMembers) return;
            Member &dst = g_members[index];
            dst.present = true;
            dst.index = index;
            dst.ip = le32(m + 1);
            std::memcpy(dst.nick, m + 5, NickLength);
            dst.nick[NickLength - 1] = '\0';
        }

        void EnqueueDatagram(u32 src_ip, u16 src_port, u16 dst_port, const u8 *data, size_t size) {
            if (size > MaxUdpPayload) return;
            std::scoped_lock lk(g_queue_lock);
            static_cast<void>(g_queue.Push(src_ip, src_port, dst_port, data, size));
        }

        void Enqueue(const u8 *msg, size_t size) {
            if (size < 13 || size - 13 > MaxPayload) return;
            EnqueueDatagram(le32(msg + 5), le16(msg + 9), le16(msg + 11), msg + 13, size - 13);
        }

        void HandleFrame(u8 type, const u8 *body, size_t size, u64 read_epoch) {
            if (type == tcpstream::Response) {
                u64 epoch;u32 capabilities,self_ip;
                if (CaptureTcpTransport(&epoch,&capabilities,&self_ip) && epoch==read_epoch &&
                    (capabilities&tcpstream::Capability)) {
                    tcpstream::Frame stream;
                    if(!tcpstream::Parse(body,size,&stream)||MemberOfIp(stream.peer)<0)return;
                    tcpstream::ReceiveFrame(epoch,body,size);
                    if(size>=tcpstream::PrefixBytes+tcpstream::HeaderBytes&&body[5]==static_cast<u8>(tcpstream::Op::LegacyReady)&&tcpstream::Global().HasLegacyStream())
                        Log("Legacy game TCP is unconfirmed.");
                }
                return;
            }
            std::scoped_lock lk(g_lock);
            if(g_stream_epoch.load()!=read_epoch)return;
            switch (type) {
                case T_MemberJoined: if (size >= 37) AddMember(body); break;
                case T_MemberLeft:
                    if (size >= 1 && body[0] < MaxMembers) {
                        tcpstream::Global().PeerLeft(g_members[body[0]].ip);
                        g_members[body[0]].present = false;
                        EnqueueControl(body[0], LdnMsg::MemberLeft, nullptr, 0);
                    }
                    break;
                case T_RelayIn:
                    if (size >= 2) {
                        Log("ldn <- miembro %u: mensaje %u (%zu bytes)", body[0], body[1], size - 2);
                        EnqueueControl(body[0], static_cast<LdnMsg>(body[1]), body + 2, size - 2);
                    }
                    break;
                case T_Error:
                    if (size >= 1 && body[0] == 10)
                        util::Strlcpy(g_error, "Some players cannot receive this game datagram.", sizeof(g_error));
                    break;
                default:             break;  // PONG
            }
        }

        // Una conexión ya establecida con el servidor (CREATE, JOIN o RESUME contestado con ROOM y UDP registrado).
        struct Session {
            int tcp, udp;
            u32 udp_features, capabilities;
            char provider[33];
            bool no_seat;  // RESUME rechazado: el servidor ya no guarda el puesto
            u8 error_code;
            size_t reply_size;
            u8 reply[24 + MaxMembers * 37 + 64];
            char error[64];
        };

        // Listing callers preserve transport/protocol failures across the IPC boundary.
        ssize_t ReadListFrame(int fd, u8 *type, u8 *body, size_t size, int timeout_ms, u32 *status) {
            const os::Tick start = os::GetSystemTick();
            *type = 0;
            const ssize_t count = ReadFrame(fd, type, body, size, timeout_ms);
            if (status) {
                const s64 elapsed = (os::GetSystemTick() - start).ToTimeSpan().GetMilliSeconds();
                *status = count >= 0 ? ListStatusProtocol :
                    elapsed >= timeout_ms - 1 ? ListStatusTimeout : ListStatusUnavailable;
            }
            return count;
        }

        bool QueryCapabilities(int fd, u32 *flags, int timeout_ms = MatchIoTimeoutMs, u32 *status = nullptr);

        // Conexión TCP con el servidor (con tiempo límite): fd o -1 y el motivo.
        int RemainingIoMs(int maximum, u64 deadline_ms) {
            if (!deadline_ms) return maximum;
            const u64 now = static_cast<u64>(os::GetSystemTick().ToTimeSpan().GetMilliSeconds());
            return now >= deadline_ms ? 0 : static_cast<int>(std::min<u64>(maximum, deadline_ms - now));
        }

        int ConnectServer(const sockaddr_in &server, const char **err, int timeout_ms = ConnectTimeoutMs, const char *provider = "self", u32 *status = nullptr, u64 deadline_ms = 0) {
            if (status) *status = ListStatusNetwork;
            const bool external = std::strcmp(provider, "self") != 0;
            if (external) timeout_ms = std::max(timeout_ms, ConnectTimeoutMs);
            timeout_ms = RemainingIoMs(timeout_ms, deadline_ms);
            if (timeout_ms <= 0) { *err = "el servidor no responde"; return -1; }
            const int fd = ::socket(AF_INET, SOCK_STREAM, 0);
            if (fd < 0) { *err = "no se pudo crear el socket"; return -1; }
            const int one = 1;
            ::setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, std::addressof(one), sizeof(one));
            // connect no bloqueante con tiempo límite
            ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) | O_NONBLOCK);
            if (::connect(fd, reinterpret_cast<const sockaddr *>(std::addressof(server)), sizeof(server)) != 0 && errno != EINPROGRESS) {
                ::close(fd);
                *err = "no se pudo conectar con el servidor";
                return -1;
            }
            pollfd p = { fd, POLLOUT, 0 };
            int so_error = 0;
            socklen_t len = sizeof(so_error);
            const int connected = ::poll(std::addressof(p), 1, timeout_ms);
            if (connected <= 0 ||
                ::getsockopt(fd, SOL_SOCKET, SO_ERROR, std::addressof(so_error), std::addressof(len)) != 0 || so_error != 0) {
                if (status && connected == 0) *status = ListStatusTimeout;
                ::close(fd);
                *err = "el servidor no responde";
                return -1;
            }
            ::fcntl(fd, F_SETFL, ::fcntl(fd, F_GETFL, 0) & ~O_NONBLOCK);
            const timeval send_timeout = { timeout_ms / 1000, (timeout_ms % 1000) * 1000 };
            ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &send_timeout, sizeof(send_timeout));
            if (external) {
                const size_t length = std::strlen(provider);
                u8 type = 0, reply[128] = {};
                if (!length || length > 32 || !SendFrameTo(fd, T_SelectProvider, provider, length, nullptr, 0)) {
                    ::close(fd); *err = "Could not select the external network."; return -1;
                }
                // The relay may be starting an isolated realm or waiting on a
                // distant public upstream. Our own TCP connect budget is unchanged.
                const int selection_timeout_ms = RemainingIoMs(std::strncmp(provider, "lanplay-", 8) == 0 ? 14000 : timeout_ms, deadline_ms);
                if (selection_timeout_ms <= 0) { ::close(fd); *err = "External network is unavailable."; return -1; }
                const ssize_t count = ReadListFrame(fd, &type, reply, sizeof(reply), selection_timeout_ms, status);
                if (type == T_Error && count >= 1) {
                    if (status) *status = lanywhere_list_error_status(reply[0]);
                    ::close(fd);
                    *err = reply[0] == 7 ? "External network is busy. Try later." :
                           reply[0] == 8 ? "Update relay to use external networks." : "External network is unavailable.";
                    return -1;
                }
                if (count != static_cast<ssize_t>(5 + length) || type != T_ProviderSelected ||
                    reply[4] != length || std::memcmp(reply + 5, provider, length) != 0) {
                    ::close(fd); *err = "External network is unavailable."; return -1;
                }
            }
            if (status) *status = ListStatusOk;
            return fd;
        }

        bool ApplyTcpAdmissionFeatures(u8 type,u8 *body,size_t size,u32 capabilities,bool worker_ready) {
            const size_t offset=(type==T_Create&&size==41)?40:
                (type==T_Join&&(size==47||size==65))?46:SIZE_MAX;
            if(!body||offset==SIZE_MAX)return false;
            body[offset]=static_cast<u8>((body[offset]&~tcpstream::MemberFeature)|
                (((capabilities&tcpstream::Capability)&&worker_ready)?tcpstream::MemberFeature:0));
            return true;
        }

        // Conecta y negocia sin tocar el estado global (puede tardar segundos y el juego consulta InRoom() sin parar).
        bool Handshake(const sockaddr_in &server, u8 type, const u8 *body, size_t size, Session *s,
                       int timeout_ms = ConnectTimeoutMs, const char *provider = "self", int total_budget_ms = 0) {
            const u64 deadline_ms = total_budget_ms > 0 ?
                static_cast<u64>(os::GetSystemTick().ToTimeSpan().GetMilliSeconds()) + total_budget_ms : 0;
            s->capabilities = 0;
            util::Strlcpy(s->provider, provider, sizeof(s->provider));
            s->tcp = s->udp = -1;
            s->udp_features = 0;
            s->no_seat = false;
            s->error_code = 0;
            s->error[0] = '\0';
            auto fail = [s](const char *msg) {
                if (s->tcp >= 0) ::close(s->tcp);
                if (s->udp >= 0) ::close(s->udp);
                s->tcp = s->udp = -1;
                if (!s->error[0]) util::Strlcpy(s->error, msg, sizeof(s->error));
                return false;
            };

            const char *err = nullptr;
            s->tcp = ConnectServer(server, std::addressof(err), timeout_ms, provider, nullptr, deadline_ms);
            if (s->tcp < 0) return fail(err);

            u32 capabilities = 0;
            int available = RemainingIoMs(timeout_ms, deadline_ms);
            if (available <= 0 || !QueryCapabilities(s->tcp, &capabilities, available)) return fail("relay capability query failed");
            s->capabilities = capabilities;

            u8 admission[65]{};
            const u8 *send_body=body;
            if(body&&size<=sizeof(admission)&&(type==T_Create||type==T_Join)) {
                std::memcpy(admission,body,size);
                ApplyTcpAdmissionFeatures(type,admission,size,capabilities,tcpstream::Global().GetMetrics().worker);
                send_body=admission;
            }

            u8 rtype = 0;
            ssize_t n = -1;
            available = RemainingIoMs(timeout_ms, deadline_ms);
            if (available <= 0) return fail("el servidor no contestó");
            if (SendFrameTo(s->tcp, type, send_body, size, nullptr, 0)) {
                available = RemainingIoMs(timeout_ms, deadline_ms);
                if (available > 0) n = ReadFrame(s->tcp, std::addressof(rtype), s->reply, sizeof(s->reply), available);
            }
            if (n < 0) return fail("el servidor no contestó");
            if (rtype == T_Error && n >= 1) {
                const u8 code = s->reply[0];
                s->error_code = code;
                char msg[64] = {};
                std::memcpy(msg, s->reply + 1, std::min<size_t>(n - 1, sizeof(msg) - 1));
                const bool ambiguous_old_gateway = type == T_Resume && code == 5 &&
                    std::strcmp(provider, "self") && !std::strcmp(msg, "provider resume seat unavailable");
                s->no_seat = !ambiguous_old_gateway && (code == 5 || (type == T_Resume && code == 1));
                return fail(code == 1 ? "la sala no existe" : code == 2 ? "la sala está llena" :
                            code == 3 ? "la sala es de otro juego" : msg);
            }
            if (rtype != T_Room || n < 24) return fail("respuesta inesperada");
            s->reply_size = n;

            // Datos: registrar el UDP (el servidor contesta REGISTERED).
            const u32 token = le32(s->reply + 11);
            s->udp = ::socket(AF_INET, SOCK_DGRAM, 0);
            bool registered = false;
            const u32 requested = capabilities & (CapabilityFragment | CapabilityHeartbeat);
            u8 feature_bytes[4]; put32(feature_bytes, requested);
            for (int i = 0; i < 20 && s->udp >= 0 && !registered; i++) {
                available = RemainingIoMs(150, deadline_ms);
                if (available <= 0) break;
                if (requested) UdpSendTo(s->udp, server, token, U_RegisterV2, feature_bytes, sizeof(feature_bytes));
                else UdpSendTo(s->udp, server, token, U_Register, nullptr, 0);
                pollfd up = { s->udp, POLLIN, 0 };
                if (::poll(std::addressof(up), 1, available) > 0) {
                    u8 r[16];
                    const ssize_t rn = UdpReceiveFrom(s->udp, server, r, sizeof(r));
                    if (requested) {
                        registered = rn == 9 && le32(r) == UdpMagic && r[4] == U_RegisteredV2 &&
                                     !(le32(r + 5) & ~requested);
                        if (registered) s->udp_features = le32(r + 5);
                    } else registered = rn == 5 && le32(r) == UdpMagic && r[4] == U_Registered;
                }
            }
            if (!registered) {
                if (type == T_Join && size == 65) {
                    SendFrameTo(s->tcp, T_Leave, nullptr, 0, nullptr, 0);
                    s->error_code = 0xff;  // the relay committed; the seat was explicitly released
                }
                return fail("el servidor no recibe datos (UDP)");
            }
            return true;
        }

        // Adopta la sesión (con g_lock tomado). Los miembros que se fueron mientras no había conexión se avisan a ldn.
        void Install(const Session &s) {
            {
                std::scoped_lock lk(g_send_lock);
                g_tcp = s.tcp;
                g_udp = s.udp;
                g_stream_epoch.fetch_add(1);
                g_stream_ready = true;
            }
            const u8 *reply = s.reply;
            std::memcpy(g_code, reply, CodeLength);
            g_code[CodeLength] = '\0';
            g_my_index = reply[6];
            g_my_ip = le32(reply + 7);
            g_net_ip = g_my_ip;
            g_token = le32(reply + 11);
            g_udp_features = s.udp_features;
            g_capabilities = s.capabilities;
            util::Strlcpy(g_room_provider, s.provider, sizeof(g_room_provider));
            g_metadata_sent = false;
            g_fragments.Reset();
            g_game_id = le64(reply + 15);
            bool before[MaxMembers];
            for (size_t i = 0; i < MaxMembers; i++) {
                before[i] = g_members[i].present;
            }
            std::memset(g_members, 0, sizeof(g_members));
            for (size_t i = 0, count = reply[23]; i < count && 24 + (i + 1) * 37 <= s.reply_size; i++) {
                AddMember(reply + 24 + i * 37);
            }
            for (size_t i = 0; i < MaxMembers; i++) {
                if (before[i] && !g_members[i].present) {
                    EnqueueControl(static_cast<u8>(i), LdnMsg::MemberLeft, nullptr, 0);
                }
            }
        }

        // Se cortó la conexión (por ejemplo, el juego activó el modo local y la consola reconectó el Wi-Fi): volver
        // al mismo puesto con RESUME mientras el servidor lo guarda. Falso si no se pudo o se salió de la sala.
        RecoveryResult Reconnect() {
            u8 body[4 + CodeLength];
            sockaddr_in server;
            char provider[33];
            u32 original_ip;
            u64 original_game;
            u8 original_index;
            {
                std::scoped_lock lk(g_lock);
                if (g_state != RelayState::InRoom) return RecoveryResult::Cancelled;
                util::Strlcpy(provider, g_room_provider, sizeof(provider));
                put32(body, g_token);
                std::memcpy(body + 4, g_code, CodeLength);
                server = g_server;
                original_ip = g_my_ip;
                original_game = g_game_id;
                original_index = g_my_index;
                g_recovering = true;
                util::Strlcpy(g_error, "Reconnecting to the room.", sizeof(g_error));
            }
            // This deliberately resets existing TCP byte streams. A room lease
            // can resume; already broken reliable streams cannot be fabricated.
            const os::Tick start = os::GetSystemTick();
            CloseSockets();
            const auto owned = [&] {
                return g_state == RelayState::InRoom && g_token == le32(body) &&
                    !std::memcmp(g_code, body + 4, CodeLength) && g_my_ip == original_ip &&
                    g_my_index == original_index && g_game_id == original_game &&
                    g_server.sin_addr.s_addr == server.sin_addr.s_addr && g_server.sin_port == server.sin_port &&
                    !std::strcmp(g_room_provider, provider);
            }; // Call only while holding g_lock.
            RecoveryBackoff backoff;
            while (true) {
                const s64 remaining = ReconnectWindow.GetMilliSeconds() - (os::GetSystemTick() - start).ToTimeSpan().GetMilliSeconds();
                if (remaining <= 0) return RecoveryResult::TimedOut;
                {
                    std::scoped_lock lk(g_lock);
                    if (!owned()) return RecoveryResult::Cancelled;
                }
                Session s;
                const bool resumed = Handshake(server, T_Resume, body, sizeof(body), std::addressof(s),
                    std::min<int>(ConnectTimeoutMs, static_cast<int>(remaining)), provider, static_cast<int>(remaining));
                if (resumed) {
                    std::scoped_lock lk(g_lock);
                    if (!owned()) {
                        ::close(s.tcp);
                        ::close(s.udp);
                        return RecoveryResult::Cancelled;
                    }
                    // A restored game continues using the old virtual addresses
                    // and membership. A different ROOM is not a successful resume.
                    if (s.reply_size < 24 || std::memcmp(s.reply, body + 4, CodeLength) ||
                        le32(s.reply + 11) != le32(body) || s.reply[6] != original_index ||
                        le32(s.reply + 7) != original_ip || le64(s.reply + 15) != original_game) {
                        SendFrameTo(s.tcp, T_Leave, nullptr, 0, nullptr, 0);
                        ::close(s.tcp);
                        ::close(s.udp);
                        return RecoveryResult::Rejected;
                    }
                    Install(s);
                    g_recovering = false;
                    g_error[0] = '\0';
                    g_last_keepalive = os::GetSystemTick();
                    return RecoveryResult::Resumed;
                }
                Log("RESUME falló: %s", s.error);
                {
                    std::scoped_lock lk(g_lock);
                    if (!owned()) return RecoveryResult::Cancelled;
                }
                if (s.no_seat) return RecoveryResult::Expired;
                const unsigned retry_delay = (s.error_code == 7 || (s.error_code == 5 && !s.no_seat)) ?
                    std::max(5000u, backoff.Next()) : backoff.Next();
                const s64 delay = std::min<s64>(retry_delay,
                    ReconnectWindow.GetMilliSeconds() - (os::GetSystemTick() - start).ToTimeSpan().GetMilliSeconds());
                for (s64 slept = 0; slept < delay; ) {
                    {
                        std::scoped_lock lk(g_lock);
                        if (!owned()) return RecoveryResult::Cancelled;
                    }
                    const s64 step = std::min<s64>(100, delay - slept);
                    os::SleepThread(TimeSpan::FromMilliSeconds(step));
                    slept += step;
                }
            }
        }

        bool RecoverTransport(HeartbeatTracker &heartbeat, TcpLiveness &control) {
            const RecoveryResult result = Reconnect();
            if (result == RecoveryResult::Resumed) {
                heartbeat.Reset(); control.Reset();
                Log("room transport resumed");
                return true;
            }
            if (result == RecoveryResult::Cancelled) return false;
            std::scoped_lock lock(g_lock);
            if (g_state == RelayState::InRoom && g_recovering) {
                g_recovering = false;
                SetError(result == RecoveryResult::Expired ? "Room session expired. Rejoin from the game." :
                    result == RecoveryResult::Rejected ? "Room changed during recovery. Rejoin from the game." :
                    "Could not reconnect. Check Wi-Fi and rejoin.");
            }
            return false;
        }

        void RefreshHostMetadata() {
            u64 program = 0, lcid = 0;
            u32 token = 0;
            {
                std::scoped_lock lock(g_lock);
                if (g_state != RelayState::InRoom || g_my_index != 0 || !(g_capabilities & CapabilityMetadata) || !g_host_program_id) return;
                program = g_host_program_id; lcid = g_game_id; token = g_token;
            }
            u8 fingerprint[32]{};
            const bool have_fingerprint = GameIdentityCacheFingerprint(fingerprint);
            GameIdentity identity{};
            bool cached = false;
            const os::Tick now = os::GetSystemTick();
            {
                std::scoped_lock lock(g_lock);
                cached = g_metadata_sent && have_fingerprint && g_metadata_fingerprint_valid &&
                    g_last_metadata.program_id == program && g_metadata_lcid == lcid &&
                    !std::memcmp(fingerprint, g_metadata_fingerprint, sizeof(fingerprint)) &&
                    (now - g_metadata_checked).ToTimeSpan() < TimeSpan::FromSeconds(60);
                if (cached) identity = g_last_metadata;
            }
            if (!cached && GameIdentityCacheLookup(program, lcid, &identity) != GameCacheFound)
                identity.program_id = program;
            std::scoped_lock lock(g_lock);
            if (g_state != RelayState::InRoom || g_my_index != 0 || g_token != token ||
                g_game_id != lcid || g_host_program_id != program) return;
            if (!cached) {
                g_metadata_fingerprint_valid = have_fingerprint;
                std::memcpy(g_metadata_fingerprint, fingerprint, sizeof(fingerprint));
                g_metadata_lcid = lcid;
                g_metadata_checked = now;
            }
            if (g_metadata_sent && std::memcmp(&identity, &g_last_metadata, sizeof(identity)) == 0) return;
            static_assert(sizeof(GameIdentity) == 272);
            if (SendFrame(T_SetMetadata, &identity, sizeof(identity))) {
                g_last_metadata = identity; g_metadata_sent = true;
                Log("identity: program=%016lx lcid=%016lx application=%016lx names=%u", program, lcid,
                    identity.application_id, identity.english[0] ? 1u : 0u);
            }
        }

        bool RegisterUdpAgain(HeartbeatTracker &heartbeat) {
            u32 requested;
            {
                std::scoped_lock lock(g_lock);
                if (g_state != RelayState::InRoom) return false;
                requested = g_udp_features;
                g_recovering = true;
                util::Strlcpy(g_error, "Reconnecting to the room.", sizeof(g_error));
            }
            u8 features[4]; put32(features, requested);
            u8 reply[16];
            const os::Tick start = os::GetSystemTick();
            s64 next_send = 0;
            while (true) {
                {
                    std::scoped_lock lock(g_lock);
                    if (g_state != RelayState::InRoom) return false;
                }
                const s64 elapsed = (os::GetSystemTick() - start).ToTimeSpan().GetMilliSeconds();
                if (elapsed >= 3000) return false;
                if (elapsed >= next_send) {
                    if (!UdpSend(U_RegisterV2, features, sizeof(features))) return false;
                    next_send = elapsed + 150;
                }
                pollfd p = {g_udp, POLLIN, 0};
                const int wait_ms = static_cast<int>(std::min<s64>(3000 - elapsed, next_send - elapsed));
                const int polled = ::poll(&p, 1, wait_ms);
                if (polled < 0) { if (errno == EINTR) continue; return false; }
                if (p.revents & (POLLHUP | POLLERR | POLLNVAL)) return false;
                if (p.revents & POLLIN) {
                    const ssize_t n = UdpReceiveFrom(p.fd, g_server, reply, sizeof(reply));
                    if (n == 9 && le32(reply) == UdpMagic && reply[4] == U_RegisteredV2 && le32(reply + 5) == requested) {
                        std::scoped_lock lock(g_lock);
                        if (g_state != RelayState::InRoom) return false;
                        g_fragments.Reset(); heartbeat.Reset();
                        g_recovering = false;
                        g_error[0] = '\0';
                        return true;
                    }
                }
            }
        }

        void Worker(void *) {
            u8 buf[9 + 8 + MaxPayload + 64];
            HeartbeatTracker heartbeat;
            TcpLiveness control;
            while (true) {
                {
                    std::scoped_lock lk(g_lock);
                    if (g_state != RelayState::InRoom) break;
                }
                bool lost = false;
                pollfd p[2]{};u64 read_epoch;
                {
                    std::scoped_lock send_lock(g_send_lock);
                    read_epoch=g_stream_epoch.load();
                    p[0]={g_tcp,POLLIN,0};p[1]={g_udp,POLLIN,0};
                }
                const int rc = ::poll(p, 2, 1000);
                if (rc < 0) {
                    if (errno == EINTR) continue;
                    lost = true;
                } else {
                    if ((p[0].revents | p[1].revents) & (POLLHUP | POLLERR | POLLNVAL)) lost = true;
                    if (p[1].revents & POLLIN) {
                        const ssize_t n = UdpReceiveFrom(g_udp, g_server, buf, sizeof(buf));
                        if (n >= 13 && le32(buf) == UdpMagic && buf[4] == U_DataIn) {
                            Enqueue(buf, n);
                            std::scoped_lock lk(g_lock);
                            g_received++;
                        } else if (n > 21 && le32(buf) == UdpMagic && buf[4] == U_DataFragmentIn &&
                                   (g_udp_features & CapabilityFragment)) {
                            const u64 now = static_cast<u64>(os::GetSystemTick().ToTimeSpan().GetMilliSeconds());
                            g_fragments.Push(le32(buf + 5), le16(buf + 9), le16(buf + 11), le32(buf + 13),
                                le16(buf + 17), le16(buf + 19), buf + 21, static_cast<size_t>(n - 21), now,
                                [](const u8 *data, size_t size, u32 source, u16 src, u16 dst) {
                                    EnqueueDatagram(source, src, dst, data, size);
                                    std::scoped_lock lk(g_lock); g_received++;
                                });
                        } else if (n == 9 && le32(buf) == UdpMagic && buf[4] == U_HeartbeatAck)
                            heartbeat.Acknowledge(le32(buf + 5));
                    }
                    if (!lost && (p[0].revents & POLLIN)) {
                        u8 type;
                        const ssize_t n = ReadFrame(p[0].fd, std::addressof(type), buf, sizeof(buf), 2000);
                        if (n < 0) {
                            lost = true;
                        } else {
                            if (type == T_Pong && n == 0 && g_stream_epoch.load() == read_epoch && g_stream_ready.load())
                                control.Acknowledge();
                            HandleFrame(type, buf, n, read_epoch);
                        }
                    }
                }
                const u64 now_ms = static_cast<u64>(os::GetSystemTick().ToTimeSpan().GetMilliSeconds());
                if (control.Expired(now_ms)) { lost = true; Log("TCP heartbeat reply timed out"); }
                if (lost) {
                    Log("conexión perdida (poll %d); reconectando", rc);
                    if (RecoverTransport(heartbeat, control)) continue;
                    break;
                }
                if ((os::GetSystemTick() - g_last_keepalive).ToTimeSpan() >= KeepAliveInterval) {
                    g_last_keepalive = os::GetSystemTick();
                    if (!SendFrame(T_Ping, nullptr, 0)) {
                        Log("no se pudo enviar PING; reconectando");
                        if (RecoverTransport(heartbeat, control)) continue;
                        break;
                    }
                    control.Sent(now_ms);
                    if (g_udp_features & CapabilityHeartbeat) {
                        if (heartbeat.NeedsRegistration()) {
                            if (!RegisterUdpAgain(heartbeat)) {
                                if (RecoverTransport(heartbeat, control)) continue;
                                break;
                            }
                        }
                        const u32 heartbeat_nonce = ++g_heartbeat_sequence;
                        u8 nonce[4]; put32(nonce, heartbeat_nonce);
                        heartbeat.Sent(heartbeat_nonce);
                        UdpSend(U_Heartbeat, nonce, sizeof(nonce));
                    } else UdpSend(U_KeepAlive, nullptr, 0);
                    RefreshHostMetadata();
                }
            }
            CloseSockets();
        }

        void LeaveCurrentRoom() {
            {
                std::scoped_lock lk(g_lock);
                if (g_state == RelayState::InRoom) SendFrame(T_Leave, nullptr, 0);
                g_state = RelayState::Idle;
                g_recovering = false;
                g_error[0] = '\0';
                g_host_program_id = 0;
                g_metadata_sent = false;
                g_public_group_sent = false;
                std::memset(g_room_ticket, 0, sizeof(g_room_ticket));
            }
            if (g_thread_started) {
                os::WaitThread(&g_thread);
                os::DestroyThread(&g_thread);
                g_thread_started = false;
            }
            std::scoped_lock lk(g_lock);
            CloseSockets();
        }

        bool MatchJoinPendingLocked(const u8 *owner);
        bool DiscoveryRouteStillSelected(const DiscoveryRoute &route) {
            if (route.selection_epoch) {
                std::scoped_lock lock(g_lock);
                return PinnedRouteCurrentLocked(route);
            }
            DiscoveryRoute current{};
            return CaptureDiscoveryRoute(&current) && current.ipv4 == route.ipv4 &&
                   current.port == route.port && current.public_enabled == route.public_enabled &&
                   std::strcmp(current.provider, route.provider) == 0;
        }

        // Conecta, envía CREATE o JOIN y espera ROOM; luego registra el UDP y arranca el hilo.
        Result Enter(u8 type, const u8 *body, size_t size, const sockaddr_in *pinned = nullptr,
                     u8 *error_code = nullptr, const u8 *owner = nullptr,
                     const DiscoveryRoute *discovery_route = nullptr, GameRoute *joined = nullptr) {
            std::scoped_lock lifecycle_lock(g_room_lifecycle_lock);
            // A game may have resolved its default LCID for this provider.
            // Validate before leaving any existing room, then use this exact
            // snapshot for the handshake instead of re-reading preferences.
            if (discovery_route && (InRoom() || !DiscoveryRouteStillSelected(*discovery_route))) {
                std::scoped_lock lk(g_lock);
                util::Strlcpy(g_error, "Network changed; search again.", sizeof(g_error));
                return ResultRelayFailed();
            }
            if (owner) {
                std::scoped_lock match_lock(g_match_lock);
                if (!MatchJoinPendingLocked(owner) || InRoom()) return ResultRelayFailed();
            }
            LeaveCurrentRoom();
            sockaddr_in server;
            char provider[33] = "self";
            {
                std::scoped_lock lk(g_lock);
                if (!ChooseEnterRoute(pinned, discovery_route, std::addressof(server), provider)) {
                    SetError(ConfigError);
                    R_THROW(ResultRelayFailed());
                }
                g_state = RelayState::Connecting;
                g_recovering = false;
                g_error[0] = '\0';
            }
            Session s;
            bool ok = Handshake(server, type, body, size, std::addressof(s), pinned ? MatchIoTimeoutMs : ConnectTimeoutMs, provider);
            const bool exact_discovery = type == T_Join && discovery_route && discovery_route->selected_game_id;
            if (ok && (owner || exact_discovery) &&
                (std::memcmp(s.reply, body, CodeLength) != 0 || le64(s.reply + 15) != le64(body + 38))) {
                SendFrameTo(s.tcp, T_Leave, nullptr, 0, nullptr, 0);
                ::close(s.tcp);
                ::close(s.udp);
                util::Strlcpy(s.error, owner ? "Relay joined a different room than reserved." : "Network changed; search again.",
                              sizeof(s.error));
                s.error_code = 0xff;
                ok = false;
            }
            std::unique_lock match_lock(g_match_lock, std::defer_lock);
            if (owner) {
                match_lock.lock();
                if (!MatchJoinPendingLocked(owner)) {
                    match_lock.unlock();
                    if (ok) {
                        SendFrameTo(s.tcp, T_Leave, nullptr, 0, nullptr, 0);
                        ::close(s.tcp);
                        ::close(s.udp);
                    }
                    std::scoped_lock lk(g_lock);
                    g_state = RelayState::Idle;
                    return ResultRelayFailed();
                }
            }
            std::unique_lock lk(g_lock);
            if (ok && discovery_route && discovery_route->selection_epoch && !PinnedRouteCurrentLocked(*discovery_route)) {
                lk.unlock();
                SendFrameTo(s.tcp, T_Leave, nullptr, 0, nullptr, 0);
                ::close(s.tcp);
                ::close(s.udp);
                lk.lock();
                util::Strlcpy(s.error, "Network changed; search again.", sizeof(s.error));
                s.error_code = 0xff;
                ok = false;
            }
            if (!ok) {
                if (error_code) *error_code = s.error_code;
                Log("entrar en la sala falló: %s", s.error);
                SetError(s.error);
                R_THROW(ResultRelayFailed());
            }
            std::memset(g_members, 0, sizeof(g_members));
            g_sent = g_received = 0;
            {
                std::scoped_lock qlk(g_queue_lock);
                g_queue.Clear();
                g_control_head = g_control_count = 0;
            }
            g_server = server;
            if (owner) std::memcpy(g_room_ticket, owner, sizeof(g_room_ticket));
            Install(s);
            Log("en la sala %s como miembro %u", g_code, g_my_index);
            g_state = RelayState::InRoom;
            if (owner || (discovery_route && discovery_route->selection_epoch))
                ClearSelectionLocked();
            if (joined) {
                *joined = {};
                joined->discovery.ipv4 = g_server.sin_addr.s_addr;
                joined->discovery.port = g_server.sin_port;
                joined->discovery.public_enabled = g_public;
                util::Strlcpy(joined->discovery.provider, g_room_provider, sizeof(joined->discovery.provider));
                joined->room_epoch = g_stream_epoch.load();
                joined->room_token = g_token;
                std::memcpy(joined->room_code, g_code, CodeLength);
            }
            g_last_keepalive = os::GetSystemTick();
            R_ABORT_UNLESS(os::CreateThread(std::addressof(g_thread), Worker, nullptr, g_thread_stack, sizeof(g_thread_stack), 10));
            os::SetThreadNamePointer(std::addressof(g_thread), "lanywhere::Relay");
            os::StartThread(std::addressof(g_thread));
            g_thread_started = true;
            R_SUCCEED();
        }

    }

    bool CaptureDiscoveryRoute(DiscoveryRoute *out) {
        if (!out) return false;
        *out = {};
        sockaddr_in server{};
        std::scoped_lock lock(g_lock);
        if (!LoadServer(&server, out->provider)) return false;
        out->ipv4 = server.sin_addr.s_addr;
        out->port = server.sin_port;
        out->public_enabled = g_public;
        return true;
    }

    bool CaptureGameRoute(GameRoute *out) {
        if (!out) return false;
        *out = {};
        std::scoped_lock lock(g_lock);
        if (g_state == RelayState::InRoom) {
            if (!g_stream_ready.load() || g_recovering) return false;
            out->discovery.ipv4 = g_server.sin_addr.s_addr;
            out->discovery.port = g_server.sin_port;
            out->discovery.public_enabled = g_public;
            util::Strlcpy(out->discovery.provider, g_room_provider, sizeof(out->discovery.provider));
            out->room_epoch = g_stream_epoch.load();
            out->room_token = g_token;
            std::memcpy(out->room_code, g_code, CodeLength);
            return true;
        }
        if (g_state == RelayState::Connecting) return false;
        if (g_selection.selection_epoch) {
            if (!PinnedRouteCurrentLocked(g_selection)) return false;
            out->discovery = g_selection;
            return true;
        }
        sockaddr_in server{};
        if (!LoadServer(&server, out->discovery.provider)) return false;
        out->discovery.ipv4 = server.sin_addr.s_addr;
        out->discovery.port = server.sin_port;
        out->discovery.public_enabled = g_public;
        return true;
    }

    bool CaptureHostGameRoute(GameRoute *out) {
        if (!out) return false;
        // Preserve the existing session if the game opens an access point in it.
        if (InRoom() && CaptureGameRoute(out) && out->room_epoch) return true;
        *out = {};
        sockaddr_in server{};
        std::scoped_lock lock(g_lock);
        if (g_state == RelayState::Connecting || g_state == RelayState::InRoom || !LoadServer(&server)) return false;
        out->discovery.ipv4 = server.sin_addr.s_addr;
        out->discovery.port = server.sin_port;
        out->discovery.public_enabled = true;
        util::Strlcpy(out->discovery.provider, "self", sizeof(out->discovery.provider));
        out->discovery.selection_epoch = HostRouteEpoch;
        return true;
    }

    bool GameRouteStillCurrent(const GameRoute &route) {
        GameRoute current{};
        const bool captured = route.discovery.selection_epoch == HostRouteEpoch ?
            CaptureHostGameRoute(&current) : CaptureGameRoute(&current);
        return captured && current.room_epoch == route.room_epoch && current.room_token == route.room_token &&
            current.discovery.selection_epoch == route.discovery.selection_epoch &&
            std::memcmp(current.room_code, route.room_code, CodeLength) == 0 &&
            current.discovery.ipv4 == route.discovery.ipv4 && current.discovery.port == route.discovery.port &&
            std::strcmp(current.discovery.provider, route.discovery.provider) == 0 &&
            (route.room_epoch || current.discovery.public_enabled == route.discovery.public_enabled);
    }

    void Nickname(char *out, size_t size) {
        std::scoped_lock lk(g_lock);
        if (!LoadServer()) {
            util::Strlcpy(out, "Player", size);
            return; // Do not append to unreadable or damaged preferences.
        }
        if (!g_nick[0]) {
            // Primera vez: uno al azar, amable y sin datos de nadie; la app permite cambiarlo.
            static const char *const animals[] = { "Tigre", "Zorro", "Panda", "Lobo", "Koala", "Gato", "Conejo", "Tortuga",
                                                   "Pulpo", "Mapache", "Puma", "Jaguar", "Nutria", "Oso", "Pato", "Gallo" };
            static const char *const traits[] = { "Veloz", "Valiente", "Feliz", "Turbo", "Estelar", "Audaz", "Genial",
                                                  "Ninja", "Fugaz", "Rebelde", "Gigante", "Brillante" };
            u8 r[3];
            os::GenerateRandomBytes(r, sizeof(r));
            util::SNPrintf(g_nick, sizeof(g_nick), "%s %s %u", animals[r[0] % 16], traits[r[1] % 12], 10 + r[2] % 90);
            char line[NickLength + 16];
            const int len = util::SNPrintf(line, sizeof(line), "\napodo=%s\n", g_nick);
            static_cast<void>(fs::CreateDirectory("sdmc:/lanywhere"));
            fs::FileHandle file;
            if (R_FAILED(fs::OpenFile(std::addressof(file), ConfigPath, fs::OpenMode_Write | fs::OpenMode_AllowAppend))) {
                static_cast<void>(fs::CreateFile(ConfigPath, 0));
            }
            if (R_SUCCEEDED(fs::OpenFile(std::addressof(file), ConfigPath, fs::OpenMode_Write | fs::OpenMode_AllowAppend))) {
                s64 at = 0;
                if (R_SUCCEEDED(fs::GetFileSize(std::addressof(at), file)) &&
                    at <= MaxConfigSize - (len - (at == 0))) {
                    static_cast<void>(fs::WriteFile(file, at, line + (at == 0), len - (at == 0), fs::WriteOption::Flush));
                }
                fs::CloseFile(file);
            }
        }
        util::Strlcpy(out, g_nick, size);
    }

    Result CreateRoom(u64 game_id, const DiscoveryRoute *route, GameRoute *joined) {
        if (joined) *joined = {};
        GameRoute host{};
        if (!route) {
            if (!CaptureHostGameRoute(&host) || host.room_epoch) return ResultRelayFailed();
            route = &host.discovery;
        }
        if (!DiscoveryRouteStillSelected(*route)) {
            std::scoped_lock lk(g_lock);
            util::Strlcpy(g_error, "Network changed; search again.", sizeof(g_error));
            return ResultRelayFailed();
        }
        CancelMatch();
        u8 body[8 + NickLength + 1] = {};
        put64(body, game_id);
        Nickname(reinterpret_cast<char *>(body + 8), NickLength);
        body[8 + NickLength] = Features;
        R_RETURN(Enter(T_Create, body, sizeof(body), nullptr, nullptr, nullptr, route, joined));
    }

    Result JoinRoom(const char *code, u64 game_id, const DiscoveryRoute *route, GameRoute *joined) {
        if (joined) *joined = {};
        if (route && (!DiscoveryRouteStillSelected(*route) ||
            (route->selected_game_id && (route->selected_game_id != game_id ||
             std::strcmp(route->selected_code, code) != 0)))) {
            std::scoped_lock lock(g_lock);
            util::Strlcpy(g_error, "Network changed; search again.", sizeof(g_error));
            if (g_state != RelayState::InRoom) g_state = RelayState::Error;
            return ResultRelayFailed();
        }
        if (MatchArmed()) CancelMatch();
        u8 body[CodeLength + NickLength + 8 + 1] = {};
        std::memcpy(body, code, std::min(std::strlen(code), CodeLength));
        Nickname(reinterpret_cast<char *>(body + CodeLength), NickLength);
        put64(body + CodeLength + NickLength, game_id);
        body[CodeLength + NickLength + 8] = Features;
        R_RETURN(Enter(T_Join, body, sizeof(body), nullptr, nullptr, nullptr, route, joined));
    }

    void LeaveRoom() {
        std::scoped_lock lifecycle_lock(g_room_lifecycle_lock);
        LeaveCurrentRoom();
    }

    void LeaveGameRoom(const GameRoute &owned) {
        std::scoped_lock lifecycle_lock(g_room_lifecycle_lock);
        {
            std::scoped_lock lock(g_lock);
            // A reconnect may change the transport epoch, but not room identity.
            // Never evict a user's replacement room while unwinding old setup.
            if (!owned.room_token || g_token != owned.room_token ||
                std::memcmp(g_code, owned.room_code, CodeLength) != 0 ||
                g_server.sin_addr.s_addr != owned.discovery.ipv4 || g_server.sin_port != owned.discovery.port ||
                std::strcmp(g_room_provider, owned.discovery.provider)) return;
        }
        LeaveCurrentRoom();
    }

    void GetStatus(Status *out) {
        std::scoped_lock lk(g_lock);
        std::memset(out, 0, sizeof(*out));
        out->state = g_state == RelayState::InRoom && g_recovering ? RelayState::Connecting : g_state;
        out->my_index = g_my_index;
        for (const auto &m : g_members) {
            out->member_count += m.present;
        }
        out->my_ip = g_my_ip;
        std::memcpy(out->code, g_code, CodeLength + 1);
        out->game_id = g_game_id;
        out->packets_sent = g_sent;
        out->packets_received = g_received;
        util::Strlcpy(out->error, g_error, sizeof(out->error));
        if (g_state == RelayState::Idle || g_state == RelayState::Error) {
            sockaddr_in server;
            if (!LoadServer(std::addressof(server))) {
                out->state = RelayState::Error;
                util::Strlcpy(out->error, ConfigError, sizeof(out->error));
            } else if (std::strcmp(out->error, ConfigError) == 0) {
                out->state = RelayState::Idle;
                out->error[0] = '\0';
            }
        }
    }

    bool InRoom() {
        std::scoped_lock lk(g_lock);
        return g_state == RelayState::InRoom;
    }

    u32 RoomTag() {
        std::scoped_lock lk(g_lock);
        u32 h = 2166136261u;  // FNV-1a
        for (size_t i = 0; i < CodeLength; i++) {
            h = (h ^ static_cast<u8>(g_code[i])) * 16777619u;
        }
        return h;
    }

    u32 MyIp() {
        std::scoped_lock lk(g_lock);
        return g_my_ip;
    }

    bool CaptureTcpTransport(u64 *epoch,u32 *capabilities,u32 *self_ip) {
        if(!epoch||!capabilities||!self_ip)return false;
        std::scoped_lock lk(g_lock);
        if(g_state!=RelayState::InRoom||!g_stream_ready.load())return false;
        *epoch=g_stream_epoch.load();*capabilities=g_capabilities;*self_ip=g_my_ip;return true;
    }

    bool SendTcpFrame(u64 epoch,const void *body,size_t size) {
        tcpstream::Frame frame;
        if(!tcpstream::Parse(body,size,&frame))return false;
        std::scoped_lock lk(g_send_lock);
        // A stale worker must never tear down a newly installed room socket.
        if(!g_stream_ready.load()||g_stream_epoch.load()!=epoch||g_tcp<0)return false;
        if(SendFrameTo(g_tcp,tcpstream::Command,body,size,nullptr,0))return true;
        // A partial frame cannot be retried on this byte stream. Closing its
        // current transport causes the server to reset remote stream state.
        g_stream_ready=false;
        ::shutdown(g_tcp,SHUT_RDWR);
        return false;
    }

    void ReportTcpUnavailable() {
        std::scoped_lock lock(g_lock);
        if(g_state==RelayState::InRoom&&!(g_capabilities&tcpstream::Capability))
            util::Strlcpy(g_error,"Game TCP is unavailable on this network.",sizeof(g_error));
    }

    u32 Netmask() {
        return (g_net_ip.load() & 0xFFFF0000u) == LanPlayNet ? 0xFFFF0000u : 0xFFFFFF00u;
    }

    bool IsVirtual(u32 ip) {
        const u32 mine = g_net_ip.load(), mask = Netmask();
        return (ip & mask) == (mine ? mine & mask : VirtualNet) || ip == 0xFFFFFFFFu;
    }

    int MemberOfIp(u32 ip) {
        std::scoped_lock lk(g_lock);
        for (const Member &m : g_members) {
            if (m.present && m.ip == ip) return m.index;
        }
        return -1;
    }

    bool SendData(u32 dst_ip, u16 src_port, u16 dst_port, const void *data, size_t size) {
        if (size > MaxUdpPayload) { errno = EMSGSIZE; return false; }
        u8 body[8 + 1455];
        const u32 mask = Netmask();
        put32(body, dst_ip == 0xFFFFFFFFu ? ((g_net_ip.load() & mask) | ~mask) : dst_ip);
        put16(body + 4, src_port);
        put16(body + 6, dst_port);
        std::scoped_lock lk(g_lock);
        if (g_state == RelayState::InRoom) {
            const auto mode = ChooseSendMode(size, (g_udp_features & CapabilityFragment) != 0);
            if (mode == SendMode::Legacy) {
                if (size) std::memcpy(body + 8, data, size);
                if (UdpSend(U_Data, body, 8 + size)) { g_sent++; return true; }
                errno = EHOSTUNREACH;
                return false;
            }
            if (mode == SendMode::TooLarge) {
                util::Strlcpy(g_error, "Update relay for larger game packets.", sizeof(g_error));
                errno = EMSGSIZE; return false;
            }
            const u32 id = ++g_fragment_id;
            if (!WriteFragments(le32(body), src_port, dst_port, id, static_cast<const u8 *>(data), size,
                [](const u8 *p, size_t n) { return UdpSend(U_DataFragment, p, n); })) {
                errno = EHOSTUNREACH; return false;
            }
            g_sent++;
            return true;
        }
        errno = EHOSTUNREACH;
        return false;
    }

    void Log(const char *fmt, ...) {
        char line[200];
        std::va_list vl;
        va_start(vl, fmt);
        const int len = util::VSNPrintf(line, sizeof(line) - 1, fmt, vl);
        va_end(vl);
        if (len <= 0) {
            return;
        }
        const int n = std::min<int>(len, sizeof(line) - 2);
        line[n] = '\n';
        std::scoped_lock lk(g_log_lock);
        fs::FileHandle file;
        if (R_FAILED(fs::OpenFile(std::addressof(file), LogPath, fs::OpenMode_Write | fs::OpenMode_AllowAppend))) {
            static_cast<void>(fs::CreateDirectory("sdmc:/lanywhere"));
            if (R_FAILED(fs::CreateFile(LogPath, 0)) || R_FAILED(fs::OpenFile(std::addressof(file), LogPath, fs::OpenMode_Write | fs::OpenMode_AllowAppend))) {
                return;
            }
        }
        s64 size = 0;
        if (R_SUCCEEDED(fs::GetFileSize(std::addressof(size), file)) && size < 256 * 1024) {
            static_cast<void>(fs::WriteFile(file, size, line, n + 1, fs::WriteOption::Flush));
        }
        fs::CloseFile(file);
    }

    bool PublicEnabled() {
        std::scoped_lock lk(g_lock);
        // Force subsequent Enter/discovery validation to fail instead of
        // silently falling back to a local-only room on damaged settings.
        if (!LoadServer()) return true;
        return g_public;
    }

    void Publish(const void *network_info, size_t size, u64 host_program_id) {
        {
            std::scoped_lock lifecycle(g_room_lifecycle_lock);
            std::scoped_lock lock(g_lock);
            if (g_state != RelayState::InRoom || g_my_index != 0 ||
                (size && (size != NetworkInfoSize || !network_info || le64(static_cast<const u8 *>(network_info)) != g_game_id))) return;
            g_host_program_id = size ? host_program_id : 0;
            if (!size) {
                g_metadata_sent = false;
                g_public_group_sent = false;
            }
            if (SendFrame(T_Publish, network_info, size) && size) g_public_group_sent = true;
        }
        if (size) RefreshHostMetadata();
    }

    namespace {
        constexpr s64 WaitForGameMs = 90'000;
        constexpr s64 SearchWindowMs = 45'000;
        constexpr s64 PollIntervalMs = 1000;
        constexpr u32 KnownScanFlags = ldn::ScanFilterFlag_LocalCommunicationId | ldn::ScanFilterFlag_SessionId |
            ldn::ScanFilterFlag_NetworkType | ldn::ScanFilterFlag_Ssid | ldn::ScanFilterFlag_SceneId;

        struct MatchTicket {
            sockaddr_in server;
            u8 id[MatchTicketSize];
            bool sent;
        };

        struct MatchIntent {
            MatchStatus status;
            MatchTicket ticket;
            os::Tick state_start{0}, last_poll{0};
            s64 budget_ms;
            bool polled, in_flight, checked_caps, has_version;
            u16 version;
            char exact[CodeLength + 1];
            u8 room_grant[ROOM_ACCESS_GRANT_SIZE];
            u8 filter[MatchFilterSize];
            ldn::NetworkInfo network;
        };

        MatchIntent g_match;
        MatchTicket g_release_next;

        bool ValidCode(const char *code) {
            if (!code || std::strlen(code) != CodeLength) return false;
            for (size_t i = 0; i < CodeLength; i++) {
                if (!((code[i] >= 'A' && code[i] <= 'Z' && code[i] != 'I' && code[i] != 'O') ||
                      (code[i] >= '2' && code[i] <= '9'))) return false;
            }
            return true;
        }

        bool ArmedLocked() {
            return g_match.status.mode != MatchMode::Manual && g_match.status.state != MatchState::Joined;
        }

        void SetMatchState(MatchState state, const char *error = "", s64 budget_ms = 0) {
            g_match.status.state = state;
            g_match.state_start = os::GetSystemTick();
            g_match.budget_ms = budget_ms;
            util::Strlcpy(g_match.status.error, error, sizeof(g_match.status.error));
        }

        s64 MatchRemainingMs() {
            if (!g_match.budget_ms) return 0;
            const s64 remaining = g_match.budget_ms - (os::GetSystemTick() - g_match.state_start).ToTimeSpan().GetMilliSeconds();
            if (remaining > 0) return remaining;
            SetMatchState(MatchState::Expired, "Match expired. Retry or cancel.");
            return 0;
        }

        bool SameTicket(const MatchTicket &ticket) {
            return std::memcmp(g_match.ticket.id, ticket.id, MatchTicketSize) == 0;
        }

        bool MatchJoinPendingLocked(const u8 *owner) {
            return g_match.status.state == MatchState::Joining &&
                std::memcmp(g_match.ticket.id, owner, MatchTicketSize) == 0;
        }

        bool QueryCapabilities(int fd, u32 *flags, int timeout_ms, u32 *status) {
            *flags = 0;
            if (status) *status = ListStatusNetwork;
            u8 type, reply[128];
            if (!SendFrameTo(fd, T_Caps, nullptr, 0, nullptr, 0)) return false;
            const ssize_t n = ReadListFrame(fd, &type, reply, sizeof(reply), timeout_ms, status);
            if (n >= 1 && type == T_Error) {
                // Only an unsupported-command reply identifies a legacy relay.
                // Busy, paused and transport failures are not capability absence.
                if (reply[0] != 4) {
                    if (status) *status = lanywhere_list_error_status(reply[0]);
                    return false;
                }
                if (status) *status = ListStatusOk;
                return true;
            }
            if (n != 4 || type != T_CapsReply) return false;
            *flags = le32(reply);
            if (status) *status = ListStatusOk;
            return true;
        }

        void ReleaseTicket(const MatchTicket &ticket) {
            if (!ticket.sent) return;
            const char *error = nullptr;
            const int fd = ConnectServer(ticket.server, &error, MatchIoTimeoutMs);
            if (fd < 0) return;
            if (SendFrameTo(fd, T_Cancel, ticket.id, sizeof(ticket.id), nullptr, 0)) {
                u8 type, reply[16];
                static_cast<void>(ReadFrame(fd, &type, reply, sizeof(reply), MatchIoTimeoutMs));
            }
            ::close(fd);
        }

        void NewTicketLocked() {
            do {
                os::GenerateRandomBytes(g_match.ticket.id, sizeof(g_match.ticket.id));
            } while (le64(g_match.ticket.id) == 0 && le64(g_match.ticket.id + 8) == 0);
            g_match.ticket.sent = false;
            g_match.polled = g_match.in_flight = false;
        }

        bool MakeMatchFilter(const ldn::ScanFilter &filter, u8 (&out)[MatchFilterSize]) {
            const u32 flags = filter.flag;
            const auto &id = filter.networkId;
            if ((flags & ~KnownScanFlags) || !(flags & ldn::ScanFilterFlag_LocalCommunicationId) ||
                id.intentId.localCommunicationId == 0 || id.intentId.localCommunicationId == UINT64_MAX) return false;
            put64(out, id.intentId.localCommunicationId);
            if (flags & ldn::ScanFilterFlag_SceneId) put16(out + 10, id.intentId.sceneId);
            if (flags & ldn::ScanFilterFlag_SessionId) {
                put64(out + 16, id.sessionId.high);
                put64(out + 24, id.sessionId.low);
            }
            if (flags & ldn::ScanFilterFlag_NetworkType) put32(out + 32, filter.networkType);
            if (flags & ldn::ScanFilterFlag_Ssid) {
                if (filter.ssid.length > ldn::SsidLengthMax) return false;
                out[42] = filter.ssid.length;
                std::memcpy(out + 43, filter.ssid.raw, out[42]);
            }
            put32(out + 92, flags);
            return true;
        }

        bool MatchesFilter(const ldn::NetworkInfo &info, const u8 *filter) {
            const u32 flags = le32(filter + 92);
            const auto &id = info.networkId;
            return id.intentId.localCommunicationId == le64(filter) &&
                (!(flags & ldn::ScanFilterFlag_SceneId) || id.intentId.sceneId == le16(filter + 10)) &&
                (!(flags & ldn::ScanFilterFlag_SessionId) ||
                    (id.sessionId.high == le64(filter + 16) && id.sessionId.low == le64(filter + 24))) &&
                (!(flags & ldn::ScanFilterFlag_NetworkType) || info.common.networkType == le32(filter + 32)) &&
                (!(flags & ldn::ScanFilterFlag_Ssid) || (info.common.ssid.length == filter[42] &&
                    std::memcmp(info.common.ssid.raw, filter + 43, filter[42]) == 0));
        }

        void LearnVersionLocked(u16 version) {
            if (g_match.status.mode == MatchMode::Exact) {
                g_match.ticket.sent = false;
                SetMatchState(MatchState::Error, "Selected room uses a different game version.");
                return;
            }
            g_match.has_version = true;
            g_match.version = version;
            NewTicketLocked();
            g_match.status.room[0] = '\0';
            g_match.status.players = g_match.status.target = 0;
            SetMatchState(MatchState::Searching, "Searching using the game's communication version.", SearchWindowMs);
        }
    }

    Result StartMatch(MatchMode mode, const char *code, const u8 *grant, const DiscoveryRoute *authorized_route) {
        if ((mode != MatchMode::Quick && mode != MatchMode::Exact) ||
            (mode == MatchMode::Exact && !ValidCode(code)) ||
            (grant && !authorized_route) || (authorized_route && mode != MatchMode::Exact) || InRoom())
            return ResultRelayFailed();

        sockaddr_in server;
        bool configured;
        char provider[33];
        {
            std::scoped_lock lk(g_lock);
            configured = LoadServer(&server, provider);
            if (!authorized_route && configured && std::strcmp(provider, "self")) return ResultRelayFailed();
            if (authorized_route && (!configured || std::strcmp(authorized_route->provider, "self") ||
                authorized_route->ipv4 != server.sin_addr.s_addr || authorized_route->port != server.sin_port))
                return ResultRelayFailed();
        }
        MatchTicket old{}, pending{};
        {
            std::scoped_lock lk(g_match_lock);
            {
                std::scoped_lock lock(g_lock);
                if (g_state == RelayState::InRoom || g_state == RelayState::Connecting) return ResultRelayFailed();
                if (authorized_route) {
                    sockaddr_in current{};
                    if (!LoadServer(&current) || current.sin_addr.s_addr != authorized_route->ipv4 ||
                        current.sin_port != authorized_route->port) return ResultRelayFailed();
                    auto route = *authorized_route;
                    route.public_enabled = true;
                    SelectRouteLocked(route, code);
                } else {
                    ClearSelectionLocked();
                }
            }
            old = g_match.ticket;
            pending = g_release_next;
            g_release_next = {};
            g_match = {};
            g_match.status.mode = mode;
            if (mode == MatchMode::Exact) {
                util::Strlcpy(g_match.exact, code, sizeof(g_match.exact));
                util::Strlcpy(g_match.status.room, code, sizeof(g_match.status.room));
                if (grant) std::memcpy(g_match.room_grant, grant, sizeof(g_match.room_grant));
            }
            if (configured) {
                g_match.ticket.server = server;
                NewTicketLocked();
                SetMatchState(MatchState::WaitingForGame, "", WaitForGameMs);
            } else {
                SetMatchState(MatchState::Error, ConfigError);
            }
        }
        ReleaseTicket(old);
        ReleaseTicket(pending);
        if (!configured) return ResultRelayFailed();
        R_SUCCEED();
    }

    void CancelMatch() {
        MatchTicket old{}, pending{};
        {
            std::scoped_lock lk(g_match_lock);
            old = g_match.ticket;
            pending = g_release_next;
            g_release_next = {};
            g_match = {};
            SetMatchState(MatchState::Cancelled);
            std::scoped_lock lock(g_lock);
            ClearSelectionLocked();
        }
        ReleaseTicket(old);
        ReleaseTicket(pending);
    }

    Result SelectUnifiedRoom(const UnifiedRoomRequest &request) {
        const auto *provider_end = static_cast<const char *>(std::memchr(request.provider, 0, sizeof(request.provider)));
        if (!request.game_id || request.code[6] || request.code[7] || !ValidCode(request.code) ||
            !provider_end || provider_end == request.provider ||
            !std::all_of(provider_end, request.provider + sizeof(request.provider), [](char c) { return c == 0; }) ||
            !std::all_of(std::begin(request.reserved), std::end(request.reserved), [](u8 value) { return value == 0; }))
            return ResultRelayFailed();
        DiscoveryRoute route{};
        {
            std::scoped_lock lock(g_lock);
            sockaddr_in server{};
            if (g_state == RelayState::InRoom || g_state == RelayState::Connecting || !LoadServer(&server))
                return ResultRelayFailed();
            route.ipv4 = server.sin_addr.s_addr;
            route.port = server.sin_port;
            route.public_enabled = true;
            route.selected_game_id = request.game_id;
            util::Strlcpy(route.provider, request.provider, sizeof(route.provider));
        }
        sockaddr_in endpoint{};
        char provider[33]{};
        if (!ResolveDiscoveryRoute(route, &endpoint, provider)) return ResultRelayFailed();
        if (!std::strcmp(provider, "self")) {
            if (request.game_id == UINT64_MAX) return ResultRelayFailed();
            R_RETURN(StartMatch(MatchMode::Exact, request.code, nullptr, &route));
        }

        MatchTicket old{}, pending{};
        {
            std::scoped_lock match_lock(g_match_lock);
            std::scoped_lock lock(g_lock);
            sockaddr_in current{};
            if (g_state == RelayState::InRoom || g_state == RelayState::Connecting ||
                !LoadServer(&current) || current.sin_addr.s_addr != route.ipv4 || current.sin_port != route.port)
                return ResultRelayFailed();
            old = g_match.ticket;
            pending = g_release_next;
            g_release_next = {};
            g_match = {};
            SelectRouteLocked(route, request.code);
        }
        ReleaseTicket(old);
        ReleaseTicket(pending);
        R_SUCCEED();
    }

    void ReportGameNetworkError(bool unavailable) {
        const char *error = unavailable ? "Reopen LANywhere to read game information." :
                                          "Game network ID is not allowed.";
        // Stop an armed search before its worker can send an unresolved ticket.
        // Do not issue network traffic merely to report a local identity failure.
        {
            std::scoped_lock lock(g_match_lock);
            if (ArmedLocked()) SetMatchState(MatchState::Error, error);
        }
        std::scoped_lock lock(g_lock);
        util::Strlcpy(g_error, error, sizeof(g_error));
        if (g_state != RelayState::InRoom) g_state = RelayState::Error;
    }

    void ReportGameRouteChanged() {
        std::scoped_lock lock(g_lock);
        if (g_recovering) return;
        util::Strlcpy(g_error, "Network changed; search again.", sizeof(g_error));
        if (g_state != RelayState::InRoom) g_state = RelayState::Error;
    }

    void GetMatchStatus(MatchStatus *out) {
        std::scoped_lock lk(g_match_lock);
        const s64 remaining = MatchRemainingMs();
        if (g_match.status.mode == MatchMode::Manual) {
            std::scoped_lock room_lock(g_lock);
            if (g_selection.selection_epoch && std::strcmp(g_selection.provider, "self")) {
                const u64 now = SelectionNowMs();
                const bool live = PinnedRouteCurrentLocked(g_selection);
                *out = {};
                out->mode = MatchMode::Exact;
                out->state = live ? MatchState::WaitingForGame : MatchState::Expired;
                out->game_id = g_selection.selected_game_id;
                out->ttl_seconds = live ? static_cast<u32>((g_selection_until_ms - now + 999) / 1000) : 0;
                util::Strlcpy(out->room, g_selection.selected_code, sizeof(out->room));
                return;
            }
        }
        if (g_match.status.state == MatchState::Joined) {
            std::scoped_lock room_lock(g_lock);
            if (g_state != RelayState::InRoom || std::memcmp(g_room_ticket, g_match.ticket.id, sizeof(g_room_ticket)) != 0) {
                g_match = {};
            } else {
                g_match.status.players = 0;
                for (const auto &member : g_members) g_match.status.players += member.present;
            }
        }
        *out = g_match.status;
        out->ttl_seconds = static_cast<u32>((remaining + 999) / 1000);
    }

    bool MatchArmed() {
        std::scoped_lock lk(g_match_lock);
        return ArmedLocked();
    }

    MatchScanResult ScanMatch(const ldn::ScanFilter &filter, ldn::NetworkInfo *out, const DiscoveryRoute *route) {
        u8 encoded[MatchFilterSize] = {};
        const bool valid = MakeMatchFilter(filter, encoded);
        bool started = false;
        {
            std::scoped_lock lk(g_match_lock);
            if (!ArmedLocked()) return MatchScanResult::Manual;
            if (route && (std::strcmp(route->provider, "self") ||
                route->ipv4 != g_match.ticket.server.sin_addr.s_addr || route->port != g_match.ticket.server.sin_port)) {
                SetMatchState(MatchState::Error, "Network changed; search again.");
                return MatchScanResult::Empty;
            }
            const s64 remaining = MatchRemainingMs();
            if (route && route->selected_game_id && (!valid || le64(encoded) != route->selected_game_id))
                return MatchScanResult::Empty;
            if (!valid) {
                if (g_match.status.state == MatchState::WaitingForGame) {
                    util::Strlcpy(g_match.status.error, "Waiting for a game-specific local wireless search.",
                                  sizeof(g_match.status.error));
                }
                return MatchScanResult::Empty;
            }
            if (g_match.status.state == MatchState::WaitingForGame) {
                g_match.status.game_id = le64(encoded);
                std::memcpy(g_match.filter, encoded, sizeof(encoded));
                SetMatchState(MatchState::Searching, "", SearchWindowMs);
                started = true;
            } else if (g_match.status.state == MatchState::Searching && !g_match.in_flight && !g_release_next.sent &&
                       std::memcmp(g_match.filter, encoded, sizeof(encoded)) != 0) {
                // A ticket cannot change its constraints once the relay has seen it.
                g_release_next = g_match.ticket;
                if (g_match.status.game_id != le64(encoded) || le16(g_match.filter + 10) != le16(encoded + 10)) {
                    g_match.has_version = false;
                    g_match.version = 0;
                }
                NewTicketLocked();
                g_match.status.game_id = le64(encoded);
                std::memcpy(g_match.filter, encoded, sizeof(encoded));
                SetMatchState(MatchState::Searching, "", remaining);
            }
        }

        // Let the existing LAN worker make the request. Native Scan can return promptly even on a slow relay.
        for (int attempt = 0;; attempt++) {
            {
                std::scoped_lock lk(g_match_lock);
                MatchRemainingMs();
                if (g_match.status.state == MatchState::Assigned) {
                    if (MatchesFilter(g_match.network, encoded)) {
                        g_match.status.error[0] = '\0';
                        *out = g_match.network;
                        return MatchScanResult::Assigned;
                    }
                    util::Strlcpy(g_match.status.error, "Assigned room is for another local wireless search.",
                                  sizeof(g_match.status.error));
                }
                if (!started || attempt == 14 || g_match.status.state != MatchState::Searching) break;
            }
            os::SleepThread(TimeSpan::FromMilliSeconds(25));
        }
        return MatchScanResult::Empty;
    }

    void PollMatch() {
        if (InRoom()) return;
        MatchTicket ticket{};
        constexpr size_t LegacyReserveSize = 122;
        u8 body[LegacyReserveSize + ROOM_ACCESS_GRANT_SIZE] = {};
        size_t body_size = LegacyReserveSize;
        bool checked_caps = false;
        bool release_only = false;
        {
            std::scoped_lock lk(g_match_lock);
            MatchRemainingMs();
            const auto now = os::GetSystemTick();
            if (g_release_next.sent) {
                ticket = g_release_next;
                g_release_next.sent = false;
                release_only = true;
            } else if ((g_match.status.state == MatchState::Expired || g_match.status.state == MatchState::Error) &&
                       g_match.ticket.sent && !g_match.in_flight) {
                ticket = g_match.ticket;
                g_match.ticket.sent = false;
                release_only = true;
            } else {
                if (g_match.status.state != MatchState::Searching || g_match.in_flight ||
                    (g_match.polled && (now - g_match.last_poll).ToTimeSpan().GetMilliSeconds() < PollIntervalMs)) return;
                g_match.ticket.sent = g_match.in_flight = g_match.polled = true;
                g_match.last_poll = now;
                ticket = g_match.ticket;
                checked_caps = g_match.checked_caps;
                std::memcpy(body, ticket.id, sizeof(ticket.id));
                std::memcpy(body + 16, g_match.filter, sizeof(g_match.filter));
                body[112] = g_match.has_version;
                put16(body + 113, g_match.version);
                body[115] = Features;
                std::memcpy(body + 116, g_match.exact, CodeLength);
                if (std::any_of(g_match.room_grant, g_match.room_grant + sizeof(g_match.room_grant), [](u8 v) { return v != 0; })) {
                    std::memcpy(body + LegacyReserveSize, g_match.room_grant, sizeof(g_match.room_grant));
                    body_size = sizeof(body);
                }
            }
        }
        if (release_only) {
            ReleaseTicket(ticket);
            return;
        }

        const char *error = nullptr;
        const int fd = ConnectServer(ticket.server, &error, MatchIoTimeoutMs);
        u8 type = 0, reply[5 + GroupRecordSize] = {};
        ssize_t n = -1;
        bool legacy = false;
        if (fd >= 0) {
            if (!checked_caps) {
                u32 flags;
                const bool have_caps = QueryCapabilities(fd, &flags);
                checked_caps = have_caps && (flags & CapabilityMatch);
                legacy = have_caps && !checked_caps;
            }
            if (checked_caps && SendFrameTo(fd, T_Reserve, body, body_size, nullptr, 0)) {
                n = ReadFrame(fd, &type, reply, sizeof(reply), MatchIoTimeoutMs);
            }
            ::close(fd);
        }

        bool stale = false;
        {
            std::scoped_lock lk(g_match_lock);
            MatchRemainingMs();
            stale = !SameTicket(ticket) || g_match.status.state != MatchState::Searching;
            if (stale && SameTicket(ticket)) {
                g_match.in_flight = false;
                g_match.ticket.sent = false;
            }
            if (!stale) {
                g_match.in_flight = false;
                g_match.checked_caps = checked_caps;
                if (legacy) {
                    SetMatchState(MatchState::Error, "Relay does not support reserved matchmaking.");
                } else if (n < 0) {
                    util::Strlcpy(g_match.status.error, "Relay did not respond. Retrying.", sizeof(g_match.status.error));
                } else if (type == T_Error && n >= 1 && reply[0] == 7) {
                    util::Strlcpy(g_match.status.error, "Relay is busy. Retrying.", sizeof(g_match.status.error));
                } else if (type != T_Reservation || n < 5) {
                    SetMatchState(MatchState::Error, "Relay rejected the matchmaking request.");
                } else if (reply[0] == 0 && n == 5) {
                    g_match.status.error[0] = '\0';
                } else if (reply[0] == 2 && n == 5) {
                    SetMatchState(MatchState::Expired, "Room or reservation is no longer available.");
                } else if (reply[0] == 1 && n == static_cast<ssize_t>(sizeof(reply))) {
                    const u32 ttl_ms = le32(reply + 1);
                    char room[CodeLength + 1] = {};
                    std::memcpy(room, reply + 5, CodeLength);
                    std::memcpy(&g_match.network, reply + 5 + CodeLength, sizeof(g_match.network));
                    const auto &info = g_match.network;
                    if (!ValidCode(room) || (g_match.exact[0] && std::strcmp(room, g_match.exact) != 0) ||
                        !MatchesFilter(info, g_match.filter) || ttl_ms == 0 || ttl_ms > 120'000 ||
                        info.ldn.nodeCount < 1 || info.ldn.nodeCount >= info.ldn.nodeCountMax ||
                        info.ldn.nodeCountMax > MaxMembers || !info.ldn.nodes[0].isConnected ||
                        (g_match.has_version && static_cast<u16>(info.ldn.nodes[0].localCommunicationVersion) != g_match.version)) {
                        SetMatchState(MatchState::Error, "Relay returned an incompatible room.");
                        g_match.ticket.sent = false;
                        stale = true;
                    } else {
                        util::Strlcpy(g_match.status.room, room, sizeof(g_match.status.room));
                        g_match.status.players = info.ldn.nodeCount;
                        g_match.status.target = info.ldn.nodeCountMax;
                        SetMatchState(MatchState::Assigned, "", ttl_ms);
                    }
                } else {
                    SetMatchState(MatchState::Error, "Invalid matchmaking reply.");
                }
            }
        }
        if (stale) ReleaseTicket(ticket);
    }

    Result JoinMatch(const ldn::NetworkInfo &info, u16 actual_version, MatchJoinAttempt *attempt) {
        MatchTicket ticket{};
        char room[CodeLength + 1];
        bool wrong_version;
        {
            std::scoped_lock lk(g_match_lock);
            MatchRemainingMs();
            const auto &selected = g_match.network;
            if (g_match.status.state != MatchState::Assigned ||
                info.networkId.intentId.localCommunicationId != g_match.status.game_id ||
                info.networkId.intentId.sceneId != selected.networkId.intentId.sceneId ||
                !(info.networkId.sessionId == selected.networkId.sessionId) ||
                !(info.common.bssid == selected.common.bssid) ||
                info.ldn.nodes[0].ipv4Address != selected.ldn.nodes[0].ipv4Address) return ResultRelayFailed();

            ticket = g_match.ticket;
            wrong_version = static_cast<u16>(selected.ldn.nodes[0].localCommunicationVersion) != actual_version;
            if (wrong_version) {
                LearnVersionLocked(actual_version);
            } else {
                util::Strlcpy(room, g_match.status.room, sizeof(room));
                SetMatchState(MatchState::Joining);
            }
        }
        if (wrong_version) {
            ReleaseTicket(ticket);
            return ResultRelayFailed();
        }

        u8 body[65] = {};
        std::memcpy(body, room, CodeLength);
        Nickname(reinterpret_cast<char *>(body + CodeLength), NickLength);
        put64(body + 38, info.networkId.intentId.localCommunicationId);
        body[46] = Features;
        std::memcpy(body + 47, ticket.id, sizeof(ticket.id));
        put16(body + 63, actual_version);
        u8 error_code = 0;
        Result result = ResultRelayFailed();
        for (int attempt_index = 0; attempt_index < 3; attempt_index++) {
            {
                std::scoped_lock lk(g_match_lock);
                if (!MatchJoinPendingLocked(ticket.id)) break;
            }
            result = Enter(T_Join, body, sizeof(body), &ticket.server, &error_code, ticket.id);
            if (R_SUCCEEDED(result) || (error_code != 0 && error_code != 7)) break;
            if (attempt_index < 2) os::SleepThread(TimeSpan::FromMilliSeconds(125));
        }

        bool cancelled;
        {
            std::scoped_lock lk(g_match_lock);
            cancelled = !SameTicket(ticket) || g_match.status.state != MatchState::Joining;
            if (!cancelled && R_FAILED(result)) {
                g_match.ticket.sent = false;
                if (error_code == 9) {
                    LearnVersionLocked(actual_version);
                } else if (error_code == 5) {
                    SetMatchState(MatchState::Expired, "Reservation expired. Retry or cancel.");
                } else {
                    SetMatchState(MatchState::Error, "Could not join the assigned room.");
                }
            }
        }
        std::memcpy(attempt->ticket, ticket.id, sizeof(attempt->ticket));
        if (cancelled && R_SUCCEEDED(result)) LeaveMatchRoom(*attempt);
        if (cancelled || R_FAILED(result)) {
            ReleaseTicket(ticket);
            return ResultRelayFailed();
        }
        R_SUCCEED();
    }

    bool MatchJoinPending(const MatchJoinAttempt &attempt) {
        std::scoped_lock lk(g_match_lock);
        if (!MatchJoinPendingLocked(attempt.ticket)) return false;
        std::scoped_lock room_lock(g_lock);
        return g_state == RelayState::InRoom && std::memcmp(g_room_ticket, attempt.ticket, sizeof(g_room_ticket)) == 0;
    }

    bool FinishMatch(const MatchJoinAttempt &attempt, bool joined) {
        bool committed = false;
        {
            std::scoped_lock lk(g_match_lock);
            if (MatchJoinPendingLocked(attempt.ticket)) {
                std::scoped_lock room_lock(g_lock);
                committed = joined && g_state == RelayState::InRoom &&
                    std::memcmp(g_room_ticket, attempt.ticket, sizeof(g_room_ticket)) == 0;
                if (committed) {
                    g_match.ticket.sent = false;
                    SetMatchState(MatchState::Joined);
                } else {
                    SetMatchState(MatchState::Error, "The game did not join the assigned room.");
                }
            }
        }
        if (!committed) LeaveMatchRoom(attempt);
        return committed;
    }

    void LeaveMatchRoom(const MatchJoinAttempt &attempt) {
        std::scoped_lock lifecycle_lock(g_room_lifecycle_lock);
        {
            std::scoped_lock lk(g_lock);
            if (std::memcmp(g_room_ticket, attempt.ticket, sizeof(g_room_ticket)) != 0) return;
        }
        LeaveCurrentRoom();
    }

    namespace {
        int ReadLegacyDiscovery(int fd, u64 local_communication_id, bool from_app,
                                void (*found)(const char *, const void *, void *), void *user) {
            constexpr size_t MaxLegacyGroups = 8;
            static constinit os::SdkMutex legacy_lock;
            static u8 reply[1 + MaxLegacyGroups * GroupRecordSize];
            std::scoped_lock lock(legacy_lock);
            u8 body[8 + CodeLength + 1]{};
            put64(body, local_communication_id);
            body[8 + CodeLength] = from_app ? 1 : 0;
            u8 type = 0;
            ssize_t size = -1;
            if (SendFrameTo(fd, T_Find, body, sizeof(body), nullptr, 0))
                size = ReadFrame(fd, &type, reply, sizeof(reply), ConnectTimeoutMs);
            if (size < 1 || type != T_Groups || reply[0] > MaxLegacyGroups ||
                static_cast<size_t>(size) != 1 + static_cast<size_t>(reply[0]) * GroupRecordSize) return -1;
            const size_t count = reply[0];
            for (size_t i = 0; i < count; ++i) {
                const u8 *record = reply + 1 + i * GroupRecordSize;
                char code[CodeLength + 1]{};
                std::memcpy(code, record, CodeLength);
                if (!ValidCode(code)) return -1;
                found(code, record + CodeLength, user);
            }
            return static_cast<int>(count);
        }

        int ReadPagedDiscovery(int fd, u8 request, const u8 *body, size_t body_size, u32 offset, u32 *next,
                               void (*found)(const char *, const void *, void *), void *user) {
            static constinit os::SdkMutex page_lock;
            static u8 reply[5 + GroupPageSize * GroupRecordSize];
            std::scoped_lock lock(page_lock);
            u8 type = 0;
            ssize_t size = -1;
            if (SendFrameTo(fd, request, body, body_size, nullptr, 0))
                size = ReadFrame(fd, &type, reply, sizeof(reply), MatchIoTimeoutMs);
            if (size < 5 || type != T_Page) return -1;
            const size_t count = reply[4];
            const u32 following = le32(reply);
            if (count > GroupPageSize || static_cast<size_t>(size) != 5 + count * GroupRecordSize ||
                (following != GroupPageEnd && (!count || following <= offset || following - offset != count))) return -1;
            for (size_t i = 0; i < count; ++i) {
                const u8 *record = reply + 5 + i * GroupRecordSize;
                char code[CodeLength + 1]{};
                std::memcpy(code, record, CodeLength);
                if (!ValidCode(code)) return -1;
                found(code, record + CodeLength, user);
            }
            *next = following;
            return static_cast<int>(count);
        }

        int DiscoveryConnection(const DiscoveryRoute *requested, DiscoveryRoute *captured, const char **error) {
            if (requested) *captured = *requested;
            else if (!CaptureDiscoveryRoute(captured)) return -1;
            sockaddr_in server{};
            char provider[33]{};
            if (!ResolveDiscoveryRoute(*captured, &server, provider)) return -1;
            return ConnectServer(server, error, ConnectTimeoutMs, provider);
        }

        int ReadUnfilteredPage(int fd, u32 caps, u64 local_communication_id, u32 offset, u32 *next,
                               bool from_app, void (*found)(const char *, const void *, void *), void *user) {
            if (!(caps & CapabilityPages))
                return offset == 0 ? ReadLegacyDiscovery(fd, local_communication_id, from_app, found, user) : 0;
            u8 body[12];
            put64(body, local_communication_id);
            put32(body + 8, offset);
            return ReadPagedDiscovery(fd, T_FindPage, body, sizeof(body), offset, next, found, user);
        }
    }

    int FindGroups(u64 local_communication_id, void (*found)(const char *code, const void *network_info, void *user), void *user,
                   bool from_app, const DiscoveryRoute *route) {
        if (!found) return -1;
        DiscoveryRoute captured{};
        const char *error = nullptr;
        const int fd = DiscoveryConnection(route, &captured, &error);
        if (fd < 0) return -1;
        const int count = ReadLegacyDiscovery(fd, local_communication_id, from_app, found, user);
        ::close(fd);
        return count;
    }

    int FindGroupsPage(u64 local_communication_id, u32 offset, u32 *next,
                       void (*found)(const char *code, const void *network_info, void *user), void *user,
                       const DiscoveryRoute *route) {
        if (!next || !found) return -1;
        *next = GroupPageEnd;
        DiscoveryRoute captured{};
        const char *error = nullptr;
        const int fd = DiscoveryConnection(route, &captured, &error);
        if (fd < 0) return -1;
        u32 caps = 0;
        const bool queried = QueryCapabilities(fd, &caps, ConnectTimeoutMs);
        const int count = queried ? ReadUnfilteredPage(fd, caps, local_communication_id, offset, next, true, found, user) : -1;
        ::close(fd);
        return count;
    }

    int FindGroupsFilteredPage(const ldn::ScanFilter &filter, u32 offset, u32 *next,
                               void (*found)(const char *code, const void *network_info, void *user), void *user,
                               const DiscoveryRoute *route) {
        if (!next || !found) return -1;
        *next = GroupPageEnd;
        DiscoveryRoute captured{};
        const char *error = nullptr;
        const int fd = DiscoveryConnection(route, &captured, &error);
        if (fd < 0) return -1;
        u32 caps = 0;
        if (!QueryCapabilities(fd, &caps, ConnectTimeoutMs)) { ::close(fd); return -1; }
        u8 encoded[MatchFilterSize]{};
        const bool valid_filter = MakeMatchFilter(filter, encoded);
        int count;
        if (valid_filter && (caps & CapabilityFilteredFind)) {
            u8 body[MatchFilterSize + 5]{};
            std::memcpy(body, encoded, MatchFilterSize);
            body[MatchFilterSize] = Features;
            put32(body + MatchFilterSize + 1, offset);
            count = ReadPagedDiscovery(fd, T_FindFilter, body, sizeof(body), offset, next, found, user);
        } else {
            const u64 id = (filter.flag & ldn::ScanFilterFlag_LocalCommunicationId) ?
                filter.networkId.intentId.localCommunicationId : 0;
            count = ReadUnfilteredPage(fd, caps, id, offset, next, false, found, user);
        }
        ::close(fd);
        return count;
    }

    bool SendControl(u8 dest, LdnMsg msg, const void *data, size_t size, const MatchJoinAttempt *match) {
        std::scoped_lock lk(g_lock);
        if (g_state != RelayState::InRoom ||
            (match && std::memcmp(g_room_ticket, match->ticket, sizeof(g_room_ticket)) != 0)) {
            return false;
        }
        const u8 head[2] = { dest, static_cast<u8>(msg) };
        Log("ldn -> miembro %u: mensaje %u (%zu bytes)", dest, static_cast<u8>(msg), size);
        return SendFrame(T_Relay, head, sizeof(head), data, size);
    }

    ssize_t TakeControl(u8 *from, LdnMsg *msg, void *buffer, size_t size) {
        std::scoped_lock lk(g_queue_lock);
        if (g_control_count == 0) {
            return -1;
        }
        const Control &c = g_controls[g_control_head];
        g_control_head = (g_control_head + 1) % ControlQueueSize;
        g_control_count--;
        *from = c.from;
        *msg = c.msg;
        const size_t n = std::min<size_t>(c.size, size);
        std::memcpy(buffer, c.data, n);
        return static_cast<ssize_t>(c.size);
    }

    ssize_t ReceiveData(u16 port, void *buffer, size_t size, u32 *src_ip, u16 *src_port, bool peek) {
        std::scoped_lock lk(g_queue_lock);
        return g_queue.Take(port, buffer, size, src_ip, src_port, peek);
    }

    bool HasData(u16 port) {
        std::scoped_lock lk(g_queue_lock);
        return g_queue.Has(port);
    }

    namespace {
        void AddCachedIdentity(GroupSummaryV2 &group) {
            if (group.title_en[0] || group.title_zh[0]) return;
            if (!group.game_id || group.game_id == UINT64_MAX) return;
            GameIdentity identity{};
            // program_id here is an untrusted remote claim. Only the locally
            // captured host process may use the cache's exact-program shortcut.
            if (GameIdentityCacheLookup(0, group.game_id, &identity) != GameCacheFound) return;
            group.application_id = identity.application_id;
            std::memcpy(group.title_en, identity.english, sizeof(group.title_en));
            std::memcpy(group.title_zh, identity.chinese, sizeof(group.title_zh));
            group.metadata_flags |= 2; // Exact/unique local NACP relation, not a server authorization.
        }
        bool CleanDisplayField(char *field, size_t size, bool allow_empty) {
            size_t length = 0;
            while (length < size && field[length]) ++length;
            if (length == size) return false;
            if (!length) return allow_empty;
            char clean[128]{};
            if (!game_identity_safe_title(reinterpret_cast<const u8 *>(field), length, clean, std::min(size, sizeof(clean)))) return false;
            std::memset(field, 0, size);
            std::memcpy(field, clean, std::strlen(clean));
            return true;
        }
    }

    namespace {
        bool CaptureAppointmentRoute(DiscoveryRoute *out) {
            sockaddr_in server{};
            std::scoped_lock lock(g_lock);
            if (!LoadServer(&server)) return false;
            *out = {};
            out->ipv4 = server.sin_addr.s_addr;
            out->port = server.sin_port;
            util::Strlcpy(out->provider, "self", sizeof(out->provider));
            return true;
        }

        bool AppointmentBackendCurrent(const DiscoveryRoute &route) {
            DiscoveryRoute current{};
            return CaptureAppointmentRoute(&current) && current.ipv4 == route.ipv4 && current.port == route.port;
        }

        bool ValidAppointmentRequest(const AppointmentRequest &request) {
            const auto *b = reinterpret_cast<const u8 *>(&request);
            const u8 op = b[0];
            if (op < AppointmentList || op > AppointmentUnfollow || b[1] || b[2] || b[3] ||
                !std::any_of(b + 8, b + 24, [](u8 v) { return v != 0; })) return false;
            const u32 offset = le32(b + 4);
            const u64 id = le64(b + 24), starts = le64(b + 32), game = le64(b + 40), app = le64(b + 48);
            if (op == AppointmentList) return !id && !starts && !game && !app;
            if (op == AppointmentCreate) return !offset && !id && starts && game && game != UINT64_MAX;
            return !offset && id && !starts && !game && !app;
        }

        bool ValidAppointmentResponse(const u8 *b, u32 offset) {
            const u32 status = le32(b), count = le32(b + 4), next = le32(b + 8);
            if (status > AppointmentStorage || count > APPOINTMENT_PAGE_SIZE || le32(b + 12) ||
                (status != AppointmentOk && (count || next != APPOINTMENT_END)) ||
                (next != APPOINTMENT_END && (!count || next <= offset || next - offset != count))) return false;
            for (size_t i = 0; i < count; ++i) {
                const u8 *row = b + 24 + i * sizeof(AppointmentRow);
                const u64 id = le64(row), game = le64(row + 16);
                if (!id || !le64(row + 8) || !game || game == UINT64_MAX || row[36] > 1 ||
                    row[37] || row[38] || row[39] || (row[36] && !le32(row + 32))) return false;
                for (size_t j = 0; j < i; ++j)
                    if (le64(b + 24 + j * sizeof(AppointmentRow)) == id) return false;
            }
            // Preserve the server's now field; only unused record storage must be zero.
            return std::all_of(b + 24 + count * sizeof(AppointmentRow), b + sizeof(AppointmentResponse),
                               [](u8 v) { return v == 0; });
        }
    }

    void ExchangeAppointment(const AppointmentRequest &request, AppointmentResponse *response) {
        if (!response) return;
        std::memset(response, 0, sizeof(*response));
        response->status = AppointmentUnavailable;
        response->next = APPOINTMENT_END;
        if (!ValidAppointmentRequest(request)) { response->status = AppointmentInvalid; return; }
        DiscoveryRoute route{};
        if (!CaptureAppointmentRoute(&route)) return;
        sockaddr_in server{};
        char provider[33]{};
        if (!ResolveDiscoveryRoute(route, &server, provider)) return;
        const char *error = nullptr;
        const int fd = ConnectServer(server, &error, ConnectTimeoutMs, "self");
        if (fd < 0) return;
        u8 reply[sizeof(AppointmentResponse)]{}, type = 0;
        ssize_t received = -1;
        if (AppointmentBackendCurrent(route) &&
            SendFrameTo(fd, APPOINTMENT_REQUEST_TYPE, &request, sizeof(request), nullptr, 0))
            received = ReadFrame(fd, &type, reply, sizeof(reply), ConnectTimeoutMs);
        ::close(fd);
        if (!AppointmentBackendCurrent(route) || type != APPOINTMENT_RESPONSE_TYPE ||
            received != static_cast<ssize_t>(sizeof(reply))) return;
        const auto *b = reinterpret_cast<const u8 *>(&request);
        const u32 offset = request.op == AppointmentList ? le32(b + 4) : 0;
        if (ValidAppointmentResponse(reply, offset)) std::memcpy(response, reply, sizeof(*response));
    }


    namespace {
        constexpr int RoomPasscodeTimeoutMs = 1500;

        u32 CapturePasscodeHost(GameRoute *route, u64 *game_id, bool hidden = false) {
            std::scoped_lock lock(g_lock);
            if (g_state != RelayState::InRoom || g_recovering || !g_stream_ready.load())
                return RoomPasscodeRoomUnavailable;
            if (g_my_index != 0) return RoomPasscodeNotHost;
            if (std::strcmp(g_room_provider, "self") || !(g_capabilities & ROOM_PASSCODE_CAPABILITY) ||
                (hidden && !(g_capabilities & ROOM_ACCESS_CAPABILITY))) return RoomPasscodeUnavailable;
            if (!g_public_group_sent || !g_game_id || g_game_id == UINT64_MAX || !g_token)
                return RoomPasscodeRoomUnavailable;
            *route = {};
            route->discovery.ipv4 = g_server.sin_addr.s_addr;
            route->discovery.port = g_server.sin_port;
            util::Strlcpy(route->discovery.provider, "self", sizeof(route->discovery.provider));
            route->room_epoch = g_stream_epoch.load();
            route->room_token = g_token;
            std::memcpy(route->room_code, g_code, CodeLength);
            *game_id = g_game_id;
            return RoomPasscodeOk;
        }

        bool ValidRoomPasscodeText(const char *bytes, size_t length) {
            return length <= ROOM_PASSCODE_MAX &&
                std::all_of(bytes, bytes + length, [](unsigned char c) { return c >= 0x20 && c <= 0x7e; }) &&
                std::all_of(bytes + length, bytes + ROOM_PASSCODE_MAX, [](char c) { return c == 0; });
        }

        bool ValidRoomPasscodeRoom(const char (&room)[8]) {
            return !room[6] && !room[7] && ValidCode(room);
        }

        RoomPasscodeReply ExchangeRoomPasscode(const RoomPasscodeRequest &request, const DiscoveryRoute &route,
                                               const GameRoute *host = nullptr) {
            const RoomPasscodeReply unavailable{RoomPasscodeUnavailable, 0, {}, {}};
            sockaddr_in server{};
            char provider[33]{};
            if (std::strcmp(route.provider, "self") || !ResolveDiscoveryRoute(route, &server, provider)) return unavailable;
            const u64 deadline = static_cast<u64>(os::GetSystemTick().ToTimeSpan().GetMilliSeconds()) + RoomPasscodeTimeoutMs;
            const char *error = nullptr;
            const int fd = ConnectServer(server, &error, RoomPasscodeTimeoutMs, "self", nullptr, deadline);
            if (fd < 0) return unavailable;
            const auto current = [&] { return host ? GameRouteStillCurrent(*host) : AppointmentBackendCurrent(route); };
            RoomPasscodeReply reply{};
            u8 type = 0;
            ssize_t received = -1;
            if (current() && SendFrameTo(fd, ROOM_PASSCODE_REQUEST_TYPE, &request, sizeof(request), nullptr, 0)) {
                const int wait = RemainingIoMs(RoomPasscodeTimeoutMs, deadline);
                if (wait > 0)
                    received = ReadFrame(fd, &type, reinterpret_cast<u8 *>(&reply), sizeof(reply), wait);
            }
            ::close(fd);
            if (!current() || type != ROOM_PASSCODE_RESPONSE_TYPE ||
                received != static_cast<ssize_t>(sizeof(reply)) || reply.status > RoomPasscodeWrong ||
                reply.reserved[0] || reply.reserved[1] || reply.reserved[2]) return unavailable;
            if (request.operation == RoomPasscodeAuthorize && reply.status == RoomPasscodeOk) {
                if (reply.length != ROOM_ACCESS_GRANT_SIZE ||
                    !std::any_of(reply.passcode, reply.passcode + ROOM_ACCESS_GRANT_SIZE, [](char v) { return v != 0; }) ||
                    !std::all_of(reply.passcode + ROOM_ACCESS_GRANT_SIZE, reply.passcode + ROOM_PASSCODE_MAX,
                                 [](char v) { return v == 0; })) return unavailable;
            } else if (((request.operation != RoomPasscodeRead || reply.status != RoomPasscodeOk) && reply.length) ||
                       !ValidRoomPasscodeText(reply.passcode, reply.length)) return unavailable;
            return reply;
        }
    }

    RoomPasscodeHost DescribeRoomPasscodeHost() {
        GameRoute route{};
        u64 game_id = 0;
        RoomPasscodeHost host{};
        host.status = CapturePasscodeHost(&route, &game_id);
        if (host.status == RoomPasscodeOk) std::memcpy(host.room, route.room_code, CodeLength);
        return host;
    }

    u32 ShareRoomPasscode(const RoomPasscodeChange &change) {
        return SetRoomAccess({change, 0, 0});
    }

    u32 SetRoomAccess(const RoomAccessChange &access) {
        const auto &change = access.change;
        if (access.hidden > 1 || access.reserved || !ValidRoomPasscodeRoom(change.room)) return RoomPasscodeInvalid;
        const char *end = static_cast<const char *>(std::memchr(change.passcode, 0, ROOM_PASSCODE_MAX));
        const size_t length = end ? static_cast<size_t>(end - change.passcode) : ROOM_PASSCODE_MAX;
        if ((access.hidden && !length) || !ValidRoomPasscodeText(change.passcode, length)) return RoomPasscodeInvalid;
        GameRoute host{};
        RoomPasscodeRequest request{};
        const u32 status = CapturePasscodeHost(&host, &request.game_id, access.hidden != 0);
        if (status != RoomPasscodeOk) return status;
        if (std::memcmp(change.room, host.room_code, CodeLength)) return RoomPasscodeRoomUnavailable;
        std::memcpy(request.room, host.room_code, CodeLength);
        request.operation = access.hidden ? RoomPasscodeHide : RoomPasscodeWrite;
        request.length = static_cast<u8>(length);
        request.host_token = host.room_token;
        std::memcpy(request.passcode, change.passcode, length);
        return ExchangeRoomPasscode(request, host.discovery, &host).status;
    }

    u32 UnlockRoomAccess(const RoomAccessUnlock &unlock) {
        if (!ValidRoomPasscodeRoom(unlock.room) || !unlock.game_id || unlock.game_id == UINT64_MAX)
            return RoomPasscodeInvalid;
        const char *end = static_cast<const char *>(std::memchr(unlock.passcode, 0, ROOM_PASSCODE_MAX));
        const size_t length = end ? static_cast<size_t>(end - unlock.passcode) : ROOM_PASSCODE_MAX;
        if (!length || !ValidRoomPasscodeText(unlock.passcode, length)) return RoomPasscodeInvalid;
        DiscoveryRoute route{};
        if (!CaptureAppointmentRoute(&route)) return RoomPasscodeUnavailable;
        route.selected_game_id = unlock.game_id;
        RoomPasscodeRequest request{};
        std::memcpy(request.room, unlock.room, CodeLength);
        request.operation = RoomPasscodeAuthorize;
        request.length = static_cast<u8>(length);
        request.game_id = unlock.game_id;
        std::memcpy(request.passcode, unlock.passcode, length);
        const auto reply = ExchangeRoomPasscode(request, route);
        if (reply.status != RoomPasscodeOk) return reply.status;
        const auto *grant = reinterpret_cast<const u8 *>(reply.passcode);
        return R_SUCCEEDED(StartMatch(MatchMode::Exact, unlock.room, grant, &route)) ?
            RoomPasscodeOk : RoomPasscodeRoomUnavailable;
    }

    RoomPasscodeReply LookupRoomPasscode(const RoomPasscodeLookup &lookup) {
        if (!ValidRoomPasscodeRoom(lookup.room) || !lookup.game_id || lookup.game_id == UINT64_MAX)
            return {RoomPasscodeInvalid, 0, {}, {}};
        DiscoveryRoute route{};
        if (!CaptureAppointmentRoute(&route)) return {RoomPasscodeUnavailable, 0, {}, {}};
        RoomPasscodeRequest request{};
        std::memcpy(request.room, lookup.room, CodeLength);
        request.operation = RoomPasscodeRead;
        request.game_id = lookup.game_id;
        return ExchangeRoomPasscode(request, route);
    }

    int FindGroupSummaries(u32 offset, GroupPageV2 *page, GroupSummaryV2 *groups, size_t capacity,
                           u64 game_id, bool self_only, bool background) {
        if (!page || !groups || capacity < GroupPageSize) return -1;
        *page = {-1, GroupPageEnd, 0, ListStatusConfig};
        std::memset(groups, 0, sizeof(GroupSummaryV2) * GroupPageSize);
        sockaddr_in server{};
        char provider[33]{};
        DiscoveryRoute route{};
        if (self_only) {
            if (!CaptureAppointmentRoute(&route) || !ResolveDiscoveryRoute(route, &server, provider)) return -1;
        } else {
            std::scoped_lock lock(g_lock);
            if (!LoadServer(&server, provider)) return -1;
            route.ipv4 = server.sin_addr.s_addr;
            route.port = server.sin_port;
            util::Strlcpy(route.provider, provider, sizeof(route.provider));
        }
        if ((self_only && (std::strcmp(provider, "self") || !game_id || game_id == UINT64_MAX)) ||
            (background && !self_only)) {
            page->reserved = ListStatusUnavailable;
            return -1;
        }
        const int timeout_ms = background ? 1500 : ConnectTimeoutMs;
        const char *error = nullptr;
        const int fd = ConnectServer(server, &error, timeout_ms, provider, &page->reserved);
        if (fd < 0) return -1;
        u32 caps = 0;
        if (!QueryCapabilities(fd, &caps, timeout_ms, &page->reserved)) { ::close(fd); return -1; }
        if (self_only && !AppointmentBackendCurrent(route)) {
            ::close(fd); page->reserved = ListStatusUnavailable; return -1;
        }
        page->capabilities = caps;
        const bool metadata = (caps & CapabilityMetadata) != 0;
        const bool all_rooms = metadata && !background && !std::strcmp(provider, "self") && (caps & ROOM_ACCESS_CAPABILITY);
        const bool paged = metadata || (caps & CapabilityPages);
        if (!paged && offset != 0) { ::close(fd); page->count = 0; return 0; }
        u8 body[15]{};
        put64(body, game_id);
        put32(body + 8, offset);
        if (all_rooms) body[12] = 1;
        if (!paged) body[14] = 1;
        const u8 request = metadata ? T_FindMetadataPage : paged ? T_FindPage : T_Find;
        const size_t request_size = all_rooms ? 13 : paged ? 12 : 15;
        static constinit os::SdkMutex summaries_lock;
        static constinit os::SdkMutex background_lock;
        constexpr size_t ReplyCapacity = 5 + GroupPageSize * GroupRecordSize;
        static u8 foreground_reply[ReplyCapacity], background_reply[ReplyCapacity];
        // Watcher network waits never own the foreground listing buffer/lock.
        std::scoped_lock lock(background ? background_lock : summaries_lock);
        u8 *reply = background ? background_reply : foreground_reply;
        if ((self_only || all_rooms) && !AppointmentBackendCurrent(route)) {
            ::close(fd); page->reserved = ListStatusUnavailable; return -1;
        }
        u8 type = 0;
        ssize_t size = -1;
        page->reserved = ListStatusNetwork;
        if (SendFrameTo(fd, request, body, request_size, nullptr, 0))
            size = ReadListFrame(fd, &type, reply, ReplyCapacity, timeout_ms, &page->reserved);
        ::close(fd);
        if ((self_only || all_rooms) && !AppointmentBackendCurrent(route)) {
            page->reserved = ListStatusUnavailable;
            return -1;
        }
        if (type == T_Error && size >= 1) {
            page->reserved = lanywhere_list_error_status(reply[0]);
            return -1;
        }
        const size_t header = paged ? 5 : 1;
        if (size < static_cast<ssize_t>(header) || type != (metadata ? T_MetadataPage : paged ? T_Page : T_Groups)) return -1;
        const size_t count = reply[header - 1];
        const size_t record = metadata ? sizeof(GroupSummaryV2) : GroupRecordSize;
        const u32 next = paged ? le32(reply) : GroupPageEnd;
        if (count > GroupPageSize || static_cast<size_t>(size) != header + count * record ||
            (next != GroupPageEnd && (!count || next <= offset || next - offset != count))) return -1;
        for (size_t i = 0; i < count; ++i) {
            GroupSummaryV2 &group = groups[i];
            const u8 *source = reply + header + i * record;
            if (metadata) {
                std::memcpy(&group, source, sizeof(group));
                if (group.code[6] || group.code[7] || (group.metadata_flags & ~1u) ||
                    (all_rooms && group.room_access > RoomAccessHidden) ||
                    !CleanDisplayField(group.title_en, sizeof(group.title_en), true) ||
                    !CleanDisplayField(group.title_zh, sizeof(group.title_zh), true)) return -1;
                if (!all_rooms) group.room_access = RoomAccessNone;
            } else {
                std::memcpy(group.code, source, CodeLength);
                const u8 *info = source + CodeLength;
                group.game_id = le64(info);
                group.players = info[0x67]; group.max_players = info[0x66];
                std::memcpy(group.host, info + 0x74, 32);
            }
            if (!ValidCode(group.code) || !group.game_id || !group.max_players || group.max_players > MaxMembers ||
                group.players > group.max_players || (game_id && group.game_id != game_id)) return -1;
            if (!CleanDisplayField(group.host, sizeof(group.host), true)) util::Strlcpy(group.host, "Player", sizeof(group.host));
            AddCachedIdentity(group);
        }
        if ((self_only || all_rooms) && !AppointmentBackendCurrent(route)) {
            std::memset(groups, 0, sizeof(GroupSummaryV2) * GroupPageSize);
            page->reserved = ListStatusUnavailable;
            return -1;
        }
        page->next = next; page->count = static_cast<s32>(count); page->reserved = ListStatusOk;
        return page->count;
    }


    void FindUnifiedRooms(const UnifiedRoomsRequest &request, UnifiedPage *page, UnifiedGroup *groups, size_t capacity) {
        *page = {-1, UNIFIED_LOBBY_END, 0, 0, 0, ListStatusProtocol};
        if (!groups || capacity < UNIFIED_LOBBY_PAGE_SIZE || (request.offset && !request.snapshot)) return;
        std::memset(groups, 0, sizeof(UnifiedGroup) * UNIFIED_LOBBY_PAGE_SIZE);
        DiscoveryRoute route{};
        sockaddr_in server{};
        char provider[33]{};
        if (!CaptureAppointmentRoute(&route) || !ResolveDiscoveryRoute(route, &server, provider)) {
            page->status = ListStatusConfig;
            return;
        }
        constexpr int timeout_ms = 3000;
        const char *error = nullptr;
        const int fd = ConnectServer(server, &error, timeout_ms, "self", &page->status);
        if (fd < 0) return;
        u32 caps = 0;
        if (!QueryCapabilities(fd, &caps, timeout_ms, &page->status)) {
            ::close(fd);
            return;
        }
        if (!(caps & UNIFIED_LOBBY_CAPABILITY)) {
            ::close(fd);
            page->status = ListStatusUpdate;
            return;
        }
        u8 body[8]{};
        put32(body, request.offset);
        put32(body + 4, request.snapshot);
        u8 reply[UNIFIED_LOBBY_HEADER_SIZE + UNIFIED_LOBBY_PAGE_SIZE * sizeof(UnifiedGroup)]{};
        u8 type = 0;
        page->status = ListStatusNetwork;
        ssize_t bytes = -1;
        if (SendFrameTo(fd, UNIFIED_LOBBY_REQUEST_TYPE, body, sizeof(body), nullptr, 0))
            bytes = ReadListFrame(fd, &type, reply, sizeof(reply), timeout_ms, &page->status);
        ::close(fd);
        if (!AppointmentBackendCurrent(route)) {
            page->status = ListStatusUnavailable;
            return;
        }
        if (bytes < 0) return;
        if (type == T_Error && bytes >= 1) {
            page->status = lanywhere_list_error_status(reply[0]);
            return;
        }
        page->status = ListStatusProtocol;
        if (type != UNIFIED_LOBBY_RESPONSE_TYPE || bytes < UNIFIED_LOBBY_HEADER_SIZE) return;
        const u32 snapshot = le32(reply), next = le32(reply + 4);
        const size_t count = reply[8];
        const u8 available = reply[9], total = reply[10], status = reply[11];
        if (available > total || count > UNIFIED_LOBBY_PAGE_SIZE ||
            static_cast<size_t>(bytes) != UNIFIED_LOBBY_HEADER_SIZE + count * sizeof(UnifiedGroup)) return;
        if (status == UnifiedWireStale) {
            if (count == 0 && next == UNIFIED_LOBBY_END) page->status = UnifiedListStale;
            return;
        }
        if (status != UnifiedWireOk || !snapshot || (request.snapshot && request.snapshot != snapshot) ||
            (next != UNIFIED_LOBBY_END && (!count || next <= request.offset || next - request.offset != count))) return;

        for (size_t i = 0; i < count; ++i) {
            UnifiedGroup row{};
            std::memcpy(&row, reply + UNIFIED_LOBBY_HEADER_SIZE + i * sizeof(row), sizeof(row));
            auto &group = row.group;
            const char *end = static_cast<const char *>(std::memchr(row.provider, 0, sizeof(row.provider)));
            if (!end || end == row.provider ||
                !std::all_of(end, static_cast<const char *>(row.provider) + sizeof(row.provider), [](char c) { return c == 0; }) ||
                !std::all_of(std::begin(row.reserved), std::end(row.reserved), [](u8 v) { return v == 0; }) ||
                group.code[6] || group.code[7] || !ValidCode(group.code) || !group.game_id ||
                !group.max_players || group.max_players > MaxMembers || group.players > group.max_players ||
                (group.metadata_flags & ~1u) || group.room_access > RoomAccessHidden ||
                !CleanDisplayField(group.title_en, sizeof(group.title_en), true) ||
                !CleanDisplayField(group.title_zh, sizeof(group.title_zh), true)) {
                std::memset(groups, 0, sizeof(UnifiedGroup) * UNIFIED_LOBBY_PAGE_SIZE);
                return;
            }
            DiscoveryRoute row_route = route;
            util::Strlcpy(row_route.provider, row.provider, sizeof(row_route.provider));
            if (!ResolveDiscoveryRoute(row_route, &server, provider) ||
                (!std::strcmp(provider, "self") && group.game_id == UINT64_MAX) ||
                (std::strcmp(provider, "self") && group.room_access != RoomAccessNone)) {
                std::memset(groups, 0, sizeof(UnifiedGroup) * UNIFIED_LOBBY_PAGE_SIZE);
                return;
            }
            if (!CleanDisplayField(group.host, sizeof(group.host), true))
                util::Strlcpy(group.host, "Player", sizeof(group.host));
            AddCachedIdentity(group);
            groups[i] = row;
        }
        *page = {static_cast<s32>(count), next, snapshot, available, total, ListStatusOk};
    }

}
