/* Actual Proxy -> actual relay TCP -> actual Proxy fixture. GPL-2.0-only. */
#include "tcp_stream_proxy.hpp"
#include <algorithm>
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstring>
#include <functional>
#include <iostream>
#include <map>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>
#include <arpa/inet.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>
using namespace ams::mitm::tcpstream;
using Clock=std::chrono::steady_clock;
static void Until(const std::function<bool()> &f,const char *what,int ms=6000) {
    const auto end=Clock::now()+std::chrono::milliseconds(ms);
    while(Clock::now()<end){if(f())return;std::this_thread::sleep_for(std::chrono::milliseconds(2));}
    std::cerr<<"timeout: "<<what<<'\n';std::abort();
}
static void ConfigureFd(int fd,bool small=false) {
    const int one=1;assert(!::setsockopt(fd,IPPROTO_TCP,TCP_NODELAY,&one,sizeof(one)));
#ifdef SO_NOSIGPIPE
    assert(!::setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&one,sizeof(one)));
#endif
    if(small){const int bytes=4096;assert(!::setsockopt(fd,SOL_SOCKET,SO_SNDBUF,&bytes,sizeof(bytes)));assert(!::setsockopt(fd,SOL_SOCKET,SO_RCVBUF,&bytes,sizeof(bytes)));}
}
static bool Write(int fd,const void *data,size_t size) {
    const auto *p=static_cast<const uint8_t*>(data);
    while(size){
#ifdef MSG_NOSIGNAL
        const ssize_t n=::send(fd,p,size,MSG_NOSIGNAL);
#else
        const ssize_t n=::send(fd,p,size,0);
#endif
        if(n<0&&errno==EINTR)continue;
        if(n<=0)return false;
        p+=n;size-=static_cast<size_t>(n);
    }return true;
}
static bool Read(int fd,void *data,size_t size,const std::atomic<bool> &running) {
    auto *p=static_cast<uint8_t*>(data);
    while(size&&running){pollfd event{fd,POLLIN,0};const int ready=::poll(&event,1,100);
        if(ready<0&&errno==EINTR)continue;
        if(ready<0)return false;
        if(!ready)continue;
        const ssize_t n=::recv(fd,p,size,0);if(n<0&&errno==EINTR)continue;if(n<=0)return false;p+=n;size-=static_cast<size_t>(n);
    }return !size;
}
struct Packet {uint8_t type;std::vector<uint8_t> body;};
class Control {
    int fd=-1;std::mutex send_lock,budget_lock;std::thread reader;
    std::atomic<bool> running{true};Proxy *proxy=nullptr;
    std::map<int64_t,std::pair<size_t,size_t>> budget;
    uint64_t sent_bytes=0,consumed_bytes=0,peak_outstanding=0;uint16_t peer_window=0;
    Packet Receive(){uint8_t header[3];if(!Read(fd,header,sizeof(header),running))return {0,{}};
        const size_t length=Get16(header);assert(length>=1&&length<=4096);Packet p{header[2],std::vector<uint8_t>(length-1)};
        if(!Read(fd,p.body.data(),p.body.size(),running))return {0,{}};
        return p;}
public:
    std::atomic<unsigned> errors{0},resets{0},pongs{0},unexpected_close{0},rejected_ingress{0};
    uint32_t ip=0,token=0,caps=0;std::vector<uint8_t> code;
    explicit Control(uint16_t port){fd=::socket(AF_INET,SOCK_STREAM,0);assert(fd>=0);ConfigureFd(fd);
        sockaddr_in a{};a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);a.sin_port=htons(port);assert(!::connect(fd,reinterpret_cast<sockaddr*>(&a),sizeof(a)));}
    ~Control(){Stop();}
    bool Send(uint8_t type,const uint8_t *body=nullptr,size_t size=0){
        std::scoped_lock lock(send_lock);if(!running)return false;
        std::vector<uint8_t> bytes(3+size);Put16(bytes.data(),size+1);bytes[2]=type;if(size)std::memcpy(bytes.data()+3,body,size);
        if(type==Command){const int64_t second=std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
            std::scoped_lock budget_guard(budget_lock);auto &b=budget[second];b.first+=size+55;b.second++;
            Frame frame;assert(Parse(body,size,&frame));if(frame.op==Op::Data){assert(frame.seq==sent_bytes);sent_bytes+=frame.size;
                assert(sent_bytes>=consumed_bytes&&sent_bytes-consumed_bytes<=peer_window);peak_outstanding=std::max(peak_outstanding,sent_bytes-consumed_bytes);}}
        return Write(fd,bytes.data(),bytes.size());
    }
    void Enter(const std::vector<uint8_t> *room=nullptr){
        assert(Send(0x0b));auto reply=Receive();assert(reply.type==0x89&&reply.body.size()==4);caps=Get32(reply.body.data());assert(caps==255);
        std::vector<uint8_t> body(room?47:41);if(room)std::copy(room->begin(),room->end(),body.begin());body.back()=3;
        assert(Send(room?2:1,body.data(),body.size()));reply=Receive();assert(reply.type==0x81&&reply.body.size()>=24);
        code.assign(reply.body.begin(),reply.body.begin()+6);ip=Get32(reply.body.data()+7);token=Get32(reply.body.data()+11);assert(ip&&token);
    }
    void Start(Proxy &p){proxy=&p;reader=std::thread([this]{while(running){auto frame=Receive();if(!frame.type){if(running)unexpected_close++;break;}
        if(frame.type==Response){Frame parsed;assert(Parse(frame.body.data(),frame.body.size(),&parsed));if(parsed.op==Op::Reset)resets++;
            {std::scoped_lock lock(budget_lock);if(parsed.op==Op::Open||parsed.op==Op::OpenOk||parsed.op==Op::LegacyReady)peer_window=parsed.aux;
                if(parsed.op==Op::Window){assert(parsed.seq>=consumed_bytes&&parsed.seq<=sent_bytes);consumed_bytes=parsed.seq;peer_window=parsed.aux;}}
            if(!proxy->OnFrame(1,frame.body.data(),frame.body.size()))rejected_ingress++;}
        else if(frame.type==0x85){errors++;std::cerr<<"relay error "<<(frame.body.empty()?-1:int(frame.body[0]))<<'\n';}
        else if(frame.type==0x86)pongs++;
    }});}
    void Leave(){const unsigned before=pongs;assert(Send(3)&&Send(5));Until([&]{return pongs>before;},"LEAVE/PONG");}
    void Stop(){if(!running.exchange(false))return;if(fd>=0)::shutdown(fd,SHUT_RDWR);if(reader.joinable())reader.join();if(fd>=0){::close(fd);fd=-1;}}
    std::pair<size_t,size_t> Peak(){std::scoped_lock lock(budget_lock);std::pair<size_t,size_t> p{};for(const auto &e:budget){p.first=std::max(p.first,e.second.first);p.second=std::max(p.second,e.second.second);}return p;}
    uint64_t FinalCredit(){std::scoped_lock lock(budget_lock);assert(sent_bytes==consumed_bytes&&peak_outstanding>0&&peak_outstanding<=LocalWindow);return peak_outstanding;}
    static bool Transport(void *context,uint64_t epoch,const uint8_t *body,size_t size){return epoch==1&&static_cast<Control*>(context)->Send(Command,body,size);}
};
static int GameSocket(uint16_t *port){const int fd=::socket(AF_INET,SOCK_STREAM,0);assert(fd>=0);ConfigureFd(fd,true);
    sockaddr_in a{};a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);assert(!::bind(fd,reinterpret_cast<sockaddr*>(&a),sizeof(a)));
    socklen_t n=sizeof(a);assert(!::getsockname(fd,reinterpret_cast<sockaddr*>(&a),&n));*port=ntohs(a.sin_port);return fd;}
static void ConnectLocal(int fd,uint16_t port){sockaddr_in a{};a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);a.sin_port=htons(port);assert(!::connect(fd,reinterpret_cast<sockaddr*>(&a),sizeof(a)));}
static std::vector<uint8_t> ReadSlow(int fd,size_t size){std::vector<uint8_t> out(size);size_t done=0;const auto end=Clock::now()+std::chrono::seconds(18);
    while(done<size&&Clock::now()<end){pollfd p{fd,POLLIN,0};if(::poll(&p,1,50)<=0)continue;const ssize_t n=::recv(fd,out.data()+done,std::min<size_t>(2048,size-done),0);assert(n>0);done+=static_cast<size_t>(n);std::this_thread::sleep_for(std::chrono::milliseconds(2));}
    assert(done==size);return out;}
static void Eof(int fd){Until([&]{pollfd p{fd,POLLIN,0};if(::poll(&p,1,0)<=0)return false;uint8_t byte;const auto n=::recv(fd,&byte,1,0);assert(n==0);return true;},"game FIN/EOF");}
int main(int argc,char **argv){
    assert(argc==2);const auto port=static_cast<uint16_t>(std::stoul(argv[1]));Control a(port),b(port);a.Enter();b.Enter(&a.code);
    Proxy pa(Control::Transport,&a),pb(Control::Transport,&b);Owner oa{100,0x0100000000011111},ob{200,0x0100000000022222};
    GameSession sa{},sb{};sa.owner=oa;sa.transport_epoch=1;sa.session_nonce=71;sa.binding_id=1;sa.capabilities=a.caps;sa.self_ip=a.ip;sa.peers[0]=b.ip;sa.active=true;sa.network_id[0]=42;
    sb=sa;sb.owner=ob;sb.session_nonce=72;sb.binding_id=2;sb.self_ip=b.ip;sb.peers[0]=a.ip;pa.SetSession(sa);pb.SetSession(sb);a.Start(pa);b.Start(pb);
    uint16_t listen_port,source_port,accepted_port;const int listener=GameSocket(&listen_port);assert(!::listen(listener,4));assert(pb.SocketCreated(ob,listener,SOCK_STREAM));pb.Bound(ob,listener,{0,listen_port});pb.Listening(ob,listener,4);
    const int client=GameSocket(&source_port);assert(pa.SocketCreated(oa,client,SOCK_STREAM));pa.Bound(oa,client,{a.ip,source_port});Plan connect;int error=0;
    assert(pa.BeginConnect(oa,client,{b.ip,listen_port},source_port,&connect,&error)&&!error);ConnectLocal(client,connect.proxy_port);
    Until([&]{return pa.GetStatus(oa,client).state==State::Connected&&pb.PendingAccept(ob,listener);},"real relay OPEN/OPEN_OK");
    Plan accept;assert(pb.PrepareAccept(ob,listener,&accept,&error)&&!error);const int accepted=GameSocket(&accepted_port);assert(pb.AttachAccepted(ob,accepted,accept.ticket,accepted_port));ConnectLocal(accepted,accept.proxy_port);
    constexpr size_t Amount=256*1024;std::vector<uint8_t> forward(Amount),reverse(Amount);for(size_t i=0;i<Amount;i++){forward[i]=static_cast<uint8_t>(i*19+7);reverse[i]=static_cast<uint8_t>(i*37+11);}
    std::atomic<bool> watch{true},a_done{false},b_done{false};std::atomic<size_t> peak_a{0},peak_b{0};
    std::thread monitor([&]{while(watch){const auto ma=pa.GetMetrics(),mb=pb.GetMetrics();assert(ma.buffered_bytes<=8*2*16384&&mb.buffered_bytes<=8*2*16384);peak_a=std::max(peak_a.load(),ma.buffered_bytes);peak_b=std::max(peak_b.load(),mb.buffered_bytes);std::this_thread::sleep_for(std::chrono::milliseconds(2));}});
    std::thread writer_a([&]{assert(Write(client,forward.data(),forward.size()));assert(!::shutdown(client,SHUT_WR));int e=0;assert(pa.Shutdown(oa,client,1,&e)&&!e);a_done=true;});
    std::thread writer_b([&]{assert(Write(accepted,reverse.data(),reverse.size()));assert(!::shutdown(accepted,SHUT_WR));int e=0;assert(pb.Shutdown(ob,accepted,1,&e)&&!e);b_done=true;});
    // Kernel TCP buffering differs by OS. Measure protocol credit directly;
    // whether application send() already returned is diagnostic, not proof.
    std::this_thread::sleep_for(std::chrono::milliseconds(300));const bool producer_blocked=!a_done&&!b_done;
    std::vector<uint8_t> got_a,got_b;std::thread reader_a([&]{got_a=ReadSlow(client,Amount);});std::thread reader_b([&]{got_b=ReadSlow(accepted,Amount);});
    reader_a.join();reader_b.join();writer_a.join();writer_b.join();assert(got_a==reverse&&got_b==forward);Eof(client);Eof(accepted);
    Until([&]{return !pa.GetMetrics().streams&&!pb.GetMetrics().streams;},"both final credits and proxy cleanup");watch=false;monitor.join();
    assert(!a.errors&&!b.errors&&!a.resets&&!b.resets&&!a.unexpected_close&&!b.unexpected_close&&!a.rejected_ingress&&!b.rejected_ingress);
    const auto ap=a.Peak(),bp=b.Peak();const auto ac=a.FinalCredit(),bc=b.FinalCredit();assert(ap.first<=512*1024&&bp.first<=512*1024&&ap.second<=1000&&bp.second<=1000);
    ::close(client);pa.Closed(oa,client);::close(accepted);pb.Closed(ob,accepted);::close(listener);pb.Closed(ob,listener);
    assert(pa.GetMetrics().sockets==0&&pb.GetMetrics().sockets==0);a.Leave();b.Leave();a.Stop();b.Stop();
    std::cout<<"{\"status\":\"passed\",\"bytes_each_direction\":"<<Amount<<",\"caps\":255,\"member_features\":3,\"slow_reader_delay_ms\":300,\"producer_blocked_before_read\":"<<(producer_blocked?"true":"false")<<",\"peak_outstanding_bytes\":["<<ac<<','<<bc<<"],\"peak_proxy_bytes\":["<<peak_a<<','<<peak_b<<"],\"peak_wire_bytes_per_second\":["<<ap.first<<','<<bp.first<<"],\"peak_frames_per_second\":["<<ap.second<<','<<bp.second<<"],\"busy_or_reset\":0,\"proxy_streams_after\":0,\"game_fd_aliases_after\":0,\"leave_pong\":true}"<<'\n';
}
