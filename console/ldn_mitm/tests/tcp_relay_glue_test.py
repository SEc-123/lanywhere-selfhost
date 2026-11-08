#!/usr/bin/env python3
"""Run exact relay glue slices and the actual Proxy against deterministic ABI mocks.

Only syscall/IPC boundaries are replaced. Stream parsing/admission is the real
portable proxy, not a test-side copy. No SDK, game, device or public network.
"""
import hashlib
import importlib.util
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
NATIVE = ROOT / 'console/ldn_mitm/source'
spec = importlib.util.spec_from_file_location('extract', Path(__file__).with_name('discovery_route_test.py'))
extract = importlib.util.module_from_spec(spec); spec.loader.exec_module(extract)
sources = {name: (NATIVE / name).read_text() for name in (
    'lanywhere_relay.cpp', 'lanywhere_relay.hpp', 'tcp_stream_protocol.hpp',
    'tcp_stream_proxy.hpp', 'tcp_stream_proxy.cpp', 'lan_discovery.cpp')}
relay = sources['lanywhere_relay.cpp']; header = sources['lanywhere_relay.hpp']

def function(signature):
    return extract.function(relay, signature)

def declaration(source, signature):
    at=source.index(signature)
    return source[at:source.index('};',at)+2]

# Bind the dispatch test to the actual read site, not just an unused helper.
worker = function('void Worker(')
assert 'read_epoch=g_stream_epoch.load();' in worker
assert 'ReadFrame(p[0].fd,' in worker and 'HandleFrame(type, buf, n, read_epoch)' in worker
assert worker.index('read_epoch=g_stream_epoch.load();') < worker.index('::poll(p,')
poll_room=extract.function(sources['lan_discovery.cpp'],'void LANDiscovery::pollRoom(')
assert poll_room.index('lanywhere::TakeControl(')<poll_room.index('this->onRoomMessage(')<poll_room.index('this->refreshTcpBinding();')
binding=extract.function(sources['lan_discovery.cpp'],'void LANDiscovery::refreshTcpBinding(')
assert 'CommState::StationConnected' in binding and 'tcpstream::UpdateGameSession(session);' in binding
connect_room=extract.function(sources['lan_discovery.cpp'],'Result LANDiscovery::connectRoom(')
assert connect_room.index('tcpstream::Global().BeginBinding(pending);')<connect_room.index('lanywhere::SendControl(host, lanywhere::LdnMsg::Connect')

prelude = r'''
#include <algorithm>
#include <array>
#include <atomic>
#include <cassert>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <thread>
#include <vector>
#include <sys/socket.h>
#include <arpa/inet.h>
#include <poll.h>
#include "tcp_stream_proxy.hpp"
#include "list_status.h"
using u8=uint8_t;using u16=uint16_t;using u32=uint32_t;using u64=uint64_t;using s32=int32_t;using s64=int64_t;
static_assert(sizeof(u8)==1&&sizeof(u16)==2&&sizeof(u32)==4&&sizeof(u64)==8);
namespace os {
 using SdkMutex=std::mutex;
 struct Span{s64 ms;s64 GetMilliSeconds()const{return ms;}};
 struct Tick{s64 ms;Span ToTimeSpan()const{return {ms};}};
 inline Tick operator-(Tick a,Tick b){return {a.ms-b.ms};}
 inline Tick GetSystemTick(){return {std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count()};}
}
namespace util {inline void Strlcpy(char *out,const char *in,size_t size){if(size){size_t n=std::min(size-1,std::strlen(in));std::memcpy(out,in,n);out[n]=0;}}}
namespace real_tcp=ams::mitm::tcpstream;
static std::unique_ptr<real_tcp::Proxy> proxy;
static unsigned ingress_calls=0,ingress_accepted=0;
static u64 ingress_epoch=0;
namespace test_tcpstream {
 using Frame=real_tcp::Frame;using real_tcp::Parse;using real_tcp::Op;using real_tcp::PrefixBytes;using real_tcp::HeaderBytes;
 constexpr auto Command=real_tcp::Command,Response=real_tcp::Response;
 constexpr auto Capability=real_tcp::Capability,MemberFeature=real_tcp::MemberFeature;
 // Count at the ABI seam while every decision runs in the actual Proxy.
 struct Forwarder {
  bool OnFrame(u64 epoch,const void *body,size_t size){ingress_calls++;ingress_epoch=epoch;const bool ok=proxy->OnFrame(epoch,body,size);ingress_accepted+=ok;return ok;}
  bool StageOpen(u64 epoch,const void *body,size_t size){ingress_calls++;ingress_epoch=epoch;const bool ok=proxy->StageOpen(epoch,body,size);ingress_accepted+=ok;return ok;}
  void CancelStaged(u64 epoch,const Frame &frame){proxy->CancelStaged(epoch,frame);}
  void PeerLeft(u32 peer){proxy->PeerLeft(peer);}
  real_tcp::Metrics GetMetrics(){return proxy->GetMetrics();}
  bool HasLegacyStream(){return proxy->HasLegacyStream();}
 };
 inline Forwarder &Global(){assert(proxy);static Forwarder adapter;return adapter;}
 /* ACTUAL_RECEIVE_FRAME */
 inline void ResetTransport(u64 epoch){if(proxy)proxy->TransportClosed(epoch);}
}
namespace tcpstream=test_tcpstream;
constexpr size_t MaxMembers=8,NickLength=32,MaxControl=0x500,ControlQueueSize=16;
constexpr int ConnectTimeoutMs=5000,MatchIoTimeoutMs=900;
constexpr u32 CapabilityFragment=4,CapabilityHeartbeat=8,UdpMagic=0x594e414c;
constexpr u8 Features=1,T_Create=1,T_Join=2,T_Leave=3,T_Resume=6,T_Caps=11,T_CapsReply=0x89,
 T_Room=0x81,T_Error=0x85,T_MemberJoined=0x82,T_MemberLeft=0x83,T_RelayIn=0x84,
 U_Register=1,U_RegisterV2=4,U_Registered=0x81,U_RegisteredV2=0x84;
/* ACTUAL_RELAY_STATE */
/* ACTUAL_LDN_MESSAGE */
struct Control{u8 from;LdnMsg msg;u16 size;u8 data[MaxControl];};
static std::mutex g_lock,g_send_lock,g_queue_lock;
static RelayState g_state=RelayState::InRoom;
static std::atomic<bool> g_stream_ready{true};static std::atomic<u64> g_stream_epoch{10};
static u32 g_capabilities=255,g_my_ip=0x0a0d0101;static int g_tcp=41,g_udp=42;
static char g_error[64]{};
static Control g_controls[ControlQueueSize]{};static size_t g_control_head=0,g_control_count=0;
template<class...A>static void Log(const char*,A...){}
struct Write{int fd;std::vector<u8> bytes;};
static std::vector<Write>writes;static std::vector<int>shutdowns,closes;
static std::vector<ssize_t>send_results;static size_t send_index=0;
static ssize_t MockSend(int fd,const void *body,size_t size,int){
 const ssize_t result=send_index<send_results.size()?send_results[send_index++]:static_cast<ssize_t>(size);
 if(result<0){errno=EPIPE;return -1;}assert(static_cast<size_t>(result)<=size);
 const auto *b=static_cast<const u8*>(body);writes.push_back({fd,std::vector<u8>(b,b+result)});return result;
}
static int MockShutdown(int fd,int how){assert(how==SHUT_RDWR);shutdowns.push_back(fd);return 0;}
static int MockClose(int fd){closes.push_back(fd);return 0;}
static int MockSocket(int,int,int){return 51;}
static int MockPoll(pollfd*,nfds_t,int){return 1;}
#define send MockSend
#define shutdown MockShutdown
#define close MockClose
#define socket MockSocket
#define poll MockPoll
'''

prelude=prelude.replace('/* ACTUAL_RELAY_STATE */',declaration(header,'    enum class RelayState : u8'))
prelude=prelude.replace('/* ACTUAL_LDN_MESSAGE */',declaration(header,'    enum class LdnMsg : u8'))
prelude=prelude.replace('/* ACTUAL_RECEIVE_FRAME */',extract.function(sources['tcp_stream_proxy.cpp'],'void ReceiveFrame('))
pieces = [prelude, declaration(header,'    struct Member {'),
          '\nstatic_assert(sizeof(Member)==40 && offsetof(Member,ip)==4);\nstatic Member g_members[MaxMembers]{};\n']
for name in ('le16','le32','le64','put16','put32','put64'):
    pieces.append(function(('void ' if name.startswith('put') else 'u'+name[2:]+' ')+name+'('))
pieces += [function('bool SendFrameTo('), function('void EnqueueControl('), function('void AddMember('),
           function('bool CaptureTcpTransport('), function('bool SendTcpFrame('), function('void CloseSockets('),
           function('int MemberOfIp('), function('void HandleFrame('), function('ssize_t TakeControl('), declaration(relay,'        struct Session {')]

# ReadFrame / ConnectServer and UDP registration are the mocked external boundary;
# QueryCapabilities and Handshake below remain unchanged production functions.
pieces += [r'''
static u32 offered_caps=0;static int cap_error=0,read_stage=0;static unsigned connects=0;static u8 room_error=0;static const char*room_error_text="";
static int ConnectServer(const sockaddr_in&,const char**,int,const char*,u32*,u64){connects++;return 61;}
static ssize_t ReadFrame(int,u8 *type,u8 *body,size_t capacity,int){
 if(read_stage++==0){if(cap_error){*type=T_Error;body[0]=static_cast<u8>(cap_error);return 1;}assert(capacity>=4);*type=T_CapsReply;put32(body,offered_caps);return 4;}
 if(room_error){*type=T_Error;body[0]=room_error;const size_t n=std::strlen(room_error_text);assert(n+1<=capacity);std::memcpy(body+1,room_error_text,n);return n+1;}
 assert(capacity>=24);std::memset(body,0,24);*type=T_Room;std::memcpy(body,"ABC234",6);put32(body+7,g_my_ip);put32(body+11,1234);return 24;
}
static bool UdpSendTo(int,const sockaddr_in&,u32,u8,const void*,size_t){return true;}
static ssize_t UdpReceiveFrom(int,const sockaddr_in&,u8 *body,size_t){
 put32(body,UdpMagic);const u32 flags=cap_error?0:offered_caps&12;body[4]=flags?U_RegisteredV2:U_Registered;if(flags)put32(body+5,flags);return flags?9:5;
}
''', function('ssize_t ReadListFrame('),
    'bool QueryCapabilities(int fd,u32 *flags,int timeout_ms=MatchIoTimeoutMs,u32 *status=nullptr);',
    function('bool QueryCapabilities(int fd, u32 *flags, int timeout_ms, u32 *status) {'),
    function('bool ApplyTcpAdmissionFeatures('),
    function('int RemainingIoMs('), function('bool Handshake('), r'''
#undef send
#undef shutdown
#undef close
#undef socket
#undef poll
static void ResetMocks(){writes.clear();shutdowns.clear();closes.clear();send_results.clear();send_index=0;}
static std::atomic<unsigned> sent_open_ok{0},sent_reset{0};
static std::atomic<u64> last_reset_epoch{0};static std::atomic<u16> last_reset_reason{0};
static bool RecordOutgoing(void*,u64 epoch,const u8 *body,size_t size){real_tcp::Frame f;assert(real_tcp::Parse(body,size,&f));if(f.op==real_tcp::Op::OpenOk)sent_open_ok++;if(f.op==real_tcp::Op::Reset){last_reset_epoch=epoch;last_reset_reason=f.aux;sent_reset++;}return true;}
static std::vector<u8> Wire(real_tcp::Op op=real_tcp::Op::Open,u64 seq=0,u32 peer=0x0a0d0202,u32 id=1){
 real_tcp::Frame f;f.peer=peer;f.id=id;f.nonce=71;f.owner=0;f.op=op;f.seq=seq;
 const u8 byte=0x5a;u8 network[32]{};network[0]=42;
 if(op==real_tcp::Op::Open){f.source_port=50000;f.destination_port=3200;f.aux=16384;f.size=32;f.data=network;}
 if(op==real_tcp::Op::Data){f.size=1;f.data=&byte;}
 std::vector<u8>b(real_tcp::PrefixBytes+real_tcp::HeaderBytes+f.size);assert(real_tcp::Encode(b.data(),b.size(),f)==b.size());return b;
}
static void Configure(u64 epoch=10,u32 caps=255){
 proxy.reset();sent_open_ok=sent_reset=0;last_reset_epoch=last_reset_reason=0;proxy.reset(new real_tcp::Proxy(RecordOutgoing,nullptr));
 real_tcp::GameSession s{};s.owner={100,0x0100000000011111};s.binding_id=77;s.active=true;s.transport_epoch=epoch;s.session_nonce=55;
 s.capabilities=caps;s.self_ip=g_my_ip;s.peers[0]=0x0a0d0202;s.network_id[0]=42;proxy->SetSession(s);
 assert(proxy->SocketCreated(s.owner,7,SOCK_STREAM));proxy->Bound(s.owner,7,{0,3200});proxy->Listening(s.owner,7,4);
 g_stream_ready=true;g_stream_epoch=epoch;g_capabilities=caps;g_state=RelayState::InRoom;g_tcp=41;g_udp=42;
 g_members[0]={true,0,g_my_ip,{}};g_members[1]={true,1,0x0a0d0202,{}};
 ingress_calls=ingress_accepted=0;g_control_head=g_control_count=0;ResetMocks();
}
static real_tcp::GameSession WaitingForSync(){
 Configure();real_tcp::GameSession waiting{};waiting.owner={100,0x0100000000011111};waiting.binding_id=77;
 // Actual fresh Station refresh has not captured relay epoch/caps/peers yet.
 proxy->SetSession(waiting);return waiting;
}
static void QueueSync(){std::vector<u8> body(2+0x480);body[0]=1;body[1]=static_cast<u8>(LdnMsg::Sync);body[2]=42;
 HandleFrame(T_RelayIn,body.data(),body.size(),10);assert(g_control_count==1);}
static real_tcp::GameSession ConsumeTrustedSync(real_tcp::GameSession waiting){
 u8 from=0,network[0x480]{};LdnMsg message{};assert(TakeControl(&from,&message,network,sizeof(network))==0x480);
 assert(from==1&&message==LdnMsg::Sync);
 // Model the already-validated LANDiscovery binding publication, not LDN
 // validation itself. The preceding producer/queue/consumer are actual code.
 waiting.active=true;waiting.transport_epoch=10;waiting.capabilities=255;waiting.session_nonce=55;waiting.self_ip=g_my_ip;
 waiting.peers[0]=0x0a0d0202;std::memcpy(waiting.network_id,network,32);return waiting;
}
static void WaitForOpenOk(unsigned count=1,const char *scenario="stream OPEN"){const auto end=std::chrono::steady_clock::now()+std::chrono::milliseconds(500);
 while(sent_open_ok<count&&std::chrono::steady_clock::now()<end){std::this_thread::sleep_for(std::chrono::milliseconds(2));}
 if(sent_open_ok!=count)std::fprintf(stderr,"missing OPEN_OK: %s\n",scenario);
 assert(sent_open_ok==count);}
static void WaitForReset(){const auto end=std::chrono::steady_clock::now()+std::chrono::milliseconds(500);
 while(!sent_reset&&std::chrono::steady_clock::now()<end){std::this_thread::sleep_for(std::chrono::milliseconds(2));}assert(sent_reset>0);}
''']

# The test intentionally requires an epoch supplied by the read, not an epoch
# re-captured after replacement. Keep this failing until that glue is present.
handle = function('void HandleFrame(')
assert 'u64' in handle[:handle.index('{')], 'A4 dispatch must receive the read-start transport epoch'
pieces += [r'''
int main(){
 unsigned checks=0;Configure();const auto open=Wire();
 assert(SendTcpFrame(10,open.data(),open.size()));assert(writes.size()==1&&writes[0].fd==41&&writes[0].bytes[2]==real_tcp::Command);assert(shutdowns.empty());checks++;
 ResetMocks();send_results={3,-1};assert(!SendTcpFrame(10,open.data(),open.size()));assert(shutdowns==std::vector<int>{41});assert(!g_stream_ready);checks++;
 Configure();send_results={-1};const auto malformed=std::vector<u8>{1,2};assert(!SendTcpFrame(10,malformed.data(),malformed.size()));assert(writes.empty()&&shutdowns.empty()&&g_stream_ready);checks++;
 // Hold the actual send mutex while replacing the epoch, then release the old sender.
 Configure();bool stale_result=true;g_send_lock.lock();std::thread stale([&]{stale_result=SendTcpFrame(10,open.data(),open.size());});
 g_tcp=99;g_stream_epoch=11;g_send_lock.unlock();stale.join();assert(!stale_result&&writes.empty()&&shutdowns.empty()&&g_stream_ready);checks++;
 assert(SendTcpFrame(11,open.data(),open.size()));assert(writes.back().fd==99);checks++;
 ResetMocks();g_stream_ready=false;assert(!SendTcpFrame(11,open.data(),open.size()));assert(writes.empty()&&shutdowns.empty());checks++;
 Configure();CloseSockets();assert(!g_stream_ready&&g_stream_epoch==11&&g_tcp==-1&&g_udp==-1);assert(closes==std::vector<int>({41,42}));checks++;
 Configure();HandleFrame(real_tcp::Response,open.data(),open.size(),10);assert(ingress_accepted==1&&proxy->GetMetrics().pending_accepts==1);checks++;
 for(u64 i=0;i<40;i++){auto data=Wire(real_tcp::Op::Data,i);HandleFrame(real_tcp::Response,data.data(),data.size(),10);}
 assert(ingress_accepted==41&&proxy->GetMetrics().buffered_bytes==40&&g_control_count==0);checks++;
 const u8 departed=1;HandleFrame(T_MemberLeft,&departed,1,10);assert(!g_members[1].present&&proxy->GetMetrics().streams==0&&g_control_count==1);
 assert(g_controls[0].msg==LdnMsg::MemberLeft&&static_cast<u8>(g_controls[0].msg)==0xff);
 auto stale_peer=Wire(real_tcp::Op::Data,40);HandleFrame(real_tcp::Response,stale_peer.data(),stale_peer.size(),10);assert(ingress_accepted==41);checks++;
 Configure();HandleFrame(real_tcp::Response,open.data(),open.size()-1,10);assert(ingress_accepted==0&&proxy->GetMetrics().streams==0);checks++;
 Configure();auto foreign=Wire(real_tcp::Op::Open,0,0x0a0d0303);HandleFrame(real_tcp::Response,foreign.data(),foreign.size(),10);assert(ingress_accepted==0&&proxy->GetMetrics().streams==0);checks++;
 Configure(11);HandleFrame(real_tcp::Response,open.data(),open.size(),10);assert(!ingress_calls&&!ingress_accepted&&proxy->GetMetrics().streams==0);checks++;
 Configure(10,127);HandleFrame(real_tcp::Response,open.data(),open.size(),10);assert(!ingress_calls&&proxy->GetMetrics().streams==0);checks++;
 Configure();g_stream_ready=false;HandleFrame(real_tcp::Response,open.data(),open.size(),10);assert(!ingress_calls);checks++;
 // Reconstructed cross-channel race: valid SYNC is queued while the next A4
 // OPEN reaches Proxy directly, before pollRoom publishes StationConnected.
 {auto waiting=WaitingForSync();QueueSync();HandleFrame(real_tcp::Response,open.data(),open.size(),10);
  assert(proxy->GetMetrics().pending_accepts==0&&proxy->GetMetrics().pending_opens==1&&sent_open_ok==0&&g_control_count==1);
  proxy->SetSession(ConsumeTrustedSync(waiting));WaitForOpenOk();assert(proxy->GetMetrics().pending_accepts==1&&proxy->GetMetrics().pending_opens==0);checks++;}
 {Configure();real_tcp::GameSession connected{};connected.owner={100,0x0100000000011111};connected.binding_id=77;connected.active=true;
  connected.transport_epoch=10;connected.capabilities=255;connected.session_nonce=55;connected.self_ip=g_my_ip;connected.network_id[0]=42;
  proxy->SetSession(connected);QueueSync();HandleFrame(real_tcp::Response,open.data(),open.size(),10);
  assert(proxy->GetMetrics().pending_opens==1&&sent_open_ok==0);proxy->SetSession(ConsumeTrustedSync(connected));WaitForOpenOk();checks++;}
 // Delayed binding must not turn stale/foreign OPENs into valid connections.
 for(int denial=0;denial<6;denial++){
  auto waiting=WaitingForSync();auto candidate=open;QueueSync();
  if(denial==0)candidate[real_tcp::PrefixBytes+real_tcp::HeaderBytes]=43; // Different NetworkId.
  if(denial==2)proxy->Bound(waiting.owner,7,{0x7f000001,3200});
  if(denial==3)proxy->Closed(waiting.owner,7);
  if(denial==4)real_tcp::Put32(candidate.data(),0x0a0d0303); // Not a relay member.
  HandleFrame(real_tcp::Response,candidate.data(),candidate.size(),10);
  auto connected=ConsumeTrustedSync(waiting);
  if(denial==1){CloseSockets();g_stream_ready=true;g_tcp=99;connected.transport_epoch=11;}
  if(denial==4)connected.peers[0]=0x0a0d0303; // Later binding cannot authorize a previously foreign sender.
  if(denial==5)connected.owner.process++;
  proxy->SetSession(connected);std::this_thread::sleep_for(std::chrono::milliseconds(30));
  assert(proxy->GetMetrics().pending_accepts==0&&proxy->GetMetrics().pending_opens==0&&sent_open_ok==0);checks++;
 }
 for(int ownership=0;ownership<5;ownership++){
  auto waiting=WaitingForSync();waiting.transport_epoch=10;waiting.capabilities=255;waiting.self_ip=g_my_ip;waiting.session_nonce=55;waiting.network_id[0]=42;
  proxy->BeginBinding(waiting);
  if(ownership==4){real_tcp::GameSession scanner{};scanner.owner=waiting.owner;scanner.binding_id=88;proxy->SetSession(scanner);}
  QueueSync();HandleFrame(real_tcp::Response,open.data(),open.size(),10);assert(proxy->GetMetrics().pending_opens==1&&sent_open_ok==0);
  if(ownership==1)proxy->EndBinding(88); // Unrelated finalizer cannot cancel the claim.
  if(ownership==2){proxy->EndBinding(77);assert(proxy->GetMetrics().pending_opens==0);}
  auto connected=ConsumeTrustedSync(waiting);if(ownership==3)connected.binding_id=88;
  proxy->SetSession(connected);
  if(ownership==2||ownership==3){std::this_thread::sleep_for(std::chrono::milliseconds(30));assert(!sent_open_ok&&proxy->GetMetrics().pending_accepts==0);}
  else{WaitForOpenOk(1,ownership==4?"pending claim survives unrelated inactive scanner":"pending binding lifecycle");assert(proxy->GetMetrics().pending_accepts==1);}
  checks++;
 }
 {auto waiting=WaitingForSync();QueueSync();HandleFrame(real_tcp::Response,open.data(),open.size(),10);HandleFrame(real_tcp::Response,open.data(),open.size(),10);
  assert(proxy->GetMetrics().pending_opens==1);proxy->SetSession(ConsumeTrustedSync(waiting));WaitForOpenOk();assert(proxy->GetMetrics().pending_accepts==1);checks++;}
 {auto waiting=WaitingForSync();QueueSync();HandleFrame(real_tcp::Response,open.data(),open.size(),10);auto changed=open;real_tcp::Put16(changed.data()+30,3201);
  HandleFrame(real_tcp::Response,changed.data(),changed.size(),10);assert(proxy->GetMetrics().pending_opens==0);WaitForReset();assert(last_reset_epoch==10);
  proxy->SetSession(ConsumeTrustedSync(waiting));assert(proxy->GetMetrics().pending_accepts==0&&sent_open_ok==0);checks++;}
 {auto waiting=WaitingForSync();proxy->Listening(waiting.owner,7,8);QueueSync();
  for(u32 id=1;id<=9;id++){auto candidate=Wire(real_tcp::Op::Open,0,0x0a0d0202,id);HandleFrame(real_tcp::Response,candidate.data(),candidate.size(),10);}
  assert(proxy->GetMetrics().pending_opens==8);WaitForReset();assert(last_reset_epoch==10&&last_reset_reason==static_cast<u16>(real_tcp::Reason::Capacity));
  proxy->SetSession(ConsumeTrustedSync(waiting));WaitForOpenOk(8);assert(proxy->GetMetrics().pending_accepts==8&&proxy->GetMetrics().pending_opens==0);checks++;}
 {auto waiting=WaitingForSync();QueueSync();HandleFrame(real_tcp::Response,open.data(),open.size(),10);
  std::this_thread::sleep_for(std::chrono::milliseconds(5100));assert(proxy->GetMetrics().pending_opens==0);WaitForReset();
  assert(last_reset_epoch==10&&last_reset_reason==static_cast<u16>(real_tcp::Reason::Timeout));proxy->SetSession(ConsumeTrustedSync(waiting));
  assert(proxy->GetMetrics().pending_accepts==0&&sent_open_ok==0);checks++;}
 for(bool peer_left:{false,true}){auto waiting=WaitingForSync();QueueSync();HandleFrame(real_tcp::Response,open.data(),open.size(),10);
  if(peer_left){const u8 from=1;HandleFrame(T_MemberLeft,&from,1,10);}else{real_tcp::Frame reset;reset.peer=0x0a0d0202;reset.id=1;reset.nonce=71;reset.owner=0;reset.op=real_tcp::Op::Reset;reset.aux=static_cast<u16>(real_tcp::Reason::Closed);
   u8 bytes[36];assert(real_tcp::Encode(bytes,sizeof(bytes),reset)==sizeof(bytes));HandleFrame(real_tcp::Response,bytes,sizeof(bytes),10);}
  assert(proxy->GetMetrics().pending_opens==0);auto connected=ConsumeTrustedSync(waiting);
  if(peer_left){u8 from=0,buffer[1];LdnMsg message{};assert(TakeControl(&from,&message,buffer,sizeof(buffer))==0&&from==1&&message==LdnMsg::MemberLeft);}
  assert(g_control_count==0);proxy->SetSession(connected);
  assert(proxy->GetMetrics().pending_accepts==0&&sent_open_ok==0);checks++;}
 for(u32 caps:{0u,127u,128u,255u,256u,462u,511u})for(u8 type:{T_Create,T_Join,T_Resume}) {
  const size_t size=type==T_Create?41:type==T_Join?47:10,feature=type==T_Create?40:46;
  std::vector<u8>body(size,0x5a);if(type!=T_Resume)body[feature]=Features;
  auto original=body;ResetMocks();offered_caps=caps;cap_error=0;read_stage=0;Session session{};sockaddr_in server{};
  assert(Handshake(server,type,body.data(),size,&session));assert(session.capabilities==caps&&body==original);
  auto at=std::find_if(writes.begin(),writes.end(),[&](const Write&w){return w.bytes.size()>=3&&w.bytes[2]==type;});assert(at!=writes.end());
  std::vector<u8>sent(at->bytes.begin()+3,at->bytes.end());auto expected=original;
  if(type!=T_Resume&&caps&real_tcp::Capability)expected[feature]|=real_tcp::MemberFeature;
  assert(sent==expected);checks++;
 }
 for(u32 caps:{127u,255u}){std::vector<u8>body(65,0x5a);body[46]=Features;ResetMocks();offered_caps=caps;cap_error=0;read_stage=0;Session session{};sockaddr_in server{};assert(Handshake(server,T_Join,body.data(),body.size(),&session));
  const auto&w=writes.at(1);assert(w.bytes[2]==T_Join);auto expected=body;if(caps&real_tcp::Capability)expected[46]|=real_tcp::MemberFeature;assert(std::equal(expected.begin(),expected.end(),w.bytes.begin()+3));checks++;}
 for(u32 caps:{0u,128u,256u,511u})for(bool ready:{false,true}){u8 admission[41]{};admission[40]=0xa7;
  assert(ApplyTcpAdmissionFeatures(T_Create,admission,sizeof(admission),caps,ready));assert(admission[40]==static_cast<u8>((0xa7&~2)|((caps&128)&&ready?2:0)));checks++;}
 u8 wrong[66];std::memset(wrong,0xa7,sizeof(wrong));assert(!ApplyTcpAdmissionFeatures(T_Create,wrong,sizeof(wrong),255,true));assert(std::all_of(std::begin(wrong),std::end(wrong),[](u8 c){return c==0xa7;}));checks++;
 ResetMocks();offered_caps=255;cap_error=4;read_stage=0;Session legacy{};sockaddr_in legacy_server{};u8 legacy_body[41]{};legacy_body[40]=3;
 assert(Handshake(legacy_server,T_Create,legacy_body,sizeof(legacy_body),&legacy));assert(legacy.capabilities==0&&writes.at(1).bytes.at(43)==1&&legacy_body[40]==3);checks++;
 ResetMocks();offered_caps=255;cap_error=7;read_stage=0;Session session{};sockaddr_in server{};u8 body[41]{};body[40]=Features;
 assert(!Handshake(server,T_Create,body,sizeof(body),&session));assert(writes.size()==1&&writes[0].bytes[2]==T_Caps);checks++;
 for(const char *provider:{"self","lanywhere-public","lanplay-cn-jax"}) {
  ResetMocks();cap_error=0;offered_caps=0;read_stage=0;room_error=5;room_error_text="provider resume seat unavailable";Session recovered{};sockaddr_in endpoint{};u8 resume[10]{};
  assert(!Handshake(endpoint,T_Resume,resume,sizeof(resume),&recovered,5000,provider,55000));assert(recovered.no_seat==!std::strcmp(provider,"self"));checks++;
 }
 ResetMocks();cap_error=0;read_stage=0;room_error=5;room_error_text="seat expired";Session expired{};sockaddr_in endpoint{};u8 resume[10]{};
 assert(!Handshake(endpoint,T_Resume,resume,sizeof(resume),&expired,5000,"lanywhere-public",55000)&&expired.no_seat);checks++;
 ResetMocks();cap_error=0;read_stage=0;room_error=7;room_error_text="previous connection is active";Session busy{};
 assert(!Handshake(endpoint,T_Resume,resume,sizeof(resume),&busy,5000,"self",55000)&&!busy.no_seat);checks++;room_error=0;
 proxy.reset();std::printf("Actual relay/Proxy glue: %u epoch, failure, ingress, SYNC-order and negotiation scenarios passed.\n",checks);
}
''']

print('Source snapshots:',{name:hashlib.sha256(text.encode()).hexdigest() for name,text in sources.items()},flush=True)
with tempfile.TemporaryDirectory(prefix='tcp-relay-glue-') as temporary:
    tmp=Path(temporary)
    for name in ('tcp_stream_proxy.cpp','tcp_stream_proxy.hpp','tcp_stream_protocol.hpp'):
        (tmp/name).write_text(sources[name])
    cpp=tmp/'glue.cpp';exe=tmp/'glue';cpp.write_text('\n'.join(pieces))
    subprocess.run(shlex.split(os.environ.get('CXX','c++'))+['-std=c++17','-Wall','-Wextra','-Werror',
        '-Wno-unused-function','-pthread','-I'+str(ROOT/'common'),str(cpp),str(tmp/'tcp_stream_proxy.cpp'),'-o',str(exe)],check=True,timeout=45)
    subprocess.run([str(exe)],check=True,timeout=20)
print('Host ABI mocks plus exact production functions and Proxy; no Switch or commercial-game acceptance.')
