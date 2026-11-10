#!/usr/bin/env python3
"""Actual native push transport against loopback, using real server-generated ACK/event payloads."""
import importlib.util, os, re, shlex, subprocess, tempfile, json
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3];HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('extract',HERE/'discovery_route_test.py');d=importlib.util.module_from_spec(spec);spec.loader.exec_module(d)
source=d.SOURCE.read_text();header=d.HEADER.read_text()
template=(HERE/'discovery_route_harness.cpp.in').read_text().split('static int enter_calls=',1)[0]
# This fixture stops before the JOIN path; do not retain its unused protocol constant.
template=template.replace(',T_Join=2;', ';')
names=[('LOAD','bool LoadServer('),('RESOLVE','bool ResolveDiscoveryRoute('),('CHOOSE','bool ChooseEnterRoute('),
 ('CAPTURE','bool CaptureDiscoveryRoute('),('CURRENT','bool DiscoveryRouteStillSelected(const DiscoveryRoute &route) {'),
 ('SEND','bool SendFrameTo('),('READ','ssize_t ReadFrame('),('READ_LIST','ssize_t ReadListFrame('),('CONNECT','int ConnectServer('),
 ('CAPS','bool QueryCapabilities(int fd, u32 *flags, int timeout_ms, u32 *status) {'),('LEGACY','int ReadLegacyDiscovery('),
 ('PAGE','int ReadPagedDiscovery('),('CONNECTION','int DiscoveryConnection('),('UNFILTERED','int ReadUnfilteredPage('),
 ('FIND','int FindGroups(u64 '),('FIND_PAGE','int FindGroupsPage('),('FILTERED','int FindGroupsFilteredPage('),('NICKNAME','void Nickname(')]
pieces={key:d.function(source,sig) for key,sig in names};pieces['SELECTION']=d.selection_state(source)
for key,name in [('ROUTE','DiscoveryRoute'),('GAME_ROUTE','GameRoute')]:
 at=header.index('    struct '+name+' {');pieces[key]=header[at:header.index('};',at)+2]
pieces['CONNECT']=d.function(source,'int RemainingIoMs(')+'\n'+pieces['CONNECT']
for name in ('le16','le32','le64','put16','put32','put64'):
 pieces[name.upper()]=d.function(source,('void ' if name.startswith('put') else 'u'+name[2:]+' ')+name+'(')
for key,value in pieces.items():
 marker='/* ACTUAL_'+key+' */';assert template.count(marker)==1;template=template.replace(marker,value)
assert '/* ACTUAL_' not in template
records=''
for name in ['GroupSummaryV2','AppointmentPushFrame']:
 at=header.index('    struct '+name+' {');records+=header[at:header.index('};',at)+2]+'\n'
template+='\n#include "appointments.h"\n#include "room_passcode.h"\n#include "game_identity_text.h"\n'+records+'\nconstexpr size_t MaxMembers=8;constexpr u8 T_Ping=5,T_Pong=0x86;\n'
template+=re.search(r'constexpr int AppointmentPushIoMs = \d+;',source)[0]+'\n'
template+='\n'.join(d.function(source,sig) for sig in ['bool CleanDisplayField(', 'bool CaptureAppointmentRoute(',
 'bool AppointmentBackendCurrent(', 'bool ValidPushSubscriptions(', 'bool ValidPushText(', 'bool ValidPushGroup(',
 'int OpenAppointmentPush(', 'int ReadAppointmentPush(', 'bool PingAppointmentPush(', 'void CloseAppointmentPush('])
template+='\n'+(HERE/'appointment_push_harness.cpp.in').read_text()
node=r'''
const assert=require('node:assert/strict'),P=require('./server/relay/appointment-push'),M=require('./server/relay/room-metadata');
const socket={destroyed:false,writableLength:0,end(){}},room={code:'ABC234',gameId:42n,members:[]};
const member={room,socket,nick:'Host'};room.members[0]=member;room.published={info:Buffer.alloc(0x480),appointmentId:7n};
room.published.info[0x66]=4;room.published.info[0x67]=1;room.published.info[16]=1;
const meta=M.create(),body=Buffer.alloc(272);body.writeBigUInt64LE(0x01008f6008c5e000n);body.writeBigUInt64LE(0x01008f6008c5e000n,8);
body.write('Pokémon Violet',16);body.write('宝可梦 紫',144);assert(meta.set(member,body).ok);
const frames=[];const push=P.create({rooms:()=>[room],isEligible:r=>r===room&&r.published&&r.members[0].socket===socket,
 applicationId:r=>meta.applicationId(r),summarize:r=>meta.summary(r,{players:1,mode:0}),activeAppointment:id=>id===7n?{game:42n,app:0x01008f6008c5e000n}:null,
 send:(_s,type,b)=>{assert.equal(type,0xa9);frames.push(b.toString('hex'));return true;},now:()=>1800000000});
assert(push.subscribe(socket,'127.0.0.1',new Set([7n])));assert.equal(frames.length,2);push.shutdown();process.stdout.write(JSON.stringify(frames));
'''
vectors=json.loads(subprocess.check_output([os.environ.get('NODE','node'),'-e',node],cwd=ROOT,text=True,timeout=10))
with tempfile.TemporaryDirectory(prefix='appointment-push-native-') as tmp:
 tmp=Path(tmp);cpp=tmp/'test.cpp';exe=tmp/'test';cpp.write_text(template)
 for name,data in zip(['ack','event'],vectors):(tmp/name).write_bytes(bytes.fromhex(data))
 subprocess.run(shlex.split(os.environ.get('CXX','c++'))+['-std=c++17','-Wall','-Wextra','-Werror','-Wno-unused-function',
  '-pthread','-I'+str(ROOT/'common'),str(cpp),'-o',str(exe)],check=True,timeout=40)
 subprocess.run([str(exe),str(tmp/'ack'),str(tmp/'event')],check=True,timeout=30)
print('Real server serializers and actual native network/codec functions; localhost only, no Switch/hardware claim.')
