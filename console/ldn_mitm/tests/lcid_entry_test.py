#!/usr/bin/env python3
"""Run actual cache/LDN entry functions with bounded host service/network mocks."""
from pathlib import Path
import importlib.util, os, shlex, subprocess, tempfile, hashlib
ROOT=Path(__file__).resolve().parents[3]
spec=importlib.util.spec_from_file_location('slices',ROOT/'app/tests/input_routing_test.py')
slices=importlib.util.module_from_spec(spec);spec.loader.exec_module(slices)
source=(ROOT/'console/ldn_mitm/source/lan_discovery.cpp').read_text()
cache=(ROOT/'console/ldn_mitm/source/game_identity_cache.cpp').read_text()
relay=(ROOT/'console/ldn_mitm/source/lanywhere_relay.cpp').read_text()
functions='\n'.join(slices.function(source,name) for name in [
 'static bool MatchesScanFilter(', 'Result LANDiscovery::resolveGameLcid(',
 'Result LANDiscovery::scan(', 'void LANDiscovery::onPublicGroup(', 'void LANDiscovery::leaveAutoRoom(',
 'Result LANDiscovery::createNetwork(', 'Result LANDiscovery::connect('])
exact='\n'.join(slices.function(cache,name) for name in ['bool ReadAt(', 'GameCacheResult GameIdentityCacheExactRecord('])
template=Path(__file__).with_name('lcid_entry_harness.cpp.in').read_text()
header=(ROOT/'console/ldn_mitm/source/lanywhere_relay.hpp').read_text()
start=header.index('struct DiscoveryRoute {'); route=header[start:header.index('};',start)+2]
start=header.index('struct GameRoute {');route+='\n'+header[start:header.index('};',start)+2]
start=header.index('struct GroupSummaryV2 {');route+='\n'+header[start:header.index('};',start)+2]
relay_functions='\n'.join(slices.function(relay,name) for name in ['bool MakeMatchFilter(', 'void AddCachedIdentity('])
with tempfile.TemporaryDirectory(prefix='lcid-entry-') as tmp:
    tmp=Path(tmp)
    (tmp/'stratosphere.hpp').write_text('#pragma once\n#include <cstdint>\nusing u8=uint8_t;using u16=uint16_t;using u32=uint32_t;using u64=uint64_t;using s64=int64_t;namespace ams::sf{struct LargeData{};struct PrefersPointerTransferMode{};}\n')
    cpp=tmp/'test.cpp';exe=tmp/'test'
    cpp.write_text(template.replace('/* ACTUAL_ROUTES */',route).replace('/* ACTUAL_CACHE */',exact).replace('/* ACTUAL_RELAY */',relay_functions).replace('/* ACTUAL_ENTRIES */',functions))
    cc=shlex.split(os.environ.get('CXX','c++'))
    subprocess.run(cc+['-std=c++17','-Wall','-Wextra','-Werror','-pthread','-I'+str(tmp),'-I'+str(ROOT/'console/ldn_mitm/source'),str(cpp),str(ROOT/'console/ldn_mitm/source/ldn_types.cpp'),'-o',str(exe)],check=True,timeout=40)
    subprocess.run([str(exe)],check=True,timeout=10)
print('LANDiscovery SHA256:',hashlib.sha256(source.encode()).hexdigest())
print('Exact cache source SHA256:',hashlib.sha256(cache.encode()).hexdigest())
print('Actual native entry functions, host FS/network mocks only; no Switch/game acceptance.')
