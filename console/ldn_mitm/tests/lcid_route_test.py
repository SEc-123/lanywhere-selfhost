#!/usr/bin/env python3
"""Exercise actual native GameRoute/CreateRoom slices with isolated configuration stubs."""
import hashlib
import importlib.util
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / 'console/ldn_mitm/source/lanywhere_relay.cpp'
HDR = ROOT / 'console/ldn_mitm/source/lanywhere_relay.hpp'
spec = importlib.util.spec_from_file_location('route_extract', Path(__file__).with_name('discovery_route_test.py'))
extract = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract)

def actual_struct(header, name):
    start = header.index('    struct ' + name + ' {')
    return header[start:header.index('};', start) + 2]

def main():
    source, header = SRC.read_text(), HDR.read_text()
    signatures = ('bool CaptureDiscoveryRoute(', 'bool CaptureGameRoute(', 'bool CaptureHostGameRoute(',
                  'bool GameRouteStillCurrent(', 'bool DiscoveryRouteStillSelected(const DiscoveryRoute &route) {', 'Result CreateRoom(', 'void LeaveGameRoom(')
    bodies = [extract.function(source, signature) for signature in signatures]
    enter = extract.function(source, 'Result Enter(')
    # The production final check must precede changing any existing room or sending a handshake.
    assert 'DiscoveryRouteStillSelected(*discovery_route)' in enter
    assert enter.index('DiscoveryRouteStillSelected(*discovery_route)') < enter.index('LeaveCurrentRoom()')
    assert enter.index('ChooseEnterRoute(pinned, discovery_route') < enter.index('Handshake(')
    assert enter.index('Install(s)') < enter.index('joined->room_token = g_token')
    route, game_route = actual_struct(header, 'DiscoveryRoute'), actual_struct(header, 'GameRoute')
    harness = r'''
#include <atomic>
#include <cassert>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <mutex>
#include <string>
#include <arpa/inet.h>
using u8=uint8_t;using u16=uint16_t;using u32=uint32_t;using u64=uint64_t;using Result=int;
#define R_RETURN(x) return (x)
constexpr size_t NickLength=32,CodeLength=6;constexpr u8 Features=3,T_Create=1;
namespace util {void Strlcpy(char *o,const char *i,size_t n){if(n){std::snprintf(o,n,"%s",i);}}}
enum class RelayState {Idle,InRoom,Connecting,Error};
static std::mutex g_lock,g_room_lifecycle_lock;static RelayState g_state=RelayState::Idle;static u32 g_token=0;static int leaves=0;
static bool g_recovering=false;
static void LeaveCurrentRoom(){leaves++;g_state=RelayState::Idle;g_token=0;}
static std::atomic<u64> g_stream_epoch{1};static std::atomic<bool> g_stream_ready{false};static sockaddr_in g_server{};
static char g_room_provider[33]="self",g_error[128]{},g_code[8]="ABC234";static bool g_public=true;
static std::string configured="self";static u32 configured_ip=htonl(0x7f000001);static u16 configured_port=htons(11460);
static bool configured_public=true,config_valid=true,change_at_nickname=false;
static bool LoadServer(sockaddr_in *server=nullptr,char *provider=nullptr){
 if(!config_valid)return false;
 g_public=configured_public;
 if(provider)util::Strlcpy(provider,configured.c_str(),33);
 if(server){*server={};server->sin_addr.s_addr=configured_ip;server->sin_port=configured_port;}return true;
}
static Result ResultRelayFailed(){return 1;}
static bool InRoom(){return g_state==RelayState::InRoom;}
namespace os {
struct Tick {
    u64 ms;
    Tick ToTimeSpan() const { return *this; }
    u64 GetMilliSeconds() const { return ms; }
};
Tick GetSystemTick() { return {1000}; }
}
static void put64(u8 *p,u64 v){for(int i=0;i<8;i++)p[i]=u8(v>>(8*i));}
static void Nickname(char *out,size_t size){std::snprintf(out,size,"test");if(change_at_nickname)configured="lanplay-cn-jax";}
''' + route + '\n' + game_route + '\n' + extract.selection_state(source) + r'''
static void CancelMatch(){ClearSelectionLocked();}
''' + '\n'.join(bodies[:5]) + r'''
static int attempted=0;static u64 sent_id=0;static std::string sent_provider;
static Result Enter(u8,const u8 *body,size_t,const sockaddr_in *,u8 *,const u8 *,const DiscoveryRoute *route,GameRoute *joined){
 // Mirrors the exact pre-LeaveCurrentRoom guard asserted against the real Enter body above.
 if(route&&(g_state==RelayState::InRoom||!DiscoveryRouteStillSelected(*route)))return 1;
 attempted++;sent_id=0;for(int i=0;i<8;i++)sent_id|=u64(body[i])<<(8*i);
 sent_provider=route?route->provider:configured;
 if(joined){*joined={};joined->discovery=*route;joined->room_epoch=g_stream_epoch.load();joined->room_token=91;std::memcpy(joined->room_code,"ABC234",6);}return 0;
}
''' + bodies[5] + '\n' + bodies[6] + r'''
static void reset(){ClearSelectionLocked();g_state=RelayState::Idle;g_recovering=false;configured="self";configured_public=true;config_valid=true;
 configured_ip=htonl(0x7f000001);configured_port=htons(11460);g_public=true;change_at_nickname=false;attempted=0;leaves=0;g_token=0;std::strcpy(g_code,"ABC234");g_stream_epoch=1;g_stream_ready=false;}
int main(){unsigned checks=0;reset();GameRoute route{};
 assert(!CaptureGameRoute(nullptr));assert(CaptureGameRoute(&route)&&route.room_epoch==0&&std::string(route.discovery.provider)=="self");checks++;
 assert(GameRouteStillCurrent(route));configured="lanplay-cn-jax";assert(!GameRouteStillCurrent(route));
 assert(CreateRoom(0x111,&route.discovery,nullptr)!=0&&attempted==0);checks++;
 reset();configured="lanplay-cn-jax";assert(CaptureGameRoute(&route));configured="self";
 assert(!GameRouteStillCurrent(route));assert(CreateRoom(UINT64_MAX,&route.discovery,nullptr)!=0&&attempted==0);checks++;
 reset();assert(CaptureGameRoute(&route));configured_public=false;
 assert(!GameRouteStillCurrent(route));assert(CreateRoom(0x111,&route.discovery,nullptr)!=0&&attempted==0);checks++;
 reset();assert(CaptureGameRoute(&route));configured_port=htons(11461);
 assert(!GameRouteStillCurrent(route));assert(CreateRoom(0x111,&route.discovery,nullptr)!=0&&attempted==0);checks++;
 reset();assert(CaptureGameRoute(&route));change_at_nickname=true;
 assert(CreateRoom(0x111,&route.discovery,nullptr)!=0&&attempted==0);checks++;
 reset();configured="lanplay-cn-jax";assert(CaptureHostGameRoute(&route));
 assert(route.discovery.public_enabled&&std::string(route.discovery.provider)=="self");
 assert(CreateRoom(0x111,&route.discovery,nullptr)==0&&attempted==1&&sent_id==0x111&&sent_provider=="self");checks++;
 reset();configured="lanplay-cn-jax";assert(CaptureGameRoute(&route));
 route.discovery.selected_game_id=42;
 SelectRouteLocked(route.discovery,"ABC234");
 assert(CreateRoom(0x111,nullptr,nullptr)==0&&attempted==1&&sent_provider=="self"&&!g_selection.selection_epoch);checks++;
 reset();g_state=RelayState::InRoom;g_stream_ready=true;g_server.sin_addr.s_addr=htonl(0x7f000001);g_server.sin_port=htons(11460);
 std::strcpy(g_room_provider,"lanplay-cn-jax");g_stream_epoch=9;g_token=77;configured="self";
 assert(CaptureGameRoute(&route)&&route.room_epoch==9&&std::string(route.discovery.provider)=="lanplay-cn-jax");
 configured="lanplay-cn-gugu";configured_public=false;assert(GameRouteStillCurrent(route));checks++;
 g_stream_ready=false;assert(!CaptureGameRoute(&route));g_stream_ready=true;assert(CaptureGameRoute(&route)&&route.room_epoch==9);checks++;
 g_recovering=true;assert(!GameRouteStillCurrent(route));g_recovering=false;assert(GameRouteStillCurrent(route));checks++;
 g_stream_epoch=10;assert(!GameRouteStillCurrent(route));checks++;
 g_stream_epoch=9;std::strcpy(g_room_provider,"self");assert(!GameRouteStillCurrent(route));checks++;
 std::strcpy(g_room_provider,"lanplay-cn-jax");g_server.sin_port=htons(11461);assert(!GameRouteStillCurrent(route));checks++;
 g_server.sin_port=htons(11460);g_state=RelayState::Idle;assert(!GameRouteStillCurrent(route));checks++;
 reset();assert(CaptureGameRoute(&route));g_state=RelayState::InRoom;assert(!GameRouteStillCurrent(route));checks++;
 g_state=RelayState::Connecting;assert(!CaptureGameRoute(&route));checks++;
 reset();config_valid=false;assert(!CaptureGameRoute(&route));checks++;
 // Token and endpoint own cleanup; transport epoch may change on RESUME.
 reset();g_state=RelayState::InRoom;g_stream_ready=true;g_server.sin_addr.s_addr=htonl(0x7f000001);g_server.sin_port=htons(11460);
 std::strcpy(g_room_provider,"lanplay-cn-jax");g_stream_epoch=9;g_token=77;assert(CaptureGameRoute(&route));
 GameRoute missing=route;missing.room_token=0;LeaveGameRoom(missing);assert(leaves==0);
 g_token=88;assert(!GameRouteStillCurrent(route));LeaveGameRoom(route);assert(leaves==0);g_token=77;
 std::strcpy(g_code,"DEF567");assert(!GameRouteStillCurrent(route));LeaveGameRoom(route);assert(leaves==0);std::strcpy(g_code,"ABC234");
 std::strcpy(g_room_provider,"self");LeaveGameRoom(route);assert(leaves==0);std::strcpy(g_room_provider,"lanplay-cn-jax");
 g_server.sin_port=htons(11461);LeaveGameRoom(route);assert(leaves==0);g_server.sin_port=htons(11460);
 g_server.sin_addr.s_addr=htonl(0x7f000002);LeaveGameRoom(route);assert(leaves==0);g_server.sin_addr.s_addr=htonl(0x7f000001);
 g_stream_epoch=10;assert(!GameRouteStillCurrent(route));LeaveGameRoom(route);assert(leaves==1&&g_state==RelayState::Idle);checks++;
 reset();assert(CaptureGameRoute(&route));GameRoute joined{};assert(CreateRoom(0x111,&route.discovery,&joined)==0&&joined.room_token==91&&!std::strcmp(joined.room_code,"ABC234"));checks++;
 std::printf("Actual GameRoute/CreateRoom slices: %u isolated provider/epoch/TOCTOU checks passed.\n",checks);
}
'''
    with tempfile.TemporaryDirectory(prefix='switch-lcid-route-') as temp:
        path=Path(temp);cpp=path/'route.cpp';binary=path/'route';cpp.write_text(harness)
        compiler=shlex.split(os.environ.get('CXX','c++'))
        subprocess.run(compiler+['-std=c++17','-Wall','-Wextra','-Werror','-pthread',str(cpp),'-o',str(binary)],check=True)
        subprocess.run([str(binary)],check=True)
    print('Relay source SHA-256:',hashlib.sha256(source.encode()).hexdigest())
    print('Host fixture only: no Switch runtime, SD or production network.')

if __name__ == '__main__': main()
