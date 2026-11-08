#!/usr/bin/env python3
"""Two actual native Proxy objects through an actual isolated Node relay.

The relay keeps its default 512 KiB/s / 1000 packet budget. No stream or
transport mocks, public upstreams, console SDK build or commercial game.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request

ROOT=Path(__file__).resolve().parents[3]
NATIVE=ROOT/'console/ldn_mitm/source'
NODE=os.environ.get('SWITCH_ONLINE_NODE') or os.environ.get('NODE') or shutil.which('node')
if not NODE:
    raise SystemExit('Node.js >=22 is required for the actual relay fixture')
started=time.monotonic()
processes=[]

def stop(process):
    if process.poll() is not None:
        return
    os.killpg(process.pid,signal.SIGTERM)
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid,signal.SIGKILL)
        process.wait(timeout=2)

def stats(port):
    with urllib.request.urlopen('http://127.0.0.1:'+str(port)+'/api/stats',timeout=2) as r:
        return json.loads(r.read(2*1024*1024))

server_source=(ROOT/'server/relay/server.js').read_bytes()
assert b"dataBytes: envInt('LANYWHERE_DATA_BYTES_PER_SEC', 512 * 1024," in server_source
assert b"dataPackets: envInt('LANYWHERE_DATA_PACKETS_PER_SEC', 1000," in server_source
with tempfile.TemporaryDirectory(prefix='tcp-node-budget-') as temporary:
    tmp=Path(temporary)
    snapshots={name:(NATIVE/name).read_bytes() for name in ('tcp_stream_proxy.cpp','tcp_stream_proxy.hpp','tcp_stream_protocol.hpp')}
    for name,data in snapshots.items():
        (tmp/name).write_bytes(data)
    driver_source=Path(__file__).with_name('tcp_node_budget_driver.cpp').read_bytes()
    (tmp/'driver.cpp').write_bytes(driver_source)
    executable=tmp/'driver'
    try:
        subprocess.run(shlex.split(os.environ.get('CXX','c++'))+['-std=c++17','-O1','-Wall','-Wextra','-Werror',
            '-pthread','-I'+str(tmp),str(tmp/'driver.cpp'),str(tmp/'tcp_stream_proxy.cpp'),'-o',str(executable)],check=True,timeout=15)
        with socket.socket() as reservation:
            reservation.bind(('127.0.0.1',0));stats_port=reservation.getsockname()[1]
        # Remove inherited LANYWHERE settings instead of silently relaxing a
        # budget or contacting an inherited public upstream in a test.
        env={k:v for k,v in os.environ.items() if not k.startswith('LANYWHERE_')}
        env.update({'LANYWHERE_STATE_DIR':str(tmp/'state'),'LANYWHERE_STATS_PORT':str(stats_port),
            'LANYWHERE_PUBLIC_PORT':'0','LANYWHERE_OPS_PORT':'0','LANYWHERE_LANPLAY_PORT':'0',
            'LANYWHERE_ENABLE_LANPLAY_UPSTREAM':'0','LANYWHERE_ENABLE_PUBLIC_UPSTREAM':'0',
            'LANYWHERE_CONTROL_BIND_ADDRESS':'127.0.0.1','LANYWHERE_UDP_BIND_ADDRESS':'127.0.0.1',
            'LANYWHERE_SHUTDOWN_GRACE_MS':'0'})
        log_path=tmp/'server.log'
        with log_path.open('wb') as log:
            server=subprocess.Popen([NODE,str(ROOT/'server/relay/server.js'),'--port','0'],cwd=tmp,env=env,
                stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
            processes.append(server)
            until=time.monotonic()+4
            while time.monotonic()<until:
                logs=log_path.read_text(errors='replace')
                if 'datos UDP' in logs and re.search(r'control TCP en (\d+)',logs):
                    break
                assert server.poll() is None,logs[-2000:]
                time.sleep(.02)
            else:
                raise AssertionError('Isolated relay did not become ready: '+logs[-2000:])
            port=int(re.search(r'control TCP en (\d+)',logs)[1])
            driver=subprocess.Popen([str(executable),str(port)],cwd=tmp,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                text=True,start_new_session=True)
            processes.append(driver)
            stdout,stderr=driver.communicate(timeout=25)
            assert driver.returncode==0,{'exit':driver.returncode,'stdout':stdout[-2000:],'stderr':stderr[-2000:],'relay':log_path.read_text(errors='replace')[-2000:]}
            result=json.loads(stdout)
            assert result['status']=='passed' and result['bytes_each_direction']>=256*1024
            state=stats(stats_port);now=state['now'];counters=state.get('counters',{})
            assert now['online']==0 and now['rooms']==0 and now['tcpStreams']=={'streams':0,'opening':0,'legacy':0},now
            assert counters.get('rateLimited',0)==0 and counters.get('pausedRejects',0)==0,counters
            assert counters.get('tcpStream:opened',0)>=1 and counters.get('tcpStream:finished',0)>=1,counters
            assert counters.get('tcpStream:closed',0)==0 and counters.get('tcpStream:reset',0)==0,counters
            assert server.poll() is None,'Relay exited during normal paced traffic'
            result['server_after']={'online':now['online'],'rooms':now['rooms'],'streams':now['tcpStreams'],
                'rate_limited':counters.get('rateLimited',0),'opened':counters.get('tcpStream:opened',0),'finished':counters.get('tcpStream:finished',0)}
    finally:
        for process in reversed(processes):
            stop(process)
        assert all(p.poll() is not None for p in processes),'Test process cleanup incomplete'
assert not tmp.exists(),'Test-owned temporary directory was not removed'
result['cleanup_complete']=True
result['elapsed_ms']=round((time.monotonic()-started)*1000)
result['source_sha256']={'server.js':hashlib.sha256(server_source).hexdigest(),
    'tcp_stream_proxy.cpp':hashlib.sha256(snapshots['tcp_stream_proxy.cpp']).hexdigest(),
    'driver':hashlib.sha256(driver_source).hexdigest()}
print(json.dumps(result,separators=(',',':')))
