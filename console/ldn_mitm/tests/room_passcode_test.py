#!/usr/bin/env python3
"""Run actual native room password IPC and framing against isolated loopback fixtures."""
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

from discovery_route_test import HEADER, ROOT, SOURCE, function


def main():
    source = SOURCE.read_text()
    header = HEADER.read_text()
    here = Path(__file__).resolve().parent
    base = (here / 'discovery_route_harness.cpp.in').read_text()
    template = base.split('/* ACTUAL_CHOOSE */', 1)[0] + '\n'
    template += '\n'.join('/* ACTUAL_' + key + ' */' for key in ['CAPTURE', 'SEND', 'READ', 'READ_LIST', 'CONNECT'])
    template += '\n' + base[base.index('static void config('):base.index('class Relay {')]
    template = template.replace('inline void GenerateRandomBytes(void *p,size_t n){std::memset(p,0,n);}',
                                'inline void GenerateRandomBytes(void *p,size_t n){std::memset(p,0x3c,n);}')
    template = template.replace('enum class RelayState {Idle,InRoom,Error}', 'enum class RelayState {Idle,Connecting,InRoom,Error}')
    names = {
        'LOAD': 'bool LoadServer(', 'RESOLVE': 'bool ResolveDiscoveryRoute(',
        'CAPTURE': 'bool CaptureDiscoveryRoute(', 'SEND': 'bool SendFrameTo(',
        'READ': 'ssize_t ReadFrame(', 'READ_LIST': 'ssize_t ReadListFrame(', 'CONNECT': 'int ConnectServer(',
    }
    pieces = {key: function(source, sig) for key, sig in names.items()}
    from discovery_route_test import selection_state
    pieces['SELECTION'] = selection_state(source)
    pieces['CONNECT'] = function(source, 'int RemainingIoMs(') + '\n' + pieces['CONNECT']
    for name in ('le16', 'le32', 'le64', 'put16', 'put32', 'put64'):
        sig = ('void ' if name.startswith('put') else 'u' + name[2:] + ' ') + name + '('
        pieces[name.upper()] = function(source, sig)
    for key, struct in [('ROUTE', 'DiscoveryRoute'), ('GAME_ROUTE', 'GameRoute')]:
        start = header.index('    struct ' + struct + ' {')
        pieces[key] = header[start:header.index('};', start) + 2]
    for key, value in pieces.items():
        marker = '/* ACTUAL_' + key + ' */'
        assert template.count(marker) == 1, marker
        template = template.replace(marker, value)

    match_status = header[header.index('    enum class MatchMode'):header.index('    static_assert(sizeof(MatchStatus)')]
    intent = source[source.index('        struct MatchTicket {'):source.index('        bool ValidCode(', source.index('        struct MatchTicket {'))]
    native = match_status + intent + '\n' + '\n'.join(function(source, sig) for sig in [
        'bool CaptureGameRoute(', 'bool CaptureHostGameRoute(', 'bool GameRouteStillCurrent(',
        'bool CaptureAppointmentRoute(', 'bool AppointmentBackendCurrent(',
        'void SetMatchState(', 's64 MatchRemainingMs(', 'bool SameTicket(',
        'bool QueryCapabilities(int fd, u32 *flags, int timeout_ms, u32 *status) {',
        'void ReleaseTicket(', 'void NewTicketLocked(', 'Result StartMatch(', 'void CancelMatch(',
        'Result SelectUnifiedRoom(', 'void PollMatch(',
    ])
    start = source.index('    namespace {\n        constexpr int RoomPasscodeTimeoutMs')
    native += '\n' + source[start:source.index('    int FindGroupSummaries(', start)]
    service = (SOURCE.parent / 'lanywhere_service.cpp').read_text()
    service_header = (SOURCE.parent / 'lanywhere_service.hpp').read_text()
    names = [(17, 'SetRoomPasscode'), (18, 'GetRoomPasscode'), (19, 'GetRoomPasscodeHost'),
             (20, 'SetGameRoomAccess'), (21, 'UnlockGameRoom'), (25, 'SelectUnifiedLobbyRoom')]
    for number, name in names:
        assert re.search(rf'AMS_SF_METHOD_INFO\(C, H, {number}, Result, {name}\b', service_header)
    ipc = '\n'.join(function(service, f'Result LanywhereService::{name}(') for _, name in names)
    harness = (here / 'room_passcode_harness.cpp.in').read_text()
    template += harness.replace('/* ACTUAL_PASSCODE */', native).replace('/* ACTUAL_IPC */', ipc)

    with tempfile.TemporaryDirectory(prefix='lanywhere-passcode-') as tmp:
        source_path, binary = Path(tmp) / 'test.cpp', Path(tmp) / 'test'
        source_path.write_text(template)
        compiler = shlex.split(os.environ.get('CXX', 'c++'))
        subprocess.run(compiler + ['-std=c++20', '-Wall', '-Wextra', '-Werror', '-Wno-unused-function',
                      '-Wno-unused-const-variable', '-pthread', '-I' + str(ROOT / 'common'),
                      str(source_path), '-o', str(binary)], check=True, timeout=40)
        subprocess.run([str(binary)], check=True, timeout=20)


if __name__ == '__main__':
    main()
