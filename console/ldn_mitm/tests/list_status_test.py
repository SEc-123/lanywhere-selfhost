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
pieces={'ROUTE':header[at:header.index('};',at)+2]}
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
template+='\nusing s32=int32_t;\n'+records+r'''
#include "game_identity_text.h"
constexpr size_t MaxMembers=8;
constexpr u32 CapabilityMetadata=64;
constexpr u8 T_FindMetadataPage=0x22,T_MetadataPage=0xa2;
static void AddCachedIdentity(GroupSummaryV2&) {} // Independent cache is outside this transport fixture.
'''+discovery.function(source,'bool CleanDisplayField(')+'\n'+discovery.function(source,'int FindGroupSummaries(')+r'''
class StatusRelay {
 int listener;std::thread thread;
 public: u16 port;int queries=0;
 StatusRelay(int stage,int code,int shape=0) {
  listener=::socket(AF_INET,SOCK_STREAM,0);assert(listener>=0);sockaddr_in a{};a.sin_family=AF_INET;a.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
  assert(!::bind(listener,(sockaddr*)&a,sizeof(a)));assert(!::listen(listener,1));socklen_t n=sizeof(a);assert(!::getsockname(listener,(sockaddr*)&a,&n));port=ntohs(a.sin_port);
  thread=std::thread([=]{int fd=::accept(listener,nullptr,nullptr);assert(fd>=0);u8 type;std::vector<u8>b;
   while(receive(fd,type,b)) {
    int current=type==T_SelectProvider?1:type==T_Caps?2:3;
    if(stage==current){response(fd,T_Error,{static_cast<u8>(code)});continue;}
    if(type==T_SelectProvider){std::vector<u8>out(5+b.size());put32(out.data(),64);out[4]=b.size();std::memcpy(out.data()+5,b.data(),b.size());response(fd,T_ProviderSelected,out);}
    else if(type==T_Caps){std::vector<u8>out(4);put32(out.data(),shape==1?0:64);response(fd,T_CapsReply,out);}
    else {queries++;assert(type==T_FindMetadataPage||type==T_Find);
      if(shape==2){response(fd,T_MetadataPage,{0});continue;}
      if(shape==3){std::this_thread::sleep_for(std::chrono::milliseconds(1100));break;}
      if(shape==4)break;
      std::vector<u8>out(type==T_Find?1:5);if(out.size()==5)put32(out.data(),GroupPageEnd);response(fd,type==T_Find?T_Groups:T_MetadataPage,out);
    }
   }::close(fd);
  });
 }
 ~StatusRelay(){::shutdown(listener,SHUT_RDWR);::close(listener);thread.join();}
};
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
 fs::denied=true;assert(FindGroupSummaries(0,&page,groups,6)==-1 && page.reserved==ListStatusConfig);checks++;
 assert(sizeof(page)==16 && sizeof(groups[0])==336);
 std::printf("Actual native listing slices: %u loopback/config scenarios passed; no external network or games.\n",checks);
}
'''
with tempfile.TemporaryDirectory(prefix='switch-native-list-status-') as tmp:
    tmp=Path(tmp); c=tmp/'test.cpp';exe=tmp/'test';c.write_text(template)
    subprocess.run(shlex.split(os.environ.get('CXX','c++'))+['-std=c++17','-Wall','-Wextra','-Werror',
        '-Wno-unused-function','-pthread','-I'+str(ROOT/'common'),str(c),'-o',str(exe)],check=True,timeout=40)
    subprocess.run([str(exe)],check=True,timeout=20)
