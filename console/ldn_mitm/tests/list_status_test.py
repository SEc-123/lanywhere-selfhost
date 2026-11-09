#!/usr/bin/env python3
"""Execute native connection/CAPS/listing source slices against loopback relays."""
import importlib.util
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location('discovery', Path(__file__).with_name('discovery_route_test.py'))
discovery = importlib.util.module_from_spec(spec); spec.loader.exec_module(discovery)
source=discovery.SOURCE.read_text(); header=discovery.HEADER.read_text()
template=Path(__file__).with_name('discovery_route_harness.cpp.in').read_text().split('int main(){',1)[0]
names=[('LOAD','bool LoadServer('),('RESOLVE','bool ResolveDiscoveryRoute('),('CHOOSE','bool ChooseEnterRoute('),
 ('CAPTURE','bool CaptureDiscoveryRoute('),('CURRENT','bool DiscoveryRouteStillSelected(const DiscoveryRoute &route) {'),
 ('SEND','bool SendFrameTo('),('READ','ssize_t ReadFrame('),('READ_LIST','ssize_t ReadListFrame('),
 ('CONNECT','int ConnectServer('),('CAPS','bool QueryCapabilities(int fd, u32 *flags, int timeout_ms, u32 *status) {'),
 ('LEGACY','int ReadLegacyDiscovery('),('PAGE','int ReadPagedDiscovery('),('CONNECTION','int DiscoveryConnection('),
 ('UNFILTERED','int ReadUnfilteredPage('),('FIND','int FindGroups(u64 '),('FIND_PAGE','int FindGroupsPage('),
 ('FILTERED','int FindGroupsFilteredPage('),('JOIN','Result JoinRoom('),('NICKNAME','void Nickname(')]
at=header.index('    struct DiscoveryRoute {')
pieces={'ROUTE':header[at:header.index('};',at)+2], 'SELECTION':discovery.selection_state(source)}
at=header.index('    struct GameRoute {')
pieces['GAME_ROUTE']=header[at:header.index('};',at)+2]
pieces.update((key,discovery.function(source,sig)) for key,sig in names)
pieces['CONNECT'] = discovery.function(source,'int RemainingIoMs(')+'\n'+pieces['CONNECT']
for name in ('le16','le32','le64','put16','put32','put64'):
    pieces[name.upper()]=discovery.function(source,('void ' if name.startswith('put') else 'u'+name[2:]+' ')+name+'(')
for key,value in pieces.items():
    marker='/* ACTUAL_'+key+' */'; assert template.count(marker)==1;template=template.replace(marker,value)
assert '/* ACTUAL_' not in template
at=header.index('    struct GroupSummaryV2 {')
records=header[at:header.index('    int FindGroupSummaries',at)]
at=header.index('    int FindGroupSummaries(')
summary_declaration=header[at:header.index(';',at)+1]
template+='\nusing s32=int32_t;\n#include "unified_lobby.h"\n'+records+summary_declaration+'\n'+'\n'.join(discovery.function(source, sig) for sig in [
    'bool CaptureAppointmentRoute(', 'bool AppointmentBackendCurrent(',
])+r'''
#include "game_identity_text.h"
#include "room_passcode.h"
constexpr size_t MaxMembers=8;
constexpr u32 CapabilityMetadata=64;
constexpr u8 T_FindMetadataPage=0x22,T_MetadataPage=0xa2;
static void AddCachedIdentity(GroupSummaryV2&) {} // Independent cache is outside this transport fixture.
'''+discovery.function(source,'bool CleanDisplayField(')+'\n'+discovery.function(source,'int FindGroupSummaries(')+r'''
#define R_SUCCEED() return 0
namespace sf {
template<class T> struct Out { T *value; void SetValue(const T &v) const { *value = v; } };
struct OutBuffer {
    void *data;
    size_t bytes;
    void *GetPointer() const { return data; }
    size_t GetSize() const { return bytes; }
};
}
class LanywhereService {
public:
    Result ListUnifiedRooms(UnifiedRoomsRequest request, sf::Out<UnifiedPage> page, const sf::OutBuffer &out);
};
'''+discovery.function(source,'void FindUnifiedRooms(')+'\n'+discovery.function(
    (discovery.SOURCE.parent/'lanywhere_service.cpp').read_text(), 'Result LanywhereService::ListUnifiedRooms(')+r'''
class StatusRelay {
 int listener;std::thread thread;
 public: u16 port;std::atomic<int> queries{0};std::atomic<size_t> query_bytes{0};
 StatusRelay(int stage,int code,int shape=0,u32 caps=CapabilityMetadata,u8 access=RoomAccessNone) {
  listener=::socket(AF_INET,SOCK_STREAM,0);assert(listener>=0);sockaddr_in a{};a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
  assert(!::bind(listener,(sockaddr*)&a,sizeof(a)));assert(!::listen(listener,1));socklen_t n=sizeof(a);assert(!::getsockname(listener,(sockaddr*)&a,&n));port=ntohs(a.sin_port);
  thread=std::thread([=]{int fd=::accept(listener,nullptr,nullptr);assert(fd>=0);u8 type;std::vector<u8>b;
   while(receive(fd,type,b)) {
    int current=type==T_SelectProvider?1:type==T_Caps?2:3;
    if(stage==current){response(fd,T_Error,{static_cast<u8>(code)});continue;}
    if(type==T_SelectProvider){std::vector<u8>out(5+b.size());put32(out.data(),64);out[4]=b.size();std::memcpy(out.data()+5,b.data(),b.size());response(fd,T_ProviderSelected,out);}
    else if(type==T_Caps){std::vector<u8>out(4);put32(out.data(),shape==1?0:caps);response(fd,T_CapsReply,out);}
    else {queries++;query_bytes=b.size();assert(type==T_FindMetadataPage||type==T_Find);
      if(b.size()==13)assert(b[12]==1 && type==T_FindMetadataPage);
      if(shape==2){response(fd,T_MetadataPage,{0});continue;}
      if(shape==3){std::this_thread::sleep_for(std::chrono::milliseconds(1100));break;}
      if(shape==4)break;
      std::vector<u8>out(type==T_Find?1:5);
      if(out.size()==5) {
       put32(out.data(),GroupPageEnd);
       if(shape==5) {
        out.resize(5+sizeof(GroupSummaryV2));out[4]=1;
        std::memcpy(out.data()+5,"ABC234",6);put64(out.data()+5+8,42);
        out[5+32]=1;out[5+33]=4;out[5+offsetof(GroupSummaryV2,room_access)]=access;
       }
      }
      response(fd,type==T_Find?T_Groups:T_MetadataPage,out);
    }
   }::close(fd);
  });
 }
 ~StatusRelay(){::shutdown(listener,SHUT_RDWR);::close(listener);thread.join();}
};
class UnifiedRelay {
    int listener;
    std::thread worker;
public:
    u16 port = 0;
    std::atomic<unsigned> queries{0};
    std::atomic<u32> offset{0}, snapshot{0};

    explicit UnifiedRelay(std::vector<u8> payload, u32 capabilities = UNIFIED_LOBBY_CAPABILITY) {
        listener = ::socket(AF_INET, SOCK_STREAM, 0);
        assert(listener >= 0);
        sockaddr_in a{};
        a.sin_family = AF_INET;
        a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        assert(!::bind(listener, reinterpret_cast<sockaddr *>(&a), sizeof(a)));
        assert(!::listen(listener, 1));
        socklen_t n = sizeof(a);
        assert(!::getsockname(listener, reinterpret_cast<sockaddr *>(&a), &n));
        port = ntohs(a.sin_port);
        worker = std::thread([this, payload, capabilities] {
            const int fd = ::accept(listener, nullptr, nullptr);
            if (fd < 0) return;
            u8 type = 0;
            std::vector<u8> body;
            assert(receive(fd, type, body) && type == T_Caps && body.empty());
            std::vector<u8> cap(4);
            put32(cap.data(), capabilities);
            response(fd, T_CapsReply, cap);
            if (receive(fd, type, body)) {
                assert(type == UNIFIED_LOBBY_REQUEST_TYPE && body.size() == 8);
                offset = le32(body.data());
                snapshot = le32(body.data() + 4);
                ++queries;
                response(fd, UNIFIED_LOBBY_RESPONSE_TYPE, payload);
            }
            ::close(fd);
        });
    }
    ~UnifiedRelay() {
        ::shutdown(listener, SHUT_RDWR);
        ::close(listener);
        worker.join();
    }
};

static std::vector<u8> unifiedReply() {
    std::vector<u8> reply(UNIFIED_LOBBY_HEADER_SIZE + 2 * sizeof(UnifiedGroup));
    put32(reply.data(), 17);
    put32(reply.data() + 4, 3);
    reply[8] = 2;
    reply[9] = 2;
    reply[10] = 3;
    UnifiedGroup rows[2]{};
    std::strcpy(rows[0].provider, "self");
    std::strcpy(rows[1].provider, "lanplay-cn-jax");
    for (auto &row : rows) {
        std::strcpy(row.group.code, "ABC234");
        std::strcpy(row.group.host, "Host");
        std::strcpy(row.group.title_en, "Game");
        row.group.players = 1;
        row.group.max_players = 4;
        row.group.metadata_flags = 1;
    }
    rows[0].group.game_id = 42;
    rows[0].group.room_access = RoomAccessHidden;
    rows[1].group.game_id = UINT64_MAX;
    std::memcpy(reply.data() + UNIFIED_LOBBY_HEADER_SIZE, rows, sizeof(rows));
    return reply;
}

static unsigned testUnified() {
    unsigned cases = 0;
    LanywhereService service;
    UnifiedPage page{};
    UnifiedGroup groups[UNIFIED_LOBBY_PAGE_SIZE]{};
    {
        UnifiedRelay relay(unifiedReply());
        config(relay.port, "lanplay-nl");
        assert(service.ListUnifiedRooms({1, 17}, {&page}, {groups, sizeof(groups)}) == 0);
        assert(page.count == 2 && page.next == 3 && page.snapshot == 17 &&
               page.available == 2 && page.total == 3 && page.status == ListStatusOk);
        assert(relay.queries == 1 && relay.offset == 1 && relay.snapshot == 17);
        assert(groups[0].group.room_access == RoomAccessHidden &&
               std::string(groups[0].provider) == "self");
        assert(groups[1].group.game_id == UINT64_MAX &&
               std::string(groups[1].provider) == "lanplay-cn-jax");
        DiscoveryRoute saved{};
        assert(CaptureDiscoveryRoute(&saved) && std::string(saved.provider) == "lanplay-nl");
        ++cases;
    }
    {
        UnifiedRelay relay({}, 0);
        config(relay.port);
        service.ListUnifiedRooms({0, 0}, {&page}, {groups, sizeof(groups)});
        assert(page.count == -1 && page.status == ListStatusUpdate && !relay.queries);
        ++cases;
    }
    {
        std::vector<u8> stale(UNIFIED_LOBBY_HEADER_SIZE);
        put32(stale.data() + 4, UNIFIED_LOBBY_END);
        stale[11] = UnifiedWireStale;
        UnifiedRelay relay(stale);
        config(relay.port);
        service.ListUnifiedRooms({1, 16}, {&page}, {groups, sizeof(groups)});
        assert(page.count == -1 && page.status == UnifiedListStale && relay.queries == 1);
        ++cases;
    }
    for (unsigned malformed = 0; malformed < 6; ++malformed) {
        auto body = unifiedReply();
        const size_t external = UNIFIED_LOBBY_HEADER_SIZE + sizeof(UnifiedGroup);
        switch (malformed) {
            case 0: put32(body.data(), 16); break;
            case 1: put32(body.data() + 4, 4); break;
            case 2: body[9] = 4; break;
            case 3: body[external + offsetof(UnifiedGroup, provider)] = 'X'; break;
            case 4: body[external + offsetof(UnifiedGroup, reserved)] = 1; break;
            case 5: body.pop_back(); break;
        }
        UnifiedRelay relay(body);
        config(relay.port);
        service.ListUnifiedRooms({1, 17}, {&page}, {groups, sizeof(groups)});
        assert(page.count == -1 && page.status == ListStatusProtocol);
        assert(groups[0].group.game_id == 0 && groups[1].group.game_id == 0);
        ++cases;
    }
    {
        UnifiedRelay relay({});
        config(relay.port);
        service.ListUnifiedRooms({0, 0}, {&page}, {groups, sizeof(groups) - 1});
        assert(page.count == -1 && page.status == ListStatusProtocol && !relay.queries);
        ++cases;
    }
    return cases;
}
int main() {
 unsigned checks=0;GroupPageV2 page;GroupSummaryV2 groups[6];
 for(int stage:{1,2,3})for(unsigned code:{6u,7u,8u,11u,13u}) {
  StatusRelay relay(stage,code);config(relay.port);
  assert(FindGroupSummaries(0,&page,groups,6)==-1 && page.count==-1 && page.reserved==lanywhere_list_error_status(code));
  assert(page.next==GroupPageEnd);if(stage<3)assert(!relay.queries);checks++;
 }
 for(int shape:{0,1}) {StatusRelay relay(0,0,shape);config(relay.port);assert(FindGroupSummaries(0,&page,groups,6)==0 && page.count==0 && page.reserved==0);checks++;}
 {StatusRelay relay(2,4,1);config(relay.port);assert(FindGroupSummaries(0,&page,groups,6)==0 && page.reserved==0);checks++;} // Only error4 permits legacy CAPS fallback.
 for(int shape:{2,3,4}) {StatusRelay relay(0,0,shape);config(relay.port);assert(FindGroupSummaries(0,&page,groups,6)==-1);assert(page.reserved==static_cast<u32>(shape==2?ListStatusProtocol:shape==3?ListStatusTimeout:ListStatusUnavailable));checks++;}
 for (u8 mode : {u8(RoomAccessNone), u8(RoomAccessShared), u8(RoomAccessHidden)}) {
  StatusRelay relay(0,0,5,CapabilityMetadata|ROOM_ACCESS_CAPABILITY,mode);config(relay.port,"self");
  assert(FindGroupSummaries(0,&page,groups,6)==1 && relay.query_bytes==13);
  assert(groups[0].game_id==42 && groups[0].room_access==mode);checks++;
 }
 {StatusRelay relay(0,0,5,CapabilityMetadata|ROOM_ACCESS_CAPABILITY,RoomAccessHidden+1);config(relay.port,"self");
  assert(FindGroupSummaries(0,&page,groups,6)==-1 && page.reserved==ListStatusProtocol && relay.query_bytes==13);checks++;}
 {StatusRelay relay(0,0,5,CapabilityMetadata|ROOM_ACCESS_CAPABILITY);config(relay.port,"lanplay-nl");
  assert(FindGroupSummaries(0,&page,groups,6,42,true,true)==1 && relay.query_bytes==12);
  assert(groups[0].room_access==RoomAccessNone);checks++;}
 {StatusRelay relay(0,0,5,CapabilityMetadata|ROOM_ACCESS_CAPABILITY,0xff);config(relay.port);
  assert(FindGroupSummaries(0,&page,groups,6)==1 && page.reserved==ListStatusOk && relay.query_bytes==12);
  assert(groups[0].room_access==RoomAccessNone);checks++;}
 fs::denied=true;assert(FindGroupSummaries(0,&page,groups,6)==-1 && page.reserved==ListStatusConfig);checks++;
 assert(sizeof(page)==16 && sizeof(groups[0])==336);
 std::printf("Actual native listing slices: %u loopback/config + %u unified IPC24 scenarios passed; no external network or games.\n",checks,testUnified());
}
'''
with tempfile.TemporaryDirectory(prefix='switch-native-list-status-') as tmp:
    tmp=Path(tmp); c=tmp/'test.cpp';exe=tmp/'test';c.write_text(template)
    subprocess.run(shlex.split(os.environ.get('CXX','c++'))+['-std=c++17','-Wall','-Wextra','-Werror',
        '-Wno-unused-function','-pthread','-I'+str(ROOT/'common'),str(c),'-o',str(exe)],check=True,timeout=40)
    subprocess.run([str(exe)],check=True,timeout=20)
