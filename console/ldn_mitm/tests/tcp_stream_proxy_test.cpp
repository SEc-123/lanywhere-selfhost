/* Actual portable proxy/socket tests, GPL-2.0-only. No Switch or public service is used. */
#include "../source/tcp_stream_proxy.hpp"
#include <algorithm>
#include <array>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstring>
#include <functional>
#include <iostream>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>
#include <arpa/inet.h>
#include <fcntl.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
using namespace ams::mitm::tcpstream;
using Clock=std::chrono::steady_clock;
static void Until(const std::function<bool()> &predicate,const char *what,int ms=5000){
    const auto end=Clock::now()+std::chrono::milliseconds(ms);
    while(Clock::now()<end){if(predicate())return;std::this_thread::sleep_for(std::chrono::milliseconds(1));}
    std::cerr<<"timeout: "<<what<<'\n';std::abort();
}
static int GameSocket(uint16_t *port){
    const int fd=::socket(AF_INET,SOCK_STREAM,0);assert(fd>=0);
#ifdef SO_NOSIGPIPE
    const int one=1;assert(::setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&one,sizeof(one))==0);
#endif
    sockaddr_in a{};a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    assert(::bind(fd,reinterpret_cast<sockaddr*>(&a),sizeof(a))==0);socklen_t n=sizeof(a);
    assert(::getsockname(fd,reinterpret_cast<sockaddr*>(&a),&n)==0);*port=ntohs(a.sin_port);return fd;
}
static void ConnectProxy(int fd,uint16_t port){sockaddr_in a{};a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);a.sin_port=htons(port);assert(::connect(fd,reinterpret_cast<sockaddr*>(&a),sizeof(a))==0);}
static void WriteAll(int fd,const std::vector<uint8_t> &bytes){size_t done=0;while(done<bytes.size()){
#ifdef MSG_NOSIGNAL
    const ssize_t n=::send(fd,bytes.data()+done,bytes.size()-done,MSG_NOSIGNAL);
#else
    const ssize_t n=::send(fd,bytes.data()+done,bytes.size()-done,0);
#endif
    assert(n>0);done+=static_cast<size_t>(n);
}}
static std::vector<uint8_t> ReadExactly(int fd,size_t size,int ms=12000){
    std::vector<uint8_t> bytes(size);size_t done=0;const auto end=Clock::now()+std::chrono::milliseconds(ms);
    while(done<size&&Clock::now()<end){pollfd p{fd,POLLIN,0};if(::poll(&p,1,20)<=0)continue;const ssize_t n=::recv(fd,bytes.data()+done,size-done,0);assert(n>0);done+=static_cast<size_t>(n);}
    assert(done==size);return bytes;
}
struct Route {
    std::mutex lock;Proxy *destination=nullptr;uint32_t source=0;bool enabled=true;
    uint64_t window_max=0;size_t frames=0;std::vector<std::pair<Clock::time_point,size_t>> traffic;
    static bool Send(void *pointer,uint64_t epoch,const uint8_t *body,size_t size){
        auto &r=*static_cast<Route*>(pointer);std::scoped_lock guard(r.lock);if(!r.enabled||!r.destination)return false;
        Frame parsed;assert(Parse(body,size,&parsed));if(parsed.op==Op::Window)r.window_max=std::max(r.window_max,parsed.seq);
        r.frames++;r.traffic.push_back({Clock::now(),size+55});
        std::array<uint8_t,PrefixBytes+HeaderBytes+MaxChunk> copy{};std::memcpy(copy.data(),body,size);Put32(copy.data(),r.source);
        r.destination->OnFrame(epoch,copy.data(),size);return true; // Transport acceptance, not application OPEN approval.
    }
    void Disable(){std::scoped_lock guard(lock);enabled=false;}
    uint64_t Window(){std::scoped_lock guard(lock);return window_max;}
};
struct Pair {
    Route ab,ba;std::unique_ptr<Proxy> a,b;Owner oa{101,0x0100000000011111},ob{202,0x0100000000022222};
    GameSession sa{},sb{};
    Pair(){
        ab.source=0x0a0d0101;ba.source=0x0a0d0202;a=std::make_unique<Proxy>(Route::Send,&ab);b=std::make_unique<Proxy>(Route::Send,&ba);ab.destination=b.get();ba.destination=a.get();
        sa.owner=oa;sa.transport_epoch=1;sa.session_nonce=10101;sa.capabilities=Capability;sa.self_ip=ab.source;sa.peers[0]=ba.source;sa.active=true;sa.network_id[0]=42;
        sb=sa;sb.owner=ob;sb.session_nonce=20202;sb.self_ip=ba.source;sb.peers[0]=ab.source;a->SetSession(sa);b->SetSession(sb);
    }
    ~Pair(){ab.Disable();ba.Disable();a.reset();b.reset();}
    int Listen(uint16_t *port,uint32_t logical=0){const int fd=GameSocket(port);assert(::listen(fd,4)==0);assert(b->SocketCreated(ob,fd,SOCK_STREAM));b->Bound(ob,fd,{logical,*port});b->Listening(ob,fd,4);return fd;}
    int Connect(uint16_t target,Plan *plan){uint16_t source;const int fd=GameSocket(&source);assert(a->SocketCreated(oa,fd,SOCK_STREAM));a->Bound(oa,fd,{sa.self_ip,source});int error=0;assert(a->BeginConnect(oa,fd,{sb.self_ip,target},source,plan,&error)&&!error);ConnectProxy(fd,plan->proxy_port);return fd;}
    int Accept(int listener){Plan plan;int error=0;Until([&]{return b->PendingAccept(ob,listener);},"pending virtual accept");assert(b->PrepareAccept(ob,listener,&plan,&error)&&!error);uint16_t source;const int fd=GameSocket(&source);assert(b->AttachAccepted(ob,fd,plan.ticket,source));ConnectProxy(fd,plan.proxy_port);return fd;}
    void CloseA(int fd){::close(fd);a->Closed(oa,fd);}void CloseB(int fd){::close(fd);b->Closed(ob,fd);}
};
int main(){
    {Pair p;uint16_t port;const int listener=p.Listen(&port);Plan plan;const int client=p.Connect(port,&plan);
        Until([&]{return p.a->GetStatus(p.oa,client).state==State::Connected;},"remote OPEN_OK");
        // OPEN_OK represents a reserved virtual backlog, not an unsafe dial to a local port.
        assert(p.b->GetMetrics().pending_accepts==1);
        std::vector<uint8_t> payload(512*1024);for(size_t i=0;i<payload.size();i++)payload[i]=uint8_t(i*19+7);
        const int small_buffer=4096;assert(::setsockopt(client,SOL_SOCKET,SO_SNDBUF,&small_buffer,sizeof(small_buffer))==0);
        std::atomic<bool> sent{false};std::thread sender([&]{WriteAll(client,payload);sent=true;});
        // Delay the game's Accept entirely: no local receiving socket exists to
        // hide data in kernel buffers. Exactly the advertised window may enter
        // the virtual backlog; the sender must stop without dropping bytes.
        Until([&]{return p.b->GetMetrics().buffered_bytes==LocalWindow;},"bounded pre-accept credit");
        assert(!sent);assert(p.a->GetMetrics().buffered_bytes<=256*1024);assert(p.b->GetMetrics().buffered_bytes<=256*1024);
        const int accepted=p.Accept(listener);
        Endpoint local{},peer{};assert(p.b->Addresses(p.ob,accepted,&local,&peer));assert(peer.ip==p.sa.self_ip&&local.ip==p.sb.self_ip&&local.port==port);
        assert(ReadExactly(accepted,payload.size())==payload);sender.join();
        std::vector<uint8_t> reply(7003,0x6d);WriteAll(accepted,reply);assert(ReadExactly(client,reply.size())==reply);
        assert(::shutdown(client,SHUT_WR)==0);int error=0;assert(p.a->Shutdown(p.oa,client,1,&error)&&!error);
        Until([&]{pollfd q{accepted,POLLIN,0};if(::poll(&q,1,0)<=0)return false;char c;return ::recv(accepted,&c,1,0)==0;},"ordered FIN/EOF");
        assert(::shutdown(accepted,SHUT_WR)==0);assert(p.b->Shutdown(p.ob,accepted,1,&error)&&!error);
        Until([&]{return p.a->GetMetrics().streams==0&&p.b->GetMetrics().streams==0;},"final WINDOWs and both halves retired");
        assert(p.ba.Window()==payload.size());assert(p.ab.Window()==reply.size());
        p.CloseA(client);p.CloseB(accepted);p.CloseB(listener);
        std::cout<<"ordered 512KiB stream, pre-accept credit backpressure, virtual addresses, half-close and final credits passed\n";
    }
    {Pair p;uint16_t port;const int listener=p.Listen(&port,0x7f000001);Plan plan;const int client=p.Connect(port,&plan);
        Until([&]{return p.a->GetStatus(p.oa,client).state==State::Failed;},"loopback-bound listener refusal");assert(p.a->GetStatus(p.oa,client).error==111);assert(!p.b->PendingAccept(p.ob,listener));p.CloseA(client);p.CloseB(listener);
        std::cout<<"remote OPEN cannot address a loopback-only game listener\n";
    }
    {Pair p;uint16_t port;const int listener=p.Listen(&port);p.sb.capabilities=0;p.b->SetSession(p.sb);
        uint8_t bytes[68]{};Frame f;f.peer=p.sa.self_ip;f.id=1;f.nonce=77;f.op=Op::Open;f.source_port=1000;f.destination_port=port;f.size=32;f.data=p.sa.network_id;f.aux=LocalWindow;
        const size_t n=Encode(bytes,sizeof(bytes),f);assert(n&&!p.b->OnFrame(1,bytes,n));assert(p.b->GetMetrics().streams==0);p.CloseB(listener);
        std::cout<<"incoming stream requires negotiated capability\n";
    }
    {Pair p;uint16_t port;const int listener=p.Listen(&port);Plan plan;const int client=p.Connect(port,&plan);Until([&]{return p.a->GetStatus(p.oa,client).state==State::Connected;},"dup setup");const int accepted=p.Accept(listener);
        const int duplicate=::dup(client);assert(duplicate>=0&&p.a->Duplicated(p.oa,client,duplicate));p.CloseA(client);
        std::vector<uint8_t> data(4096,42);WriteAll(duplicate,data);assert(ReadExactly(accepted,data.size())==data);
        assert(p.a->SocketCreated({303,p.oa.program},duplicate,SOCK_STREAM));assert(p.a->GetStatus({303,p.oa.program},duplicate).state==State::Unmanaged);assert(p.a->GetStatus(p.oa,duplicate).state==State::Connected);
        p.a->Closed({303,p.oa.program},duplicate);p.a->TransportClosed(1);Until([&]{return p.a->GetStatus(p.oa,duplicate).state==State::Failed;},"transport reset");
        p.CloseA(duplicate);p.CloseB(accepted);p.CloseB(listener);std::cout<<"dup lifetime, process/fd isolation and transport reset passed\n";
    }
}
