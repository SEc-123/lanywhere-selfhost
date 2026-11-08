#!/usr/bin/env python3
"""Actual Worker/UDP re-registration/liveness paths; no public network or device I/O."""
from pathlib import Path
import hashlib, subprocess, tempfile, os, shlex
base=Path(__file__).resolve().parents[1] / 'source'
source=(base/'lanywhere_relay.cpp').read_text()
def extract(signature):
 start=source.index(signature); i=source.index('{',start); depth=0
 for j in range(i,len(source)):
  if source[j]=='{':depth+=1
  elif source[j]=='}':
   depth-=1
   if not depth:return source[start:j+1]
 raise RuntimeError(signature)
functions='\n'.join(extract(s) for s in ('        bool RecoverTransport(', '        bool RegisterUdpAgain(', '        void Worker(void *)'))
preamble=r'''
#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cstring>
#include <mutex>
#include <cstdio>
#include <cerrno>
#include <cstdlib>
#include "transport_recovery.hpp"
using namespace ams::mitm::lanywhere;
using u8=uint8_t;using u16=uint16_t;using u32=uint32_t;using u64=uint64_t;using s64=int64_t;
constexpr size_t MaxPayload=1472;constexpr int POLLIN=1,POLLHUP=2,POLLERR=4,POLLNVAL=8;using ssize_t=long;
struct pollfd {int fd;short events,revents;};
static s64 clock_ms=0;static int scenario=0,outer_polls=0,reconnect_calls=0,ping_count=0,close_calls=0,registration_count=0;static char stored_error[128]={};
namespace os {struct TimeSpan {s64 ms; s64 GetMilliSeconds()const{return ms;} bool operator>=(const TimeSpan&other)const{return ms>=other.ms;}};struct Tick {s64 ms;TimeSpan ToTimeSpan()const{return {ms};}};Tick operator-(Tick a,Tick b){return {a.ms-b.ms};} Tick GetSystemTick(){return {clock_ms};}}
static os::TimeSpan KeepAliveInterval={5000};static os::Tick g_last_keepalive={0};
enum class RelayState{Idle=0,Connecting=1,InRoom=2,Error=3}; static RelayState g_state=RelayState::InRoom;
static std::mutex g_lock,g_send_lock;static std::atomic<u64> g_stream_epoch{1};static std::atomic<bool>g_stream_ready{true};
static int g_tcp=10,g_udp=11,g_server=0,g_received=0;static u32 g_udp_features=8,g_heartbeat_sequence=0;static bool g_recovering=false;static char g_error[64]={};
constexpr u32 CapabilityFragment=4,CapabilityHeartbeat=8,UdpMagic=0x594e414c; enum {U_DataIn=0x82,U_DataFragmentIn=0x85,U_HeartbeatAck=0x86,U_RegisterV2=4,U_RegisteredV2=0x84,U_Heartbeat=6,U_KeepAlive=3,T_Ping=5,T_Pong=0x86};
static u32 le32(const u8*b){return u32(b[0])|(u32(b[1])<<8)|(u32(b[2])<<16)|(u32(b[3])<<24);}static u16 le16(const u8*b){return b[0]|u16(b[1])<<8;}static void put32(u8*b,u32 v){for(int i=0;i<4;i++)b[i]=v>>(8*i);}
static void Log(const char*,...){}static void Enqueue(const u8*,size_t){}static void EnqueueDatagram(u32,u16,u16,const u8*,size_t){}
struct Fragments {template<class F>void Push(u32,u16,u16,u32,u16,u16,const u8*,size_t,u64,F){}void Reset(){}};static Fragments g_fragments;
struct HeartbeatTracker{bool needs=(scenario==1||scenario==4);void Acknowledge(u32){} bool NeedsRegistration(){return needs;}void Reset(){needs=false;} void Sent(u32){}};
namespace util {void Strlcpy(char*dst,const char*src,size_t n){std::snprintf(dst,n,"%s",src);}}
static bool UdpSend(int type,const u8*,size_t){if(type==U_RegisterV2)registration_count++;return true;}
static ssize_t UdpReceiveFrom(int,int,u8*b,size_t){if(scenario!=4)return -1;put32(b,UdpMagic);b[4]=U_RegisteredV2;put32(b+5,g_udp_features);return 9;}
static ssize_t ReadFrame(int,u8*type,u8*,size_t,int){*type=T_Pong;return 0;}static void HandleFrame(u8,const u8*,size_t,u64){}
static bool SendFrame(int,const u8*,size_t){ping_count++;return true;}static void RefreshHostMetadata(){}
static RecoveryResult Reconnect(){reconnect_calls++;g_recovering=true;if(scenario==8){g_state=RelayState::Idle;g_recovering=false;return RecoveryResult::Cancelled;}if(scenario==9)return RecoveryResult::Expired;return RecoveryResult::TimedOut;}
static void SetError(const char*s){std::snprintf(stored_error,sizeof(stored_error),"%s",s);g_state=RelayState::Error;}
static void CloseSockets(){close_calls++;}
static int poll(pollfd*p,int nfds,int wait){for(int i=0;i<nfds;i++)p[i].revents=0;if(nfds==1){clock_ms+=std::max(1,wait);if(scenario==4){p[0].revents=POLLIN;return 1;}return 0;}
 clock_ms+=1000;outer_polls++;
 if(scenario==7&&outer_polls==1){errno=EINTR;return -1;}
 if((scenario==3&&clock_ms>40000)||(scenario==4&&registration_count)||(scenario==7&&outer_polls>1)){g_state=RelayState::Idle;return 0;}
 if(scenario==3&&ping_count){p[0].revents=POLLIN;return 1;}
 if(scenario==5||scenario==8||scenario==9||scenario==10){p[0].revents=POLLNVAL;return 1;}
 if(scenario==6){p[1].revents=POLLERR;return 1;}
 return 0;}
'''
post=r'''
int main(int argc,char**argv){if(argc!=2)return 10;scenario=std::atoi(argv[1]);Worker(nullptr);if(close_calls!=1)return 11;
 switch(scenario){
 case 1:if(!registration_count||reconnect_calls!=1)return 12;puts("PASS: failed UDP re-registration invokes recovery");break;
 case 2:if(clock_ms<20000||reconnect_calls!=1||ping_count<3)return 13;puts("PASS: absent PONG for 15 seconds from first PING invokes recovery");break;
 case 3:if(reconnect_calls||ping_count<6||clock_ms<40000)return 14;puts("PASS: timely PONGs avoid recovery");break;
 case 4:if(!registration_count||reconnect_calls||g_recovering||g_error[0])return 15;puts("PASS: UDP re-registration succeeds without TCP recovery and clears error");break;
 case 5:if(reconnect_calls!=1)return 16;puts("PASS: TCP POLLNVAL invokes recovery");break;
 case 6:if(reconnect_calls!=1)return 17;puts("PASS: UDP POLLERR invokes recovery");break;
 case 7:if(reconnect_calls)return 18;puts("PASS: EINTR alone does not invoke recovery");break;
 case 8:if(reconnect_calls!=1||g_state!=RelayState::Idle||stored_error[0])return 19;puts("PASS: cancellation does not overwrite Idle");break;
 case 9:if(g_state!=RelayState::Error||std::strcmp(stored_error,"Room session expired. Rejoin from the game."))return 20;puts("PASS: expired seat error is explicit");break;
 case 10:if(g_state!=RelayState::Error||std::strcmp(stored_error,"Could not reconnect. Check Wi-Fi and rejoin."))return 21;puts("PASS: timeout error differs from expired seat");break;
 default:return 22;}return 0;}
'''
out=Path(__file__).parent
with tempfile.TemporaryDirectory(prefix='relay-recovery-worker-') as td:
 p=Path(td);(p/'worker.cpp').write_text(preamble+functions+'\n'+post)
 subprocess.run(shlex.split(os.environ.get('CXX','c++'))+['-std=c++17','-Wall','-Wextra','-Werror','-I',str(base),str(p/'worker.cpp'),'-o',str(p/'worker')],check=True,timeout=30)
 for mode in range(1,11):subprocess.run([str(p/'worker'),str(mode)],check=True,timeout=30)
print('Actual relay SHA256:',hashlib.sha256(source.encode()).hexdigest())
print('Actual Worker/RegisterUdpAgain/RecoverTransport and TcpLiveness with deterministic mock I/O, clock and mocked Reconnect; not actual Switch.')
