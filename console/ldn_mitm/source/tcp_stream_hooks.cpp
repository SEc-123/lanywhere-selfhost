/* Actual policy and fixed BSD IPC layouts. GPL-2.0-only. */
#include "tcp_stream_hooks.hpp"
#include <algorithm>
#include <chrono>
#include <cstring>
#if defined(__SWITCH__)
#include <stratosphere.hpp>
#else
#include <thread>
#endif

namespace ams::mitm::tcpstream {
namespace {
constexpr int NativeAgain=11,NativeInvalid=22,NativeIo=5,NativeBuffers=105,
    NativeInProgress=115,NativeAlready=114,NativeConnected=106,NativeNotConnected=107,
    NativeTimeout=110,NativeFamily=97;
constexpr int NativeNonblocking=0x800,NativeDontWait=0x80;
uint64_t Milliseconds(){
#if defined(__SWITCH__)
    return ams::os::GetSystemTick().ToTimeSpan().GetMilliSeconds();
#else
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
#endif
}
void Pause(){
#if defined(__SWITCH__)
    ams::os::SleepThread(ams::TimeSpan::FromMilliSeconds(1));
#else
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
#endif
}
Outcome Error(int error){Outcome o;o.handled=true;o.result.ret=-1;o.result.error=error;return o;}
Outcome Ipc(Reply result){Outcome o;o.handled=true;o.result=result;return o;}
bool Failed(const Reply &r){return r.ipc||r.ret<0;}
Reply EnsurePort(Forward &forward,int fd,Endpoint *address){
    auto r=forward.Name(fd,address);if(Failed(r)||address->port)return r;
    r=forward.Bind(fd,{0,0});if(Failed(r))return r;return forward.Name(fd,address);
}
}
NativeAddress MakeAddress(Endpoint e){NativeAddress a;a.bytes[0]=16;a.bytes[1]=2;a.bytes[2]=e.port>>8;a.bytes[3]=e.port;for(unsigned i=0;i<4;i++)a.bytes[4+i]=e.ip>>(24-8*i);return a;}
bool ReadAddress(const void *buffer,size_t bytes,Endpoint *out){
    if(!buffer||!out||bytes<16)return false;
    const auto *a=static_cast<const uint8_t*>(buffer);
    if(a[1]!=2)return false;
    out->port=uint16_t(a[2])<<8|a[3];out->ip=uint32_t(a[4])<<24|uint32_t(a[5])<<16|uint32_t(a[6])<<8|a[7];return true;
}
Reply Forward::Call(uint32_t command,const void *in,size_t in_size,const IpcBuffer *buffers,size_t count,bool length){
    struct Raw {int32_t ret,error;uint32_t length;} out{};Reply result;
    if(!dispatch||count>6){result.error=NativeIo;return result;}
    result.ipc=dispatch(context,command,in,in_size,&out,length?12:8,buffers,count);
    if(result.ipc)return result;
    result.ret=out.ret;result.error=out.ret<0?out.error:0;result.length=out.length;return result;
}
Reply Forward::Socket(){const int32_t input[3]={2,1,0};return Call(2,input,sizeof(input));}
Reply Forward::Bind(int fd,Endpoint endpoint){const int32_t input=fd;auto a=MakeAddress(endpoint);const IpcBuffer buffer{&a,sizeof(a),false};return Call(13,&input,sizeof(input),&buffer,1);}
Reply Forward::Connect(int fd,Endpoint endpoint){const int32_t input=fd;auto a=MakeAddress(endpoint);const IpcBuffer buffer{&a,sizeof(a),false};return Call(14,&input,sizeof(input),&buffer,1);}
Reply Forward::Name(int fd,Endpoint *address,bool peer){
    const int32_t input=fd;NativeAddress a;const IpcBuffer buffer{&a,sizeof(a),true};auto r=Call(peer?15:16,&input,sizeof(input),&buffer,1,true);
    if(!Failed(r)&&(r.length<16||!ReadAddress(&a,sizeof(a),address))){r.ret=-1;r.error=NativeFamily;}return r;
}
Reply Forward::Flags(int fd){const int32_t input[3]={fd,3,0};return Call(20,input,sizeof(input));}
Reply Forward::Type(int fd){const int32_t input[3]={fd,0xffff,0x1008};int32_t value=0;const IpcBuffer b{&value,sizeof(value),true};auto r=Call(17,input,sizeof(input),&b,1,true);if(!Failed(r)){if(r.length<4){r.ret=-1;r.error=NativeInvalid;}else r.ret=value;}return r;}
Reply Forward::Close(int fd){const int32_t input=fd;return Call(26,&input,sizeof(input));}
Reply Forward::PollOne(int fd,int events,int timeout,int *revents){const struct {uint32_t n;int32_t timeout;} input{1,timeout};NativePollFd in{fd,static_cast<int16_t>(events),0},out{};const IpcBuffer b[2]={{&in,sizeof(in),false},{&out,sizeof(out),true}};auto r=Call(6,&input,sizeof(input),b,2);if(!Failed(r))*revents=out.revents;return r;}
Reply Forward::Timeout(int fd,bool write,int64_t *milliseconds){const int32_t input[3]={fd,0xffff,write?0x1005:0x1006};struct {int64_t sec,usec;} value{};const IpcBuffer b{&value,sizeof(value),true};auto r=Call(17,input,sizeof(input),&b,1,true);if(!Failed(r)){if(r.length!=sizeof(value)||value.sec<0||value.usec<0||value.usec>=1000000||value.sec>86400){r.ret=-1;r.error=NativeInvalid;}else *milliseconds=value.sec*1000+value.usec/1000;}return r;}

Outcome ConnectGame(Proxy &proxy,Owner owner,Forward &forward,int fd,Endpoint destination,bool virtual_destination){
    if(!virtual_destination)return {};
    const auto type=forward.Type(fd);if(Failed(type))return Ipc(type);if(type.ret!=1)return {};
    if(!proxy.IsStreamSocket(owner,fd))return Error(NativeBuffers); // Unknown creation/FD variant never falls onto the physical network.
    const auto old=proxy.GetStatus(owner,fd);
    if(old.state==State::Pending)return Error(NativeAlready);
    if(old.state==State::Connected)return Error(NativeConnected);
    if(old.state==State::Failed)return Error(old.error?old.error:NativeNotConnected);
    Endpoint existing_peer{};const auto existing=forward.Name(fd,&existing_peer,true);
    if(existing.ipc)return Ipc(existing);
    if(existing.ret==0)return Error(NativeConnected);
    if(existing.error!=NativeNotConnected)return Ipc(existing);
    auto flags=forward.Flags(fd);if(Failed(flags))return Ipc(flags);const bool nonblocking=flags.ret&NativeNonblocking;
    Endpoint local{};auto r=EnsurePort(forward,fd,&local);if(Failed(r))return Ipc(r);
    // Other physical-interface binds are not repurposed into virtual sockets.
    if(local.ip!=0&&local.ip!=0x7f000001&&!proxy.IsVirtualDestination(owner,local.ip))return Error(NativeFamily);
    Plan plan;int error=0;
    if(!proxy.BeginConnect(owner,fd,destination,local.port,&plan,&error))return Error(NativeBuffers);
    if(error)return Error(error);
    r=forward.Connect(fd,{0x7f000001,plan.proxy_port});
    if(r.ipc||(r.ret<0&&r.error!=NativeInProgress&&r.error!=NativeAlready&&r.error!=NativeAgain)){proxy.Cancel(plan.ticket,Reason::Refused);return Ipc(r);}
    if(nonblocking)return Error(NativeInProgress);
    const uint64_t deadline=Milliseconds()+5000;
    while(Milliseconds()<deadline){const auto status=proxy.GetStatus(owner,fd);
        if(status.state==State::Connected){r.ret=0;r.error=0;return Ipc(r);}
        if(status.state==State::Failed)return Error(status.error);
        Pause();
    }
    proxy.Cancel(plan.ticket,Reason::Timeout);return Error(NativeTimeout);
}

Outcome AcceptGame(Proxy &proxy,Owner owner,Forward &forward,int listener){
    if(!proxy.IsStreamSocket(owner,listener)||!proxy.IsListening(owner,listener))return {};
    const auto flags=forward.Flags(listener);if(Failed(flags))return Ipc(flags);
    const bool nonblocking=flags.ret&NativeNonblocking;int64_t timeout=0;
    const auto option=forward.Timeout(listener,false,&timeout);if(option.ipc)return Ipc(option);
    const uint64_t started=Milliseconds();bool was_virtual=false;
    for(;;){
        const bool virtual_listener=proxy.IsVirtualListener(owner,listener);
        if(was_virtual&&!virtual_listener)return Error(103); // ECONNABORTED on scoped session teardown.
        was_virtual=was_virtual||virtual_listener;
        if(proxy.PendingAccept(owner,listener)){
            Plan plan;int error=0;if(!proxy.PrepareAccept(owner,listener,&plan,&error))return Error(NativeNotConnected);
            if(error)return Error(error);
            auto created=forward.Socket();if(Failed(created)){proxy.Cancel(plan.ticket,Reason::Capacity);return Ipc(created);}
            const int fd=created.ret;Endpoint local{};Reply r;r.ret=0;
            // A synthetic accepted descriptor must not lose the listener's
            // blocking-I/O deadlines. Copy the exact Horizon timeval payloads.
            for(int option_name:{0x1005,0x1006}) {
                const int32_t get[3]={listener,0xffff,option_name};int64_t timeval[2]{};
                IpcBuffer value{timeval,sizeof(timeval),true};r=forward.Call(17,get,sizeof(get),&value,1,true);
                if(Failed(r)||r.length!=sizeof(timeval)){if(!Failed(r)){r.ret=-1;r.error=NativeInvalid;}break;}
                const int32_t set[3]={fd,0xffff,option_name};value.output=false;r=forward.Call(21,set,sizeof(set),&value,1);
                if(Failed(r))break;
            }
            if(!Failed(r))r=EnsurePort(forward,fd,&local);
            if(!Failed(r)&&!proxy.AttachAccepted(owner,fd,plan.ticket,local.port)){r.ret=-1;r.error=NativeBuffers;}
            if(!Failed(r))r=forward.Connect(fd,{0x7f000001,plan.proxy_port});
            if(Failed(r)){proxy.Cancel(plan.ticket,Reason::Refused);forward.Close(fd);proxy.Closed(owner,fd);return Ipc(r);}
            Outcome out=Ipc(r);out.result.ret=fd;out.peer=plan.peer;return out;
        }
        int ready=0;const auto poll=forward.PollOne(listener,1,nonblocking?0:20,&ready);if(Failed(poll))return Ipc(poll);
        if(ready)return {}; // Caller performs the original physical Accept unchanged.
        if(nonblocking)return Error(NativeAgain);
        if(timeout>0&&Milliseconds()-started>=static_cast<uint64_t>(timeout))return Error(NativeAgain);
    }
}

Outcome GateGameIo(Proxy &proxy,Owner owner,Forward &forward,int fd,int flags,bool write){
    auto status=proxy.GetStatus(owner,fd);
    if(status.state!=State::Unmanaged&&(flags&1))return Error(95); // TCP urgent/OOB is not represented by this stream protocol.
    if(status.state==State::Unmanaged||status.state==State::Connected)return {};
    if(status.state==State::Failed)return Error(status.error?status.error:NativeNotConnected);
    const auto file_flags=forward.Flags(fd);if(Failed(file_flags))return Ipc(file_flags);
    if((file_flags.ret&NativeNonblocking)||(flags&NativeDontWait))return Error(NativeAgain);
    int64_t timeout=0;const auto option=forward.Timeout(fd,write,&timeout);if(option.ipc)return Ipc(option);
    const uint64_t start=Milliseconds();
    while(Milliseconds()-start<5000){
        status=proxy.GetStatus(owner,fd);
        if(status.state==State::Connected)return {};
        if(status.state==State::Failed)return Error(status.error);
        if(timeout>0&&Milliseconds()-start>=static_cast<uint64_t>(timeout))return Error(NativeAgain);
        Pause();
    }
    return Error(NativeTimeout);
}
int FilterPoll(Proxy &proxy,Owner owner,int fd,int requested,int returned){
    const auto status=proxy.GetStatus(owner,fd);
    if(status.state==State::Pending)return returned&~(0x004|0x100|0x001|0x040); // Local loopback readiness is not remote OPEN success.
    if(status.state==State::Failed)return (requested&(0x004|0x100))|0x008|0x010;
    if(proxy.PendingAccept(owner,fd))returned|=requested&(0x001|0x040);
    return returned;
}
bool NeedsPollSlices(Proxy &proxy,Owner owner,int fd){return proxy.IsStreamSocket(owner,fd);}
}
