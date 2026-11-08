#!/usr/bin/env python3
"""Compile actual overlay IPC C and UI C++ against bounded host service/Tesla doubles."""
from pathlib import Path
import os,re,shlex,subprocess,tempfile
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
overlay=(HERE.parent/'source/ldn.h').read_text()
app=(ROOT/'app/source/lobby_model.h').read_text()
native=(ROOT/'console/ldn_mitm/source/lanywhere_relay.hpp').read_text()
major=int(re.search(r'LANYWHERE_OVERLAY_IPC_MAJOR (\d+)',overlay)[1])
assert major==int(re.search(r'LANYWHERE_IPC_MAJOR (\d+)',app)[1])==int(re.search(r'ProtocolVersion = (\d+)',native)[1])
with tempfile.TemporaryDirectory(prefix='lanywhere-overlay-test-') as d:
 d=Path(d);obj=d/'ldn.o';exe=d/'test'
 subprocess.run(shlex.split(os.environ.get('CC','cc'))+['-std=c11','-Wall','-Wextra','-Werror','-I'+str(HERE),'-c',str(HERE.parent/'source/ldn.c'),'-o',str(obj)],check=True,timeout=30)
 subprocess.run(shlex.split(os.environ.get('CXX','c++'))+['-std=c++20','-Wall','-Wextra','-Werror','-I'+str(HERE),'-DGITDESCVER="host-test"',str(HERE/'overlay_test.cpp'),str(obj),'-o',str(exe)],check=True,timeout=30)
 subprocess.run([str(exe)],check=True,timeout=10)
print('Host doubles exercise actual source; this is not Tesla/hardware rendering or game acceptance.')
