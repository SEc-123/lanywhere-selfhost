#!/usr/bin/env python3
"""Actual recovery functions with deterministic clock and socket boundary doubles."""
from pathlib import Path
import re,subprocess,tempfile,hashlib,os,shlex
HERE=Path(__file__).resolve().parents[1] / 'source'
source=(HERE/'lanywhere_relay.cpp').read_text()
header=(HERE/'lanywhere_relay.hpp').read_text()
at=header.index('    struct Status {');status_decl=header[at:header.index('};',at)+2]
def function(signature):
    start=source.index(signature);masked=re.sub(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"',lambda m:' '*len(m[0]),source,flags=re.S)
    brace=masked.index('{',start);depth=0
    for at in range(brace,len(masked)):
        depth+=(masked[at]=='{')-(masked[at]=='}')
        if not depth:return source[start:at+1]
    raise ValueError(signature)
fixture=r'''
#include <cassert>
#include <atomic>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <vector>
#include <netinet/in.h>
#include "transport_recovery.hpp"
using u8=uint8_t;using u16=uint16_t;using u32=uint32_t;using u64=uint64_t;using s64=int64_t;
using namespace ams::mitm::lanywhere;
static s64 now_ms;static int mode,attempts,installs,closed,sends,close_transport;static std::vector<int>budgets;static std::vector<s64>sleeps;
enum class RelayState:u8{Idle=0,Connecting=1,InRoom=2,Error=3};static RelayState g_state;
static std::mutex g_lock;static bool g_recovering;static u32 g_token,g_my_ip;static u64 g_game_id;static u8 g_my_index;
static sockaddr_in g_server;static char g_room_provider[33],g_code[7],g_error[64];
namespace os {
struct TimeSpan{s64 ms;static TimeSpan FromMilliSeconds(s64 n){return{n};}s64 GetMilliSeconds()const{return ms;}};
struct Tick{s64 ms;TimeSpan ToTimeSpan()const{return{ms};}};
Tick GetSystemTick(){return{now_ms};}Tick operator-(Tick a,Tick b){return{a.ms-b.ms};}
void SleepThread(TimeSpan n){assert(n.ms>0&&n.ms<=100);sleeps.push_back(n.ms);now_ms+=n.ms;if(mode==4){g_state=RelayState::Idle;g_recovering=false;g_error[0]=0;}}
}
using TimeSpan=os::TimeSpan;constexpr TimeSpan ReconnectWindow{55000};constexpr int ConnectTimeoutMs=5000,CodeLength=6;constexpr u8 T_Resume=6,T_Leave=3;
static os::Tick g_last_keepalive;
/* STATUS_DECL */
struct TestMember{bool present;};static TestMember g_members[8]{};static u32 g_sent=0,g_received=0;constexpr char ConfigError[]="bad config";
bool LoadServer(sockaddr_in*){return true;}void GetStatus(Status*);

namespace util {void Strlcpy(char*d,const char*s,size_t n){std::snprintf(d,n,"%s",s);}}
u32 le32(const u8*p){return (u32)p[0]|((u32)p[1]<<8)|((u32)p[2]<<16)|((u32)p[3]<<24);}u64 le64(const u8*p){return le32(p)|((u64)le32(p+4)<<32);}
void put32(u8*p,u32 n){for(int i=0;i<4;i++)p[i]=n>>(8*i);}void put64(u8*p,u64 n){put32(p,n);put32(p+4,n>>32);}
struct Session{int tcp,udp;bool no_seat;u8 error_code;u8 reply[128];size_t reply_size;char error[64];};
void CloseSockets(){++close_transport;}
void Install(const Session&){++installs;}
void Log(const char*,...){}
static int fake_close(int fd){assert(fd==71||fd==72);++closed;return 0;}
#define close fake_close
bool SendFrameTo(int fd,u8 type,const void*,size_t,const void*,size_t){assert(fd==71&&type==T_Leave);++sends;return true;}
bool Handshake(const sockaddr_in&server,u8 type,const u8*body,size_t size,Session*s,int timeout,const char*provider,int budget){
 ++attempts;budgets.push_back(budget);assert(type==T_Resume&&size==10&&le32(body)==42&&!std::memcmp(body+4,"ABC234",6));
 assert(server.sin_addr.s_addr==0x0100007f&&server.sin_port==1234&&!std::strcmp(provider,"lanplay-cn-jax"));
 assert(timeout>0&&timeout<=5000&&timeout<=budget&&budget==55000-now_ms);
 assert(g_recovering&&!std::strcmp(g_error,"Reconnecting to the room."));Status view{};GetStatus(&view);assert(view.state==RelayState::Connecting&&g_state==RelayState::InRoom&&!std::strcmp(view.error,"Reconnecting to the room."));
 *s={};s->tcp=71;s->udp=72;s->no_seat=mode==2;
 if(mode==2)return false;
 if((mode==20||mode==21)&&attempts<3){s->error_code=mode==20?7:5;return false;}
 if(mode==3){now_ms+=budget<5000?budget:5000;return false;}
 if(mode==4)return false;
 if(mode==1&&attempts<3){now_ms+=100;return false;}
 now_ms+=100;s->reply_size=24;std::memcpy(s->reply,"ABC234",6);s->reply[6]=2;put32(s->reply+7,0x0a0d0203);put32(s->reply+11,42);put64(s->reply+15,777);
 if(mode==5){g_state=RelayState::Idle;g_recovering=false;g_error[0]=0;}
 if(mode==6){g_token=43;g_recovering=false;std::strcpy(g_error,"new owner error");}
 if(mode>=10&&mode<=14){size_t at[]={0,6,7,11,15};s->reply[at[mode-10]]^=1;}
 return true;
}
/* ACTUAL */
#undef close
void reset(int m){mode=m;now_ms=attempts=installs=closed=sends=close_transport=0;budgets.clear();sleeps.clear();g_state=RelayState::InRoom;g_recovering=false;g_token=42;g_my_ip=0x0a0d0203;g_my_index=2;g_game_id=777;g_server={};g_server.sin_addr.s_addr=0x0100007f;g_server.sin_port=1234;std::strcpy(g_room_provider,"lanplay-cn-jax");std::strcpy(g_code,"ABC234");std::strcpy(g_error,"stale prior error");}
int main(){
 reset(1);assert(Reconnect()==RecoveryResult::Resumed);assert(attempts==3&&installs==1&&close_transport==1&&!g_recovering&&!g_error[0]);assert(now_ms==3300&&g_last_keepalive.ms==3300&&g_my_ip==0x0a0d0203&&g_token==42);Status view{};GetStatus(&view);assert(view.state==RelayState::InRoom&&!view.error[0]);s64 total=0;for(auto n:sleeps)total+=n;assert(total==3000);
 for(int busy:{20,21}){reset(busy);assert(Reconnect()==RecoveryResult::Resumed&&attempts==3&&now_ms==10100&&installs==1);}
 reset(2);assert(Reconnect()==RecoveryResult::Expired&&attempts==1&&installs==0&&sleeps.empty());
 reset(3);assert(Reconnect()==RecoveryResult::TimedOut&&now_ms==55000&&attempts==7&&installs==0);assert(budgets.back()==3000);
 reset(4);assert(Reconnect()==RecoveryResult::Cancelled&&now_ms==100&&attempts==1&&g_state==RelayState::Idle&&!g_error[0]);
 reset(5);assert(Reconnect()==RecoveryResult::Cancelled&&installs==0&&closed==2&&!g_error[0]);
 reset(6);assert(Reconnect()==RecoveryResult::Cancelled&&g_token==43&&installs==0&&closed==2&&!std::strcmp(g_error,"new owner error"));
 for(int m=10;m<=14;m++){reset(m);assert(Reconnect()==RecoveryResult::Rejected&&installs==0&&closed==2&&g_my_ip==0x0a0d0203&&g_game_id==777&&g_token==42);}
 reset(0);g_state=RelayState::Idle;assert(Reconnect()==RecoveryResult::Cancelled&&attempts==0&&close_transport==0);
 now_ms=42;assert(RemainingIoMs(5000,0)==5000&&RemainingIoMs(5000,100)==58&&RemainingIoMs(20,100)==20&&RemainingIoMs(5000,42)==0);
 TcpLiveness live;live.Sent(0);live.Sent(5000);assert(!live.Expired(14999)&&live.Expired(15000));live.Acknowledge();assert(!live.Expired(50000));live.Sent(50000);assert(live.Expired(65000));live.Reset();assert(!live.Expired(999999));
 std::puts("Actual Reconnect: same-provider identity, retry/backoff/deadline, expired/cancel/replacement gates and stale-error cleanup passed");
}
'''
actual=function('int RemainingIoMs(')+'\n'+function('void GetStatus(')+'\n'+function('RecoveryResult Reconnect(')
with tempfile.TemporaryDirectory(prefix='reconnect-state-') as d:
 d=Path(d);cpp=d/'test.cpp';exe=d/'test';cpp.write_text(fixture.replace('/* STATUS_DECL */',status_decl).replace('/* ACTUAL */',actual))
 subprocess.run(shlex.split(os.environ.get('CXX','c++'))+['-std=c++17','-Wall','-Wextra','-Werror','-pthread','-I'+str(HERE),str(cpp),'-o',str(exe)],check=True,timeout=30)
 subprocess.run([str(exe)],check=True,timeout=10)
print('Actual source SHA256',hashlib.sha256(source.encode()).hexdigest())
