#!/usr/bin/env python3
"""Exercise current native discovery functions using isolated TCP relays and FS fixtures."""
import hashlib
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[3]
SOURCE = ROOT / 'console/ldn_mitm/source/lanywhere_relay.cpp'
HEADER = ROOT / 'console/ldn_mitm/source/lanywhere_relay.hpp'


def function(source, signature):
    begin = source.index(signature)
    masked = re.sub(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\\n])\'',
                    lambda m: ' ' * len(m.group()), source, flags=re.S)
    opening = masked.index('{', begin)
    depth = 0
    for at in range(opening, len(masked)):
        depth += (masked[at] == '{') - (masked[at] == '}')
        if depth == 0:
            return source[begin:at + 1]
    raise ValueError('Unclosed function: ' + signature)


def selection_state(source):
    start = source.index('        constexpr u64 HostRouteEpoch')
    end = source.index('        // Called with g_lock held. A reserved match', start)
    return (profile_prelude() + community_endpoint_functions(source) + '\n' + source[start:end]
            .replace('void RememberDirectoryRegions(', '[[maybe_unused]] void RememberDirectoryRegions(')
            .replace('void ClearSelectionLocked(', '[[maybe_unused]] void ClearSelectionLocked(')
            .replace('void SelectRouteLocked(', '[[maybe_unused]] void SelectRouteLocked('))


def profile_prelude():
    return ('#include "regional_relay.h"\n'
            '#ifndef RELAY_PROFILE_EU_IPV4\n#define RELAY_PROFILE_EU_IPV4 ""\n#endif\n'
            '#ifndef RELAY_PROFILE_EU_PORT\n#define RELAY_PROFILE_EU_PORT 11460\n#endif\n'
            '#ifndef RELAY_PROFILE_COMMUNITY_IPV4\n#define RELAY_PROFILE_COMMUNITY_IPV4 "127.0.0.1"\n#endif\n'
            '#ifndef RELAY_PROFILE_COMMUNITY_PORT\n#define RELAY_PROFILE_COMMUNITY_PORT 11460\n#endif\n')


def community_endpoint_functions(source):
    return '\n'.join(function(source, sig) for sig in [
        'bool CommunityEndpoint(', 'bool TrustedCommunityEndpoint('])



def main():
    source = SOURCE.read_text()
    header = HEADER.read_text()
    route_start = header.index('    struct DiscoveryRoute {')
    route = header[route_start:header.index('};', route_start) + 2]
    names = [
        ('LOAD', 'bool LoadServer('), ('RESOLVE', 'bool ResolveDiscoveryRoute('),
        ('CHOOSE', 'bool ChooseEnterRoute('), ('CAPTURE', 'bool CaptureDiscoveryRoute('),
        ('CURRENT', 'bool DiscoveryRouteStillSelected(const DiscoveryRoute &route) {'), ('SEND', 'bool SendFrameTo('),
        ('READ', 'ssize_t ReadFrame('), ('READ_LIST', 'ssize_t ReadListFrame('), ('CONNECT', 'int ConnectServer('),
        ('CAPS', 'bool QueryCapabilities(int fd, u32 *flags, int timeout_ms, u32 *status) {'),
        ('LEGACY', 'int ReadLegacyDiscovery('), ('PAGE', 'int ReadPagedDiscovery('),
        ('CONNECTION', 'int DiscoveryConnection('), ('UNFILTERED', 'int ReadUnfilteredPage('),
        ('FIND', 'int FindGroups(u64 '), ('FIND_PAGE', 'int FindGroupsPage('),
        ('FILTERED', 'int FindGroupsFilteredPage('), ('JOIN', 'Result JoinRoom('),
        ('NICKNAME', 'void Nickname('),
    ]
    game_route_start = header.index('    struct GameRoute {')
    game_route = header[game_route_start:header.index('};', game_route_start) + 2]
    pieces = {'ROUTE': route, 'GAME_ROUTE': game_route, 'SELECTION': selection_state(source)}
    pieces.update((key, function(source, signature)) for key, signature in names)
    pieces['CONNECT'] = function(source, 'int RemainingIoMs(') + '\n' + pieces['CONNECT']
    for name in ('le16', 'le32', 'le64', 'put16', 'put32', 'put64'):
        signature = ('void ' if name.startswith('put') else 'u' + name[2:] + ' ') + name + '('
        pieces[name.upper()] = function(source, signature)
    # Bind the tested selector to the real Enter/scan/connect call sites too.
    enter = function(source, 'Result Enter(')
    assert 'ChooseEnterRoute(pinned, discovery_route, std::addressof(server), provider)' in enter
    assert 'ConnectTimeoutMs, provider)' in enter
    discovery = (ROOT / 'console/ldn_mitm/source/lan_discovery.cpp').read_text()
    scan = function(discovery, 'Result LANDiscovery::scan(')
    assert scan.count('CaptureGameRoute(&gameRoute)') == 1 and 'PublicEnabled()' not in scan
    assert scan.index('CaptureGameRoute(&gameRoute)') < scan.index('ScanMatch(') < scan.index('CollectPublicPages(')
    assert 'const auto &route = gameRoute.discovery;' in scan and 'GameRouteStillCurrent(gameRoute)' in scan
    assert scan.index('PublicScanContext context{this, &filter, route}') < scan.index('CollectPublicPages(')
    assert 'FindGroupsFilteredPage(filter, offset, next, &LANDiscovery::onPublicGroup, &context, &route)' in scan
    assert 'g.route = context.route;' in function(discovery, 'void LANDiscovery::onPublicGroup(')
    connect = function(discovery, 'Result LANDiscovery::connect(')
    assert 'gameRoute.discovery = this->publicGroups[i].route;' in connect
    assert 'JoinRoom(code, networkInfo->networkId.intentId.localCommunicationId, &gameRoute.discovery, &this->ownedGameRoute)' in connect
    template = Path(__file__).with_name('discovery_route_harness.cpp.in').read_text()
    for key, value in pieces.items():
        marker = '/* ACTUAL_' + key + ' */'
        assert template.count(marker) == 1, marker
        template = template.replace(marker, value)
    assert '/* ACTUAL_' not in template
    with tempfile.TemporaryDirectory(prefix='switch-discovery-route-') as temporary:
        directory = Path(temporary)
        generated = directory / 'route.cpp'; binary = directory / 'route'
        generated.write_text(template)
        compiler = shlex.split(os.environ.get('CXX', 'c++'))
        for fixed in (0, 1):
            subprocess.run(compiler + ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-pthread',
                           '-I' + str(ROOT / 'common'), '-DRELAY_PROFILE_FIXED=' + str(fixed), str(generated), '-o', str(binary)], check=True, timeout=40)
            subprocess.run([str(binary)], check=True, timeout=30)
    print('Native source snapshot SHA-256:', hashlib.sha256(source.encode()).hexdigest())
    print('Actual function slices and isolated loopback sockets; not a Switch/game acceptance test.')


if __name__ == '__main__':
    main()
