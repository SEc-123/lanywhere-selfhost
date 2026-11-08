#!/usr/bin/env python3
"""Extract actual BSD hooks and validate raw IPC against real scoped host sockets."""
from pathlib import Path
import importlib.util,os,shlex,subprocess,tempfile,sys,hashlib,re
sys.dont_write_bytecode=True
root=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('source_slices',root/'app/tests/input_routing_test.py');slices=importlib.util.module_from_spec(spec);spec.loader.exec_module(slices)
source=(root/'console/ldn_mitm/source/bsd_spy.cpp').read_text()
signatures=['tcpstream::Owner TcpOwner(','u32 TcpDispatch(','void TcpAddress(','BsdSpyService::BsdSpyService(','BsdSpyService::~BsdSpyService(']+['Result BsdSpyService::'+name+'(' for name in ['SetSockOpt','Connect','Close','Fcntl','Poll','Select','Accept','GetPeerName','GetSockName','GetSockOpt','Shutdown','ShutdownAllSockets','DuplicateSocket','Read','Write','RecvMMsg','SendMMsg']]
functions='\n'.join(slices.function(source,s) for s in signatures)
template=Path(__file__).with_name('tcp_stream_ipc_harness.cpp.in').read_text();assert template.count('/* ACTUAL_SOURCE */')==1
header=(root/'console/ldn_mitm/source/bsd_spy.hpp').read_text()
sdk=(root/'console/Atmosphere-libs/libstratosphere/include/stratosphere/ncm/ncm_content_meta_id.hpp').read_text()
sdk_predicate='\n'.join(re.findall(r'inline constexpr const ApplicationId ApplicationId::(?:Start|End)\s*=\s*\{[^}]+\};',sdk))+'\n'+slices.function(sdk,'inline constexpr bool IsApplicationId(const ProgramId &program_id)')
template=template.replace('/* SDK_PREDICATE */',sdk_predicate).replace('/* BSD_PREDICATE */',slices.function(header,'static bool ShouldMitm('))
with tempfile.TemporaryDirectory(prefix='tcp-actual-ipc-') as tmp:
 tmp=Path(tmp);cpp=tmp/'test.cpp';binary=tmp/'test';cpp.write_text(template.replace('/* ACTUAL_SOURCE */',functions))
 cc=shlex.split(os.environ.get('CXX','c++'))
 subprocess.run(cc+['-std=c++20','-Wall','-Wextra','-Werror','-pthread','-I'+str(root/'console/ldn_mitm/source'),str(cpp),str(root/'console/ldn_mitm/source/tcp_stream_proxy.cpp'),str(root/'console/ldn_mitm/source/tcp_stream_hooks.cpp'),'-o',str(binary)],check=True,timeout=40)
 subprocess.run([str(binary)],check=True,timeout=15)
print('BSD source snapshot SHA256',hashlib.sha256(source.encode()).hexdigest())
