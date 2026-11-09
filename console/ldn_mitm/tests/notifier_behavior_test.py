#!/usr/bin/env python3
"""Run actual notifier implementation with in-memory host OS and filesystem mocks."""
from pathlib import Path
import hashlib,json,subprocess,tempfile
root=Path(__file__).resolve().parents[3]
source=(root/'console/ldn_mitm/source/appointment_notifier.cpp').read_text()
digest=hashlib.sha256(source.encode()).hexdigest()
assert source.count('#include "appointment_notifier.hpp"')==1
source=source.replace('#include "appointment_notifier.hpp"','')
harness=(Path(__file__).with_name('notifier_harness.cpp.in')).read_text().replace('@ACTUAL_SOURCE@',source)
with tempfile.TemporaryDirectory(prefix='notifier-host-') as td:
 p=Path(td);(p/'main.cpp').write_text(harness)
 subprocess.run(['c++','-std=c++20','-Wall','-Wextra','-Werror','-I',str(root/'common'),str(p/'main.cpp'),'-o',str(p/'test')],check=True)
 result=subprocess.run([str(p/'test')],text=True,capture_output=True)
 if result.returncode:
  print(result.stdout,end='');print(result.stderr,end='');raise SystemExit(result.returncode)
 lines=result.stdout.splitlines();message=json.loads(lines[0])
 assert message['title']=='LANywhere' and message['text']=='猎人"\\测试 · 房间已开放' and message['duration']==7000
 print('\n'.join(lines[1:]));print('PASS: JSON parses with Chinese text, escaped quote and backslash')
 print('notifier SHA256:',digest)
 print('Scope: actual notifier code, simulated host filesystem, clock and relay; not Switch/Ultrahand runtime.')
