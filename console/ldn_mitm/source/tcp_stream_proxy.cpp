/* Scoped game TCP proxy. GPL-2.0-only; see the project LICENSE.
 * The fork's UDP11453 tunnel informed compatibility requirements; this worker
 * uses the independently validated reliable stream protocol, not that tunnel.
 */
#include "tcp_stream_proxy.hpp"
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <fcntl.h>
#include <mutex>
#include <new>
#include <poll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <arpa/inet.h>
#include <unistd.h>
#if defined(__SWITCH__)
#include <stratosphere.hpp>
#include "lanywhere_relay.hpp"
#else
#include <thread>
#endif

namespace ams::mitm::tcpstream {
namespace {
constexpr size_t MaxStreams=8, MaxSockets=64, RingBytes=16384;
constexpr uint64_t WireBytesPerSecond=192*1024, WireBurst=8192;
// Horizon BSD uses Linux errno values, independent of host libc's errno ABI.
constexpr int Again=11, Invalid=22, Unsupported=95, Reset=104, Buffers=105,
    NotConnected=107, TimedOut=110, Refused=111, Unreachable=113, Already=114;
uint64_t Now() {
#if defined(__SWITCH__)
    return ams::os::GetSystemTick().ToTimeSpan().GetMilliSeconds();
#else
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
#endif
}
bool Same(Owner a,Owner b) { return a.process==b.process && a.program==b.program; }
void CloseFd(int &fd,bool reset=false) {
    if(fd<0)return;
    if(reset){linger l{1,0};::setsockopt(fd,SOL_SOCKET,SO_LINGER,&l,sizeof(l));}
    ::close(fd);fd=-1;
}
bool Nonblocking(int fd) { const int flags=::fcntl(fd,F_GETFL,0);return flags>=0 && ::fcntl(fd,F_SETFL,flags|O_NONBLOCK)==0; }
void SuppressSigpipe(int fd) {
    const int no_delay=1;::setsockopt(fd,IPPROTO_TCP,TCP_NODELAY,&no_delay,sizeof(no_delay));
#ifdef SO_NOSIGPIPE
    const int enabled=1;::setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&enabled,sizeof(enabled));
#else
    (void)fd;
#endif
}
ssize_t SendSocket(int fd,const void *bytes,size_t size) {
#ifdef MSG_NOSIGNAL
    return ::send(fd,bytes,size,MSG_NOSIGNAL);
#else
    return ::send(fd,bytes,size,0);
#endif
}
int Listener(uint16_t *port) {
    int fd=::socket(AF_INET,SOCK_STREAM,0);if(fd<0)return -1;
    sockaddr_in a{};a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
#if defined(__SWITCH__) || defined(__APPLE__)
    a.sin_len=sizeof(a);
#endif
    if(::bind(fd,reinterpret_cast<sockaddr*>(&a),sizeof(a))<0 || ::listen(fd,1)<0 || !Nonblocking(fd)){CloseFd(fd);return -1;}
    socklen_t n=sizeof(a);if(::getsockname(fd,reinterpret_cast<sockaddr*>(&a),&n)<0){CloseFd(fd);return -1;}
    *port=ntohs(a.sin_port);return fd;
}
int ErrorFor(Reason r) {
    switch(r){case Reason::Unsupported:return Unsupported;case Reason::Capacity:case Reason::Backpressure:return Buffers;
        case Reason::Refused:return Refused;case Reason::Timeout:return TimedOut;default:return Reset;}
}
struct Ring {
    uint8_t bytes[RingBytes]{};size_t head=0,size=0;
    size_t Free() const {return RingBytes-size;}
    void Clear(){head=size=0;}
    bool Push(const void *p,size_t n){if(n>Free())return false;const auto *b=static_cast<const uint8_t*>(p);for(size_t i=0;i<n;i++)bytes[(head+size+i)%RingBytes]=b[i];size+=n;return true;}
    size_t Peek(void *p,size_t n) const {n=std::min(n,size);auto *b=static_cast<uint8_t*>(p);for(size_t i=0;i<n;i++)b[i]=bytes[(head+i)%RingBytes];return n;}
    void Drop(size_t n){n=std::min(n,size);head=(head+n)%RingBytes;size-=n;}
};
}

struct Proxy::Impl {
#if defined(__SWITCH__)
    using Mutex=ams::os::SdkMutex;
#else
    using Mutex=std::mutex;
#endif
    mutable Mutex mutex;
    SendFunction send;void *user;
    GameSession session{};
    bool binding_claimed=false;
    uint64_t next_ticket=1,next_object=1;
    uint32_t next_id=1;size_t next_stream=0;
    uint64_t wire_credit=WireBurst,credit_at=Now(),credit_remainder=0;
    struct Object {
        bool used=false,listening=false,managed=false,legacy=false,shutdown_exempt=false;
        uint64_t id=0,ticket=0;Owner owner{};int type=0,refs=0,backlog=1,error=0,pending_error=0;
        Endpoint local{},peer{};State state=State::Unmanaged;
    } objects[MaxSockets];
    struct Alias {bool used=false;Owner owner{};int fd=-1;uint64_t object=0;} aliases[MaxSockets];
    struct Client {Owner owner{};unsigned refs=0;} clients[16];
    struct Stream {
        bool used=false,initiator=false,opened=false,legacy=false,open_pending=false,ack_pending=false,
            window_pending=false,local_eof=false,remote_fin=false,fin_sent=false,read_closed=false,
            reset_pending=false,game_closed=false,accepted=false;
        uint64_t ticket=0,object=0,listener_object=0,epoch=0,nonce=0,deadline=0,
            tx_sent=0,peer_consumed=0,rx_next=0,rx_consumed=0;
        uint32_t id=0,peer_ip=0;Owner owner{};
        uint16_t local_port=0,peer_port=0,peer_window=0,expected_local_port=0;
        uint8_t network_id[32]{};Reason reason=Reason::Closed;
        int listener=-1,socket=-1;unsigned in_flight=0;
        Ring tx,rx;
    } streams[MaxStreams];
    struct Rejection {bool used=false;uint64_t epoch=0;Frame frame{};} rejections[16];
    struct PendingOpen {bool used=false;uint64_t epoch=0,deadline=0,binding=0;Owner owner{};uint8_t body[68]{};} pending[MaxStreams];
    std::atomic<bool> running{false};bool started=false;
#if defined(__SWITCH__)
    ams::os::ThreadType thread{};
    alignas(ams::os::ThreadStackAlignment) uint8_t stack[0x8000]{};
    static void Entry(void *p){static_cast<Impl*>(p)->Loop();}
#else
    std::thread thread;
#endif
    Impl(SendFunction callback,void *context):send(callback),user(context) {
        running=true;
#if defined(__SWITCH__)
        if(R_SUCCEEDED(ams::os::CreateThread(&thread,Entry,this,stack,sizeof(stack),0x15))){started=true;ams::os::StartThread(&thread);}else running=false;
#else
        thread=std::thread([this]{Loop();});started=true;
#endif
    }
    ~Impl(){running=false;if(started){
#if defined(__SWITCH__)
        ams::os::WaitThread(&thread);ams::os::DestroyThread(&thread);
#else
        thread.join();
#endif
    }for(auto &s:streams)Release(s);}
    Object *ById(uint64_t id){for(auto &o:objects)if(o.used&&o.id==id)return &o;return nullptr;}
    Object *Find(Owner owner,int fd){for(auto &a:aliases)if(a.used&&a.fd==fd&&Same(a.owner,owner))return ById(a.object);return nullptr;}
    Stream *Ticket(uint64_t t){for(auto &s:streams)if(s.used&&s.ticket==t)return &s;return nullptr;}
    Stream *Wire(const Frame &f){for(auto &s:streams)if(s.used&&s.peer_ip==f.peer&&s.id==f.id&&s.nonce==f.nonce&&s.initiator==(f.owner==1))return &s;return nullptr;}
    bool Peer(uint32_t ip) const {return ip && ip!=session.self_ip && std::find(std::begin(session.peers),std::end(session.peers),ip)!=std::end(session.peers);}
    bool Active(Owner owner) const {return session.active&&Same(owner,session.owner)&&session.transport_epoch&&session.session_nonce&&(session.capabilities&Capability);}
    bool Virtual(Owner owner,uint32_t ip) const {
        if(!Same(owner,session.owner)||!session.self_ip)return false;
        const uint32_t mask=(session.self_ip>>16)==0x0a0d?0xffff0000u:0xffffff00u;
        return (ip&mask)==(session.self_ip&mask)||ip==0xffffffff;
    }
    void Release(Stream &s){CloseFd(s.listener);CloseFd(s.socket);s.used=false;s.tx.Clear();s.rx.Clear();}
    void FinishIfDrained(Stream &s){
        if(s.used&&!s.reset_pending&&s.fin_sent&&s.remote_fin&&!s.rx.size&&!s.tx.size&&
           s.peer_consumed==s.tx_sent&&!s.window_pending&&!s.in_flight)Release(s);
    }
    void ResetStream(Stream &s,Reason reason,bool notify=true){
        if(auto *o=ById(s.object)){o->state=State::Failed;o->error=o->pending_error=ErrorFor(reason);o->ticket=0;}
        CloseFd(s.listener,true);CloseFd(s.socket,true);s.tx.Clear();s.rx.Clear();s.reason=reason;
        if(notify&&s.epoch==session.transport_epoch){s.reset_pending=true;s.open_pending=s.ack_pending=s.window_pending=false;}
        else Release(s);
    }
    void Reject(const Frame &f,Reason reason,uint64_t epoch=0){
        if(f.op==Op::Reset)return;
        for(auto &r:rejections)if(!r.used){r.used=true;r.epoch=epoch?epoch:session.transport_epoch;r.frame={};r.frame.peer=f.peer;r.frame.id=f.id;r.frame.nonce=f.nonce;r.frame.owner=f.owner?0:1;r.frame.op=Op::Reset;r.frame.aux=static_cast<uint16_t>(reason);break;}
    }
    Stream *Allocate(){for(auto &s:streams)if(!s.used){
        // Do not put a 32KiB Stream temporary on the small Horizon IPC stack.
        std::memset(static_cast<void*>(&s),0,offsetof(Stream,tx));
        s.listener=s.socket=-1;s.reason=Reason::Closed;s.tx.Clear();s.rx.Clear();
        s.used=true;s.ticket=next_ticket++;if(!s.ticket)s.ticket=next_ticket++;return &s;
    }
        return nullptr;
    }
    bool AddSocket(Owner owner,int fd,int type){
        if(fd<0||!owner.process||!owner.program)return false;
        if(Find(owner,fd))CloseAlias(owner,fd);
        Alias *slot=nullptr;Object *object=nullptr;
        for(auto &a:aliases)if(!a.used){slot=&a;break;}
        for(auto &o:objects)if(!o.used){object=&o;break;}
        if(!slot||!object)return false;
        *object=Object{};object->used=true;object->id=next_object++;object->owner=owner;object->type=type&0xff;object->refs=1;
        *slot={true,owner,fd,object->id};return true;
    }
    void CloseAlias(Owner owner,int fd){
        for(auto &a:aliases)if(a.used&&a.fd==fd&&Same(a.owner,owner)){
            auto *o=ById(a.object);a.used=false;if(!o||--o->refs)return;
            for(auto &s:streams)if(s.used){
                if(s.listener_object==o->id&&!s.accepted)ResetStream(s,Reason::Closed);
                if(s.object==o->id){s.game_closed=true;s.deadline=Now()+5000;s.object=0;}
            }
            o->used=false;return;
        }
    }
    Frame Base(const Stream &s,Op op) const {Frame f;f.peer=s.peer_ip;f.id=s.id;f.nonce=s.nonce;f.owner=s.initiator?0:1;f.op=op;return f;}
    bool Next(uint8_t *wire,size_t *size,uint64_t *epoch,uint64_t *ticket){
        std::scoped_lock lock(mutex);
        const uint64_t now=Now(),earned=(now-credit_at)*WireBytesPerSecond+credit_remainder;
        for(auto &p:pending)if(p.used&&now>=p.deadline){Frame f;if(Parse(p.body,sizeof(p.body),&f))Reject(f,Reason::Timeout,p.epoch);p.used=false;}
        wire_credit=std::min(WireBurst,wire_credit+earned/1000);credit_remainder=earned%1000;credit_at=now;
        // Charge complete relay frame plus conservative TCP/IP overhead. The
        // 192KiB/s stream budget leaves room for control and game UDP traffic.
        if(wire_credit<PrefixBytes+HeaderBytes+MaxChunk+55)return false;
        *ticket=0;
        for(auto &r:rejections)if(r.used){*size=Encode(wire,PrefixBytes+HeaderBytes+MaxChunk,r.frame);*epoch=r.epoch;r.used=false;wire_credit-=*size+55;return *size!=0;}
        for(size_t iteration=0;iteration<MaxStreams;iteration++){
            const size_t index=(next_stream+iteration)%MaxStreams;auto &s=streams[index];if(!s.used)continue;
            if(s.deadline&&Now()>=s.deadline&&!s.reset_pending)ResetStream(s,s.game_closed?Reason::Closed:Reason::Timeout);
            if(!s.used)continue;
            Frame f;uint8_t payload[MaxChunk];bool have=true,release=false;
            if(s.reset_pending){f=Base(s,Op::Reset);f.aux=static_cast<uint16_t>(s.reason);release=true;}
            else if(s.open_pending){f=Base(s,Op::Open);f.source_port=s.local_port;f.destination_port=s.peer_port;f.aux=LocalWindow;f.size=32;f.data=s.network_id;s.open_pending=false;}
            else if(s.ack_pending){f=Base(s,Op::OpenOk);f.aux=LocalWindow;s.ack_pending=false;}
            else if(s.window_pending){f=Base(s,Op::Window);f.seq=s.rx_consumed;f.aux=LocalWindow;s.window_pending=false;}
            else if(s.opened&&s.tx.size&&s.peer_consumed+s.peer_window>s.tx_sent){
                const size_t n=std::min<uint64_t>({s.tx.size,MaxChunk,s.peer_consumed+s.peer_window-s.tx_sent});
                f=Base(s,Op::Data);f.seq=s.tx_sent;f.size=s.tx.Peek(payload,n);f.data=payload;s.tx.Drop(f.size);s.tx_sent+=f.size;
            }else if(s.opened&&s.local_eof&&!s.tx.size&&!s.fin_sent){f=Base(s,Op::Fin);f.seq=s.tx_sent;s.fin_sent=true;}
            else have=false;
            if(have){next_stream=(index+1)%MaxStreams;*epoch=s.epoch;*size=Encode(wire,PrefixBytes+HeaderBytes+MaxChunk,f);wire_credit-=*size+55;
                if(release)Release(s);else{*ticket=s.ticket;s.in_flight++;}return *size!=0;}
        }
        return false;
    }
    void PumpSockets(){
        pollfd fds[MaxStreams]{};uint64_t tickets[MaxStreams]{};bool listeners[MaxStreams]{};size_t count=0;
        {
            std::scoped_lock lock(mutex);
            for(auto &s:streams)if(s.used&&!s.reset_pending){
                if(s.listener>=0){fds[count]={s.listener,POLLIN,0};tickets[count]=s.ticket;listeners[count++]=true;}
                else if(s.socket>=0){short events=0;if(s.opened&&!s.local_eof&&s.tx.Free())events|=POLLIN;if(s.rx.size&&!s.read_closed)events|=POLLOUT;fds[count]={s.socket,events,0};tickets[count]=s.ticket;count++;}
            }
        }
        const int ready=::poll(fds,count,5);if(ready<=0)return;
        for(size_t i=0;i<count;i++)if(fds[i].revents){
            std::scoped_lock lock(mutex);auto *s=Ticket(tickets[i]);
            if(!s||s->reset_pending||(listeners[i]?s->listener:s->socket)!=fds[i].fd)continue;
            if(listeners[i]){
                if(fds[i].revents&POLLIN){sockaddr_in peer{};socklen_t n=sizeof(peer);int fd=::accept(s->listener,reinterpret_cast<sockaddr*>(&peer),&n);
                    if(fd>=0){if(peer.sin_addr.s_addr!=htonl(INADDR_LOOPBACK)||!s->expected_local_port||ntohs(peer.sin_port)!=s->expected_local_port||!Nonblocking(fd)){CloseFd(fd,true);}else{SuppressSigpipe(fd);CloseFd(s->listener);s->socket=fd;if(s->remote_fin&&!s->rx.size)::shutdown(fd,SHUT_WR);}}
                }
                if(fds[i].revents&(POLLERR|POLLNVAL))ResetStream(*s,Reason::Closed);
                continue;
            }
            // Drain readable bytes before handling HUP; POLLIN|HUP is not data loss.
            if((fds[i].revents&(POLLIN|POLLHUP))&&s->opened&&!s->local_eof&&s->tx.Free()){
                uint8_t bytes[MaxChunk];const ssize_t n=::recv(s->socket,bytes,std::min(MaxChunk,s->tx.Free()),0);
                if(n>0)s->tx.Push(bytes,n);else if(n==0)s->local_eof=true;
                else if(errno!=EAGAIN&&errno!=EWOULDBLOCK&&errno!=EINTR){ResetStream(*s,Reason::Closed);continue;}
            }
            if(s->rx.size&&!s->read_closed&&(fds[i].revents&POLLOUT)){
                uint8_t bytes[MaxChunk];const size_t count=s->rx.Peek(bytes,MaxChunk);
                const ssize_t n=SendSocket(s->socket,bytes,count);
                if(n>0){s->rx.Drop(n);s->rx_consumed+=n;s->window_pending=true;}
                else if(n<0&&errno!=EAGAIN&&errno!=EWOULDBLOCK&&errno!=EINTR){ResetStream(*s,Reason::Closed);continue;}
            }
            if(s->remote_fin&&!s->rx.size)::shutdown(s->socket,SHUT_WR);
            if((fds[i].revents&(POLLERR|POLLNVAL))&&!s->local_eof){ResetStream(*s,Reason::Closed);continue;}
            FinishIfDrained(*s);
        }
    }
    void Loop(){
        while(running){
            uint8_t bytes[PrefixBytes+HeaderBytes+MaxChunk];size_t n=0;uint64_t epoch=0,ticket=0;
            for(size_t budget=0;budget<16&&Next(bytes,&n,&epoch,&ticket);budget++){
                // Never call transport while holding the stream mutex.
                const bool accepted=send&&send(user,epoch,bytes,n);std::scoped_lock lock(mutex);
                if(auto *s=Ticket(ticket);s&&s->in_flight){s->in_flight--;if(accepted)FinishIfDrained(*s);}
                if(!accepted)for(auto &s:streams)if(s.used&&s.epoch==epoch)ResetStream(s,Reason::Closed,false);
            }
            PumpSockets();
        }
    }
};

Proxy::Proxy(SendFunction send,void *user):impl(nullptr){
#if defined(__SWITCH__)
    // The module's allocator is only 128KiB. This fixed, measured data budget
    // belongs in BSS, never in that allocator. Horizon owns one global proxy.
    alignas(Impl) static uint8_t storage[sizeof(Impl)]{};
    static bool claimed=false;
    if(!claimed){claimed=true;impl=new(storage) Impl(send,user);}
#else
    impl=new(std::nothrow) Impl(send,user);
#endif
}
Proxy::~Proxy(){
#if defined(__SWITCH__)
    if(impl)impl->~Impl();
#else
    delete impl;
#endif
}
void Proxy::SetSession(const GameSession &session){
    if(!impl)return;
    struct Replay {uint64_t epoch;uint8_t body[68];} replay[MaxStreams];size_t count=0;
    {
    std::scoped_lock lock(impl->mutex);
    // An unrelated scanner/finalizing ldn:u object cannot tear down the active
    // game binding merely because it belongs to the same application process.
    if(!session.active&&(impl->session.active||impl->binding_claimed)&&impl->session.binding_id&&session.binding_id!=impl->session.binding_id)return;
    const bool change=!Same(impl->session.owner,session.owner)||impl->session.binding_id!=session.binding_id||impl->session.transport_epoch!=session.transport_epoch||impl->session.session_nonce!=session.session_nonce||std::memcmp(impl->session.network_id,session.network_id,32);
    if(change||!session.active)for(auto &s:impl->streams)if(s.used)impl->ResetStream(s,Reason::Session,session.transport_epoch==impl->session.transport_epoch);
    if(impl->session.transport_epoch!=session.transport_epoch)impl->next_id=1;
    impl->session=session;
    for(auto &s:impl->streams)if(s.used&&!impl->Peer(s.peer_ip))impl->ResetStream(s,Reason::Session);
    if(session.active)for(auto &p:impl->pending)if(p.used){
        Frame f;const bool parsed=Parse(p.body,sizeof(p.body),&f);
        if(!parsed||p.epoch!=session.transport_epoch||p.deadline<=Now()||
           (p.binding&&p.binding!=session.binding_id)||(p.owner.process&&!Same(p.owner,session.owner))||
           (change&&std::memcmp(f.data,session.network_id,32))){
            if(parsed)impl->Reject(f,Reason::Session,p.epoch);
            p.used=false;continue;
        }
        if(impl->Active(session.owner)&&impl->Peer(f.peer)&&!std::memcmp(f.data,session.network_id,32)){
            replay[count].epoch=p.epoch;std::memcpy(replay[count].body,p.body,sizeof(p.body));count++;p.used=false;
        }
    }
    }
    // Replay only after releasing the stream lock. OnFrame revalidates current
    // session, peer, network ID and the actual registered listener.
    for(size_t i=0;i<count;i++)OnFrame(replay[i].epoch,replay[i].body,sizeof(replay[i].body));
}
void Proxy::BeginBinding(const GameSession &session){
    if(!impl||!session.owner.process||!session.owner.program||!session.binding_id)return;
    std::scoped_lock lock(impl->mutex);
    for(auto &s:impl->streams)if(s.used)impl->ResetStream(s,Reason::Session,session.transport_epoch==impl->session.transport_epoch);
    for(auto &p:impl->pending)if(p.used){Frame f;if(Parse(p.body,sizeof(p.body),&f))impl->Reject(f,Reason::Session,p.epoch);p.used=false;}
    if(impl->session.transport_epoch!=session.transport_epoch)impl->next_id=1;
    impl->session=session;impl->session.active=false;impl->binding_claimed=true;
}
void Proxy::EndBinding(uint64_t binding){
    if(!impl||!binding)return;
    std::scoped_lock lock(impl->mutex);
    const bool current=impl->session.binding_id==binding;
    for(auto &p:impl->pending)if(p.used&&(p.binding==binding||(current&&!p.binding&&p.epoch==impl->session.transport_epoch))){Frame f;if(Parse(p.body,sizeof(p.body),&f))impl->Reject(f,Reason::Session,p.epoch);p.used=false;}
    if(current){impl->session.active=false;impl->binding_claimed=false;for(auto &s:impl->streams)if(s.used)impl->ResetStream(s,Reason::Session);}
}
void Proxy::TransportClosed(uint64_t epoch){if(!impl)return;std::scoped_lock lock(impl->mutex);for(auto &p:impl->pending)if(p.used&&p.epoch==epoch)p.used=false;if(impl->session.transport_epoch!=epoch)return;impl->session.active=false;impl->binding_claimed=false;for(auto &s:impl->streams)if(s.used)impl->ResetStream(s,Reason::Closed,false);}
void Proxy::PeerLeft(uint32_t peer){if(!impl)return;std::scoped_lock lock(impl->mutex);for(auto &p:impl->pending)if(p.used&&Get32(p.body)==peer)p.used=false;for(auto &s:impl->streams)if(s.used&&s.peer_ip==peer)impl->ResetStream(s,Reason::Closed,false);for(auto &ip:impl->session.peers)if(ip==peer)ip=0;}
void Proxy::ClientOpen(Owner owner){if(!impl)return;std::scoped_lock lock(impl->mutex);for(auto &c:impl->clients)if(c.refs&&Same(c.owner,owner)){c.refs++;return;}for(auto &c:impl->clients)if(!c.refs){c={owner,1};return;}}
void Proxy::ClientClose(Owner owner){if(!impl)return;std::scoped_lock lock(impl->mutex);for(auto &c:impl->clients)if(c.refs&&Same(c.owner,owner)){if(--c.refs)return;break;}for(auto &p:impl->pending)if(p.used&&Same(p.owner,owner))p.used=false;for(auto &a:impl->aliases)if(a.used&&Same(a.owner,owner))impl->CloseAlias(owner,a.fd);if(Same(impl->session.owner,owner)){impl->session.active=false;impl->binding_claimed=false;}}
bool Proxy::SocketCreated(Owner owner,int fd,int type){if(!impl)return false;std::scoped_lock lock(impl->mutex);return impl->AddSocket(owner,fd,type);}
void Proxy::Bound(Owner owner,int fd,Endpoint address){if(!impl)return;std::scoped_lock lock(impl->mutex);if(auto *o=impl->Find(owner,fd))o->local=address;}
void Proxy::AssignedPort(Owner owner,int fd,uint16_t port){if(!impl)return;std::scoped_lock lock(impl->mutex);if(auto *o=impl->Find(owner,fd);o&&!o->local.port)o->local.port=port;}
void Proxy::ShutdownExempt(Owner owner,int fd,bool exempt){if(!impl)return;std::scoped_lock lock(impl->mutex);if(auto *o=impl->Find(owner,fd))o->shutdown_exempt=exempt;}
void Proxy::Listening(Owner owner,int fd,int backlog){if(!impl)return;std::scoped_lock lock(impl->mutex);if(auto *o=impl->Find(owner,fd);o&&o->type==SOCK_STREAM){o->listening=true;o->backlog=std::clamp(backlog,1,int(MaxStreams));}}
bool Proxy::Duplicated(Owner owner,int original,int duplicate){if(!impl)return false;std::scoped_lock lock(impl->mutex);auto *o=impl->Find(owner,original);if(!o)return false;if(original==duplicate)return true;if(impl->Find(owner,duplicate))impl->CloseAlias(owner,duplicate);for(auto &a:impl->aliases)if(!a.used){a={true,owner,duplicate,o->id};o->refs++;return true;}return false;}
void Proxy::Closed(Owner owner,int fd){if(!impl)return;std::scoped_lock lock(impl->mutex);impl->CloseAlias(owner,fd);}
bool Proxy::IsStreamSocket(Owner owner,int fd)const{if(!impl)return false;std::scoped_lock lock(impl->mutex);auto *o=impl->Find(owner,fd);return o&&o->type==SOCK_STREAM;}
bool Proxy::IsListening(Owner owner,int fd)const{if(!impl)return false;std::scoped_lock lock(impl->mutex);auto *o=impl->Find(owner,fd);return o&&o->listening;}
bool Proxy::IsVirtualDestination(Owner owner,uint32_t ip)const{if(!impl)return false;std::scoped_lock lock(impl->mutex);return impl->Virtual(owner,ip);}
bool Proxy::BeginConnect(Owner owner,int fd,Endpoint destination,uint16_t source_port,Plan *plan,int *error){
    if(!impl||!plan||!error)return false;
    std::scoped_lock lock(impl->mutex);auto *o=impl->Find(owner,fd);
    if(!o||o->type!=SOCK_STREAM||!impl->Virtual(owner,destination.ip))return false;
    *error=0;if(o->managed){*error=o->state==State::Pending?Already:o->state==State::Connected?106:o->error;return true;}
    if(!impl->Active(owner)||o->shutdown_exempt){*error=Unsupported;return true;}if(!impl->Peer(destination.ip)||!destination.port||!source_port){*error=Unreachable;return true;}
    if(!impl->started||!impl->next_id){*error=Buffers;return true;}auto *s=impl->Allocate();if(!s){*error=Buffers;return true;}
    uint16_t port=0;s->listener=Listener(&port);if(s->listener<0){impl->Release(*s);*error=Buffers;return true;}
    s->initiator=true;s->owner=owner;s->object=o->id;s->epoch=impl->session.transport_epoch;s->nonce=impl->session.session_nonce;s->id=impl->next_id++;
    s->peer_ip=destination.ip;s->local_port=source_port;s->peer_port=destination.port;s->expected_local_port=source_port;s->open_pending=true;s->deadline=Now()+5000;std::memcpy(s->network_id,impl->session.network_id,32);
    o->managed=true;o->state=State::Pending;o->ticket=s->ticket;o->error=0;o->local={impl->session.self_ip,source_port};o->peer=destination;
    *plan={s->ticket,port,o->local,o->peer};return true;
}
bool Proxy::PrepareAccept(Owner owner,int listener,Plan *plan,int *error){
    if(!impl||!plan||!error)return false;
    std::scoped_lock lock(impl->mutex);auto *o=impl->Find(owner,listener);
    if(!o||!o->listening||!impl->Active(owner))return false;
    *error=Again;for(auto &s:impl->streams)if(s.used&&!s.initiator&&!s.accepted&&!s.reset_pending&&s.listener_object==o->id){
        uint16_t port=0;s.listener=Listener(&port);if(s.listener<0){impl->ResetStream(s,Reason::Capacity);*error=Buffers;return true;}
        s.accepted=true;s.deadline=Now()+5000;*plan={s.ticket,port,{impl->session.self_ip,s.local_port},{s.peer_ip,s.peer_port}};*error=0;return true;
    }
    return true;
}
bool Proxy::AttachAccepted(Owner owner,int fd,uint64_t ticket,uint16_t source_port){if(!impl)return false;std::scoped_lock lock(impl->mutex);auto *s=impl->Ticket(ticket);if(!s||s->initiator||!s->accepted||!Same(s->owner,owner)||!impl->Active(owner)||!source_port)return false;if(!impl->AddSocket(owner,fd,SOCK_STREAM))return false;auto *o=impl->Find(owner,fd);o->managed=true;o->state=State::Connected;o->ticket=ticket;o->local={impl->session.self_ip,s->local_port};o->peer={s->peer_ip,s->peer_port};s->object=o->id;s->expected_local_port=source_port;s->deadline=0;return true;}
bool Proxy::ExpectLocalPeer(uint64_t ticket,uint16_t port){if(!impl||!port)return false;std::scoped_lock lock(impl->mutex);auto *s=impl->Ticket(ticket);if(!s)return false;s->expected_local_port=port;return true;}
void Proxy::Cancel(uint64_t ticket,Reason reason){if(!impl)return;std::scoped_lock lock(impl->mutex);if(auto *s=impl->Ticket(ticket))impl->ResetStream(*s,reason);}
Status Proxy::GetStatus(Owner owner,int fd)const{if(!impl)return {};std::scoped_lock lock(impl->mutex);auto *o=impl->Find(owner,fd);return o?Status{o->state,o->error,o->legacy}:Status{};}
int Proxy::TakeSocketError(Owner owner,int fd){if(!impl)return Buffers;std::scoped_lock lock(impl->mutex);auto *o=impl->Find(owner,fd);if(!o)return 0;const int error=o->pending_error;o->pending_error=0;return error;}
bool Proxy::Addresses(Owner owner,int fd,Endpoint *local,Endpoint *peer)const{if(!impl)return false;std::scoped_lock lock(impl->mutex);auto *o=impl->Find(owner,fd);if(!o)return false;if(!o->managed&&(peer||!local||!o->listening||!impl->Active(owner)))return false;if(local)*local=o->local;if(peer)*peer=o->peer;return true;}
bool Proxy::PendingAccept(Owner owner,int fd)const{if(!impl)return false;std::scoped_lock lock(impl->mutex);auto *o=impl->Find(owner,fd);if(!o||!o->listening)return false;for(auto &s:impl->streams)if(s.used&&!s.initiator&&!s.accepted&&!s.reset_pending&&s.listener_object==o->id)return true;return false;}
bool Proxy::IsVirtualListener(Owner owner,int fd)const{if(!impl)return false;std::scoped_lock lock(impl->mutex);auto *o=impl->Find(owner,fd);return o&&o->listening&&impl->Active(owner)&&(!o->local.ip||o->local.ip==impl->session.self_ip);}
bool Proxy::HasLegacyStream()const{if(!impl)return false;std::scoped_lock lock(impl->mutex);for(const auto &s:impl->streams)if(s.used&&s.legacy)return true;return false;}
bool Proxy::Shutdown(Owner owner,int fd,int how,int *error){if(!impl||!error)return false;std::scoped_lock lock(impl->mutex);auto *o=impl->Find(owner,fd);if(!o||!o->managed)return false;*error=0;if(how<0||how>2){*error=Invalid;return true;}auto *s=impl->Ticket(o->ticket);if(!s){*error=o->error?o->error:NotConnected;return true;}if(how==0||how==2){s->read_closed=true;s->rx_consumed+=s->rx.size;s->rx.Clear();s->window_pending=true;}return true;}
void Proxy::ShutdownAll(Owner owner,int how){if(!impl||how<0||how>2)return;std::scoped_lock lock(impl->mutex);for(auto &s:impl->streams)if(s.used&&Same(s.owner,owner)&&(how==0||how==2)){s.read_closed=true;s.rx_consumed+=s.rx.size;s.rx.Clear();s.window_pending=true;}}
bool Proxy::OnFrame(uint64_t epoch,const void *body,size_t bytes){
    if(!impl)return false;
    Frame f;if(!Parse(body,bytes,&f))return false;std::scoped_lock lock(impl->mutex);
    if(!impl->Active(impl->session.owner)||epoch!=impl->session.transport_epoch||!impl->Peer(f.peer))return false;
    auto *s=impl->Wire(f);
    if(f.op==Op::Open){
        if(s)return true;
        if(std::memcmp(f.data,impl->session.network_id,32)){impl->Reject(f,Reason::Session);return false;}
        Impl::Object *listener=nullptr;size_t pending=0;bool exempt_listener=false;
        for(auto &o:impl->objects)if(o.used&&o.listening&&o.type==SOCK_STREAM&&Same(o.owner,impl->session.owner)&&
            (!o.local.ip||o.local.ip==impl->session.self_ip)&&o.local.port==f.destination_port){if(o.shutdown_exempt){exempt_listener=true;continue;}if(listener){impl->Reject(f,Reason::Refused);return false;}listener=&o;}
        if(!listener){impl->Reject(f,exempt_listener?Reason::Unsupported:Reason::Refused);return false;}
        for(auto &x:impl->streams)if(x.used&&x.listener_object==listener->id&&!x.accepted)pending++;
        if(pending>=static_cast<size_t>(listener->backlog)||(s=impl->Allocate())==nullptr){impl->Reject(f,Reason::Capacity);return false;}
        s->owner=impl->session.owner;s->listener_object=listener->id;s->epoch=epoch;s->id=f.id;s->nonce=f.nonce;s->peer_ip=f.peer;s->local_port=f.destination_port;s->peer_port=f.source_port;s->peer_window=f.aux;s->opened=true;s->ack_pending=true;s->deadline=Now()+30000;return true;
    }
    if(!s){impl->Reject(f,Reason::Closed);return false;}
    if(s->reset_pending)return false;
    switch(f.op){
        case Op::OpenOk:case Op::LegacyReady:
            if(!s->initiator||s->opened||(f.op==Op::LegacyReady&&!(impl->session.capabilities&LegacyCapability))){impl->ResetStream(*s,Reason::Protocol);return false;}
            s->opened=true;s->legacy=f.op==Op::LegacyReady;s->peer_window=f.aux;s->deadline=0;if(auto *o=impl->ById(s->object)){o->state=State::Connected;o->legacy=s->legacy;}return true;
        case Op::Data:
            if(!s->opened||s->remote_fin||f.seq!=s->rx_next||f.size>s->rx.Free()||UINT64_MAX-s->rx_next<f.size){impl->ResetStream(*s,Reason::Protocol);return false;}
            s->rx_next+=f.size;if(s->read_closed){s->rx_consumed+=f.size;s->window_pending=true;}else s->rx.Push(f.data,f.size);return true;
        case Op::Window:
            if(!s->opened||f.seq<s->peer_consumed||f.seq>s->tx_sent||UINT64_MAX-f.seq<f.aux){impl->ResetStream(*s,Reason::Protocol);return false;}s->peer_consumed=f.seq;s->peer_window=f.aux;impl->FinishIfDrained(*s);return true;
        case Op::Fin:
            if(!s->opened||s->remote_fin||f.seq!=s->rx_next){impl->ResetStream(*s,Reason::Protocol);return false;}s->remote_fin=true;if(s->socket>=0&&!s->rx.size)::shutdown(s->socket,SHUT_WR);impl->FinishIfDrained(*s);return true;
        case Op::Reset:impl->ResetStream(*s,static_cast<Reason>(f.aux),false);return true;
        default:impl->ResetStream(*s,Reason::Protocol);return false;
    }
}
bool Proxy::StageOpen(uint64_t epoch,const void *body,size_t bytes){
    if(!impl||!epoch||bytes!=68)return false;
    Frame f;if(!Parse(body,bytes,&f)||f.op!=Op::Open)return false;
    bool immediate=false;
    {
        std::scoped_lock lock(impl->mutex);
        immediate=impl->Active(impl->session.owner)&&epoch==impl->session.transport_epoch&&impl->Peer(f.peer)&&!std::memcmp(f.data,impl->session.network_id,32);
        if(!immediate){
            for(auto &p:impl->pending)if(p.used&&p.epoch==epoch&&Get32(p.body)==f.peer&&Get32(p.body+8)==f.id&&Get64(p.body+12)==f.nonce){
                if(std::memcmp(p.body,body,bytes)){impl->Reject(f,Reason::Protocol,epoch);p.used=false;return false;}return true;
            }
            for(auto &p:impl->pending)if(!p.used){
                p.used=true;p.epoch=epoch;p.deadline=Now()+5000;p.binding=0;p.owner={};
                if(impl->session.transport_epoch==epoch||!impl->session.transport_epoch){p.binding=impl->session.binding_id;p.owner=impl->session.owner;}
                std::memcpy(p.body,body,bytes);return true;
            }
            impl->Reject(f,Reason::Capacity,epoch);return false;
        }
    }
    return OnFrame(epoch,body,bytes);
}
void Proxy::CancelStaged(uint64_t epoch,const Frame &f){if(!impl||f.op!=Op::Reset||f.owner!=0)return;std::scoped_lock lock(impl->mutex);for(auto &p:impl->pending)if(p.used&&p.epoch==epoch&&Get32(p.body)==f.peer&&Get32(p.body+8)==f.id&&Get64(p.body+12)==f.nonce)p.used=false;}
Metrics Proxy::GetMetrics()const{Metrics m;if(!impl)return m;std::scoped_lock lock(impl->mutex);m.worker=impl->started;for(auto &a:impl->aliases)m.sockets+=a.used;for(auto &p:impl->pending)m.pending_opens+=p.used;for(auto &s:impl->streams)if(s.used){m.streams++;m.pending_accepts+=!s.initiator&&!s.accepted;m.buffered_bytes+=s.tx.size+s.rx.size;}return m;}

#if defined(__SWITCH__)
namespace {bool SendGlobal(void*,uint64_t epoch,const uint8_t *body,size_t size){return ams::mitm::lanywhere::SendTcpFrame(epoch,body,size);}}
#else
namespace {bool SendGlobal(void*,uint64_t,const uint8_t*,size_t){return false;}}
#endif
Proxy &Global(){static Proxy proxy(SendGlobal,nullptr);return proxy;}
void UpdateGameSession(const GameSession &s){Global().SetSession(s);}
void ResetTransport(uint64_t epoch){Global().TransportClosed(epoch);}
void ReceiveFrame(uint64_t epoch,const void *body,size_t size){Frame f;if(!Parse(body,size,&f))return;if(f.op==Op::Open)Global().StageOpen(epoch,body,size);else{Global().CancelStaged(epoch,f);Global().OnFrame(epoch,body,size);}}
}
