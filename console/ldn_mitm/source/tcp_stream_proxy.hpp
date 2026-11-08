/* Scoped game TCP proxy. GPL-2.0-only; see the project LICENSE. */
#pragma once
#include "tcp_stream_protocol.hpp"
#include <cstddef>
#include <cstdint>

namespace ams::mitm::tcpstream {
struct Owner { uint64_t process=0, program=0; };
struct Endpoint { uint32_t ip=0; uint16_t port=0; };
struct GameSession {
    Owner owner;
    uint64_t transport_epoch=0, session_nonce=0, binding_id=0;
    uint32_t capabilities=0, self_ip=0, peers[8]{};
    uint8_t network_id[32]{};
    bool active=false;
};
enum class State { Unmanaged, Pending, Connected, Failed };
struct Status { State state=State::Unmanaged; int error=0; bool legacy=false; };
struct Plan { uint64_t ticket=0; uint16_t proxy_port=0; Endpoint local,peer; };
struct Metrics { size_t sockets=0, streams=0, pending_accepts=0, pending_opens=0, buffered_bytes=0; bool worker=false; };
using SendFunction = bool (*)(void *,uint64_t,const uint8_t *,size_t);

// Methods never operate on game descriptor numbers: those belong to a separate
// BSD client table. Only the calling IPC hook creates/connects/closes game FDs.
class Proxy {
    struct Impl;
    Impl *impl;
public:
    Proxy(SendFunction send,void *user);
    ~Proxy();
    Proxy(const Proxy&)=delete;
    Proxy& operator=(const Proxy&)=delete;
    void SetSession(const GameSession &session);
    void BeginBinding(const GameSession &pending_session);
    void EndBinding(uint64_t binding_id);
    void TransportClosed(uint64_t epoch);
    void PeerLeft(uint32_t peer);
    void ClientOpen(Owner owner);
    void ClientClose(Owner owner);
    bool SocketCreated(Owner owner,int fd,int type);
    void Bound(Owner owner,int fd,Endpoint address);
    void AssignedPort(Owner owner,int fd,uint16_t port);
    void ShutdownExempt(Owner owner,int fd,bool exempt);
    void Listening(Owner owner,int fd,int backlog);
    bool Duplicated(Owner owner,int original,int duplicate);
    void Closed(Owner owner,int fd);
    bool IsStreamSocket(Owner owner,int fd) const;
    bool IsListening(Owner owner,int fd) const;
    bool IsVirtualDestination(Owner owner,uint32_t ip) const;
    bool BeginConnect(Owner owner,int fd,Endpoint destination,uint16_t source_port,Plan *plan,int *error);
    bool PrepareAccept(Owner owner,int listener,Plan *plan,int *error);
    bool AttachAccepted(Owner owner,int fd,uint64_t ticket,uint16_t source_port);
    bool ExpectLocalPeer(uint64_t ticket,uint16_t source_port);
    void Cancel(uint64_t ticket,Reason reason);
    Status GetStatus(Owner owner,int fd) const;
    int TakeSocketError(Owner owner,int fd);
    bool Addresses(Owner owner,int fd,Endpoint *local,Endpoint *peer) const;
    bool PendingAccept(Owner owner,int fd) const;
    bool IsVirtualListener(Owner owner,int fd) const;
    bool HasLegacyStream() const;
    bool Shutdown(Owner owner,int fd,int how,int *error);
    void ShutdownAll(Owner owner,int how);
    bool OnFrame(uint64_t epoch,const void *body,size_t bytes);
    // Caller has validated current relay epoch and actual member identity.
    // Only OPEN (68 bytes) may wait for the local LDN SYNC consumer.
    bool StageOpen(uint64_t epoch,const void *body,size_t bytes);
    void CancelStaged(uint64_t epoch,const Frame &frame);
    Metrics GetMetrics() const;
};

// One bounded proxy worker is owned by the sysmodule. Tests instantiate two
// actual Proxy objects to exercise the same socket/state implementation.
Proxy &Global();
void UpdateGameSession(const GameSession &session);
void ResetTransport(uint64_t epoch);
void ReceiveFrame(uint64_t epoch,const void *body,size_t size);
}
