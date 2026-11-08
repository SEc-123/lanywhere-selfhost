/* Testable Horizon BSD wire/policy glue. GPL-2.0-only. */
#pragma once
#include "tcp_stream_proxy.hpp"

namespace ams::mitm::tcpstream {
struct IpcBuffer {void *data=nullptr;size_t size=0;bool output=false;};
using DispatchFunction=uint32_t (*)(void *,uint32_t,const void *,size_t,void *,size_t,const IpcBuffer *,size_t);
struct Reply {uint32_t ipc=0;int32_t ret=-1,error=0;uint32_t length=0;};
struct NativeAddress {uint8_t bytes[16]{};};
struct NativePollFd {int32_t fd;int16_t events,revents;};
struct NativeSelectData {int32_t nfds;uint32_t padding;int64_t seconds,microseconds;uint8_t null_timeout;uint8_t reserved[7];};
struct NativeDuplicateData {int32_t fd;uint32_t padding;uint64_t reserved;};
struct NativeRecvMmsgData {int32_t fd,vlen,flags;uint32_t padding;int64_t seconds,nanoseconds;};
struct NativeSendMmsgData {int32_t fd,vlen,flags;};
static_assert(sizeof(NativeAddress)==16&&sizeof(NativePollFd)==8&&sizeof(NativeSelectData)==32);
static_assert(offsetof(NativeSelectData,seconds)==8&&offsetof(NativeSelectData,null_timeout)==24);
static_assert(sizeof(NativeDuplicateData)==16&&offsetof(NativeDuplicateData,reserved)==8);
static_assert(sizeof(NativeRecvMmsgData)==32&&offsetof(NativeRecvMmsgData,seconds)==16&&sizeof(NativeSendMmsgData)==12);
NativeAddress MakeAddress(Endpoint endpoint);
bool ReadAddress(const void *buffer,size_t bytes,Endpoint *endpoint);

class Forward {
    void *context;DispatchFunction dispatch;
public:
    Forward(void *context,DispatchFunction dispatch):context(context),dispatch(dispatch){}
    Reply Call(uint32_t command,const void *in,size_t in_size,const IpcBuffer *buffers=nullptr,size_t count=0,bool length=false);
    Reply Socket();
    Reply Bind(int fd,Endpoint address);
    Reply Connect(int fd,Endpoint address);
    Reply Name(int fd,Endpoint *address,bool peer=false);
    Reply Flags(int fd);
    Reply Type(int fd);
    Reply Close(int fd);
    Reply PollOne(int fd,int events,int timeout,int *revents);
    Reply Timeout(int fd,bool write,int64_t *milliseconds);
};
struct Outcome {bool handled=false;Reply result{};Endpoint peer{};};
Outcome ConnectGame(Proxy &proxy,Owner owner,Forward &forward,int fd,Endpoint destination,bool virtual_destination);
Outcome AcceptGame(Proxy &proxy,Owner owner,Forward &forward,int listener);
Outcome GateGameIo(Proxy &proxy,Owner owner,Forward &forward,int fd,int flags,bool write);
// POLL bit values on Horizon BSD. Other physical-ready bits are preserved.
int FilterPoll(Proxy &proxy,Owner owner,int fd,int requested,int returned);
bool NeedsPollSlices(Proxy &proxy,Owner owner,int fd);
}
