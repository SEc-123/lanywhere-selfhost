#!/usr/bin/env python3
"""Actual appointment wire/IPC functions over isolated loopback sockets; no Switch or public server."""
import importlib.util, os, re, shlex, subprocess, tempfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('discovery',HERE/'discovery_route_test.py')
d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
source=d.SOURCE.read_text();header=d.HEADER.read_text()
template=(HERE/'discovery_route_harness.cpp.in').read_text().split('int main(){',1)[0]
template=template.replace('namespace os {','static unsigned appointment_random_calls=0;\nnamespace os {',1)
template=template.replace('inline void GenerateRandomBytes(void *p,size_t n){std::memset(p,0,n);}',
 'inline void GenerateRandomBytes(void *p,size_t n){appointment_random_calls++;std::memset(p,0x65,n);}')
names=[('LOAD','bool LoadServer('),('RESOLVE','bool ResolveDiscoveryRoute('),('CHOOSE','bool ChooseEnterRoute('),
 ('CAPTURE','bool CaptureDiscoveryRoute('),('CURRENT','bool DiscoveryRouteStillSelected(const DiscoveryRoute &route) {'),
 ('SEND','bool SendFrameTo('),('READ','ssize_t ReadFrame('),('READ_LIST','ssize_t ReadListFrame('),('CONNECT','int ConnectServer('),
 ('CAPS','bool QueryCapabilities(int fd, u32 *flags, int timeout_ms, u32 *status) {'),('LEGACY','int ReadLegacyDiscovery('),
 ('PAGE','int ReadPagedDiscovery('),('CONNECTION','int DiscoveryConnection('),('UNFILTERED','int ReadUnfilteredPage('),
 ('FIND','int FindGroups(u64 '),('FIND_PAGE','int FindGroupsPage('),('FILTERED','int FindGroupsFilteredPage('),
 ('JOIN','Result JoinRoom('),('NICKNAME','void Nickname(')]
pieces={key:d.function(source,sig) for key,sig in names}
pieces['SELECTION']=d.selection_state(source)
for key,name in [('ROUTE','DiscoveryRoute'),('GAME_ROUTE','GameRoute')]:
 at=header.index('    struct '+name+' {');pieces[key]=header[at:header.index('};',at)+2]
pieces['CONNECT']=d.function(source,'int RemainingIoMs(')+'\n'+pieces['CONNECT']
for name in ('le16','le32','le64','put16','put32','put64'):
 pieces[name.upper()]=d.function(source,('void ' if name.startswith('put') else 'u'+name[2:]+' ')+name+'(')
for key,value in pieces.items():
 marker='/* ACTUAL_'+key+' */';assert template.count(marker)==1;template=template.replace(marker,value)
at=header.index('    struct GroupSummaryV2 {');end=header.index(';',header.index('    int FindGroupSummaries(',at))+1
records=header[at:end]
native='\n'.join(d.function(source,sig) for sig in ['bool CaptureAppointmentRoute(', 'bool AppointmentBackendCurrent(',
 'bool ValidAppointmentRequest(',
 'bool ValidAppointmentResponse(', 'void ExchangeAppointment(', 'bool CleanDisplayField(', 'int FindGroupSummaries('])
service=(ROOT/'console/ldn_mitm/source/lanywhere_service.cpp').read_text()
service_header=(ROOT/'console/ldn_mitm/source/lanywhere_service.hpp').read_text()
assert re.search(r'AMS_SF_METHOD_INFO\(C, H, 13, Result, AppointmentExchange',service_header)
assert re.search(r'AMS_SF_METHOD_INFO\(C, H, 14, Result, ListAppointmentRooms',service_header)
assert re.search(r'AMS_SF_METHOD_INFO\(C, H, 15, Result, SetAppointmentWatch',service_header)
assert re.search(r'AMS_SF_METHOD_INFO\(C, H, 16, Result, GetAppointmentWatch',service_header)
assert re.search(r'AMS_SF_METHOD_INFO\(C, H, 22, Result, ReadAppointmentSubscriptions',service_header)
assert re.search(r'AMS_SF_METHOD_INFO\(C, H, 23, Result, UpdateAppointmentSubscription',service_header)
assert re.search(r'AMS_SF_METHOD_INFO\(C, H, 26, Result, GetAppointmentAlertState',service_header)
assert 'constexpr u32 ProtocolVersion = 5;' in header
ipc='\n'.join(d.function(service,sig) for sig in ['void UseBootAppointmentParticipant(',
 'Result LanywhereService::AppointmentExchange(', 'Result LanywhereService::ListAppointmentRooms(',
 'Result LanywhereService::SetAppointmentWatch(', 'Result LanywhereService::GetAppointmentWatch(',
 'Result LanywhereService::ReadAppointmentSubscriptions(', 'Result LanywhereService::UpdateAppointmentSubscription(',
 'Result LanywhereService::GetAppointmentAlertState('])
template+='\nusing s32=int32_t;\n#include "appointments.h"\n#include "game_identity_text.h"\n#include "room_passcode.h"\n#include "unified_lobby.h"\n'+records+r'''
constexpr size_t MaxMembers=8;
constexpr u32 CapabilityMetadata=64;
constexpr u8 T_FindMetadataPage=0x22,T_MetadataPage=0xa2;
static void AddCachedIdentity(GroupSummaryV2&) {}
static unsigned clock_syncs=0;
static u64 clock_sample=0;
void SyncAppointmentClock(u64 now){clock_syncs++;clock_sample=now;}
'''+native+'\n'+(HERE/'appointments_ipc_harness.cpp.in').read_text().replace('/* ACTUAL_IPC */',ipc)
with tempfile.TemporaryDirectory(prefix='appointments-native-') as temp:
 temp=Path(temp);cpp=temp/'test.cpp';exe=temp/'test';cpp.write_text(template)
 subprocess.run(shlex.split(os.environ.get('CXX','c++'))+['-std=c++17','-Wall','-Wextra','-Werror','-Wno-unused-function',
   '-pthread','-I'+str(ROOT/'common'),str(cpp),'-o',str(exe)],check=True,timeout=40)
 subprocess.run([str(exe)],check=True,timeout=25)
print('Actual IPC13–16 and IPC22/23 wrappers plus isolated native loopback transport; no physical console or public server.')
