import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length !== 0 && !(args.length === 2 && args[0] === '--report')) {
    console.error('Usage: npm test [-- --report path]');
    process.exit(2);
}

const reportPath = args[1] ? path.resolve(args[1]) : path.join(root, 'evidence', 'test-report.json');
const temp = await mkdtemp(path.join(tmpdir(), 'lanywhere-tests-'));
const publicReport = path.join(temp, 'public-e2e.json');
const configBinary = path.join(temp, 'relay-config-test');
const fixedConfigBinary = path.join(temp, 'relay-config-fixed-test');
const lobbyBinary = path.join(temp, 'lobby-model-test');
const report = {
    startedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, architecture: process.arch },
    scope: 'Host and simulated console wire protocol tests over loopback',
    switchHardwareTested: false,
    commercialGameExecuted: false,
    suites: [],
};

function execute(command, args, env) {
    return new Promise((resolve, reject) => {
        // Keep subprocesses in their own group so a failed startup cannot leave a test relay running.
        const detached = process.platform !== 'win32';
        const child = spawn(command, args, { cwd: root, env, stdio: 'inherit', detached });
        const deadline = setTimeout(() => {
            try {
                if (detached && child.pid) process.kill(-child.pid, 'SIGKILL');
                else child.kill('SIGKILL');
            } catch (error) {
                if (error.code !== 'ESRCH') reject(error);
            }
            reject(new Error('Timed out after 60 seconds'));
        }, 60_000);
        child.once('error', (error) => { clearTimeout(deadline); reject(error); });
        child.once('close', (code, signal) => {
            clearTimeout(deadline);
            if (code === 0) resolve();
            else reject(new Error(signal ? `Terminated by ${signal}` : `Exited with status ${code}`));
        });
    });
}

async function suite(name, command, args, env = process.env) {
    const start = Date.now();
    const item = { name, command: [command, ...args] };
    report.suites.push(item);
    console.log(`\n${name}`);
    try {
        await execute(command, args, env);
        item.status = 'passed';
    } catch (error) {
        item.status = 'failed';
        item.error = error.message;
        console.error(`${name}: ${error.message}`);
    } finally {
        item.durationMs = Date.now() - start;
    }
    return item.status === 'passed';
}

try {
    await suite('Relay and legacy protocol', process.execPath, ['server/relay/test.js'], {
        ...process.env, LANYWHERE_LANPLAY_PORT: '0', LANYWHERE_PUBLIC_PORT: '0',
    });
    await suite('Public relay safety', process.execPath, ['server/relay/test-public-safety.js']);
    await suite('Public lobby pagination', process.execPath, ['server/relay/test-group-page.js']);
    await suite('Public lobby pagination over TCP', process.execPath, ['server/relay/test-pagination-e2e.js']);
    await suite('Reserved matchmaking over TCP', process.execPath, ['server/relay/test-matchmaking.js']);
    await suite('Self game-ID guard and preserved legacy routing', process.execPath, ['--test', 'server/relay/test-self-lcid-guard.js']);
    await suite('Local administrative endpoints', process.execPath, ['server/relay/test-operations.js']);
    await suite('Atomic traffic state persistence', process.execPath, ['server/relay/test-traffic-store.js']);
    await suite('Cloud operations and bidirectional relay smoke', process.execPath, ['--test', 'deploy/test-ops.cjs']);
    await suite('Systemd installer rollback preserves recovery material', process.execPath, ['--test', 'deploy/test-install-systemd.cjs']);
    await suite('Linux capability and private runtime preflight', process.execPath, ['--test', 'deploy/test-preflight.cjs']);
    await suite('State backup and recovery', process.env.PYTHON || 'python3', ['-B', 'deploy/test-state-backup.py']);
    await suite('Public multiplayer wire protocol', process.execPath, ['server/relay/test-public-e2e.js', '--report', publicReport]);
    try {
        report.publicWireProtocol = JSON.parse(await readFile(publicReport, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    await suite('LAN Play gateway', process.execPath, ['server/relay/test-lanplay.js']);
    await suite('UDP fragment memory and replay bounds', process.execPath, ['--test', 'server/relay/test-udp-fragments.js']);
    await suite('UDP v2 MTU-safe public wire protocol', process.execPath, ['--test', 'server/relay/test-udp-v2.js']);
    await suite('LAN Play isolation and fragment safety', process.execPath, ['--test', 'server/relay/test-lanplay-safety.js']);
    for (const name of ['public_scan_pages', 'udp_reassembly', 'relay_queue', 'virtual_receive', 'udp_heartbeat', 'udp_port_policy']) {
        const binary = path.join(temp, `${name}-test`);
        const built = await suite(`Console ${name} host build`, process.env.CXX || 'c++',
            ['-std=c++17', '-Wall', '-Wextra', '-Werror', `console/ldn_mitm/tests/${name}_test.cpp`, '-o', binary]);
        if (built) await suite(`Console ${name} behavior`, binary, []);
    }
    await suite('Upstream provider and token isolation', process.execPath, ['--test', 'server/relay/test-upstream-gateway.js']);
    await suite('Relay inbound control deadline', process.execPath, ['--test', 'server/relay/test-inbound-deadline.js']);
    await suite('Durable appointments and self-network isolation', process.execPath, ['--test',
        'server/relay/test-appointments.js', 'server/relay/test-appointments-e2e.js']);
    await suite('Realm query-cache recycling and protected leases', process.execPath, ['--test', 'server/relay/test-realm-policy.js']);
    await suite('Host game identity metadata', process.execPath, ['--test', 'server/relay/test-room-metadata.js']);
    await suite('LAN Play upstream realms', process.execPath, ['--test', 'server/relay/test-lanplay-upstream.js']);
    for (const [name, file] of [
        ['Pinned fork wire formats', 'test-lanplay-fork-wire.js'],
        ['Fork discovery, join, UDP and room isolation', 'test-lanplay-fork.js'],
        ['Legacy TCP adapter bounds and semantics', 'test-lanplay-fork-tcp.js'],
        ['Legacy TCP adapter and actual stream router', 'test-lanplay-fork-tcp-router.js'],
        ['Actual relay and fork TCP end to end', 'test-lanplay-fork-stream-e2e.js'],
        ['Fork traffic through isolated upstream realms', 'test-lanplay-fork-upstream.js'],
        ['Stream framing, admission, credit and epochs', 'test-tcp-streams.js'],
        ['Actual TCP stream and legacy search throttling', 'test-tcp-stream-wire.js'],
    ]) await suite(name, process.execPath, ['--test', `server/relay/${file}`]);
    await suite('Complete runtime deployment package', process.execPath, ['--test', 'deploy/test-runtime-package.cjs']);
    await suite('Public network catalog checker', process.env.PYTHON || 'python3', ['-B', 'deploy/test-public-network-catalog.py']);
    await suite('Native fixed discovery route and configuration', process.env.PYTHON || 'python3', ['-B', 'console/ldn_mitm/tests/discovery_route_test.py']);
    await suite('Tesla overlay IPC and controls', process.env.PYTHON || 'python3', ['-B', 'console/overlay/tests/overlay_test.py']);
    const lcidBinary = path.join(temp, 'lcid-policy-test');
    const lcidBuilt = await suite('Default game ID policy build', process.env.CXX || 'c++',
        ['-std=c++17', '-Wall', '-Wextra', '-Werror', 'console/ldn_mitm/tests/lcid_policy_test.cpp', '-o', lcidBinary]);
    if (lcidBuilt) await suite('Canonical self IDs and legacy wire policy', lcidBinary, []);
    await suite('Actual game ID cache and create/scan/connect entrypoints', process.env.PYTHON || 'python3', ['-B', 'console/ldn_mitm/tests/lcid_entry_test.py']);
    await suite('Actual game ID route and owned-room cleanup', process.env.PYTHON || 'python3', ['-B', 'console/ldn_mitm/tests/lcid_route_test.py']);
    await suite('Native game password IPC and bounded transport', process.env.PYTHON || 'python3', ['-B', 'console/ldn_mitm/tests/room_passcode_test.py']);
    await suite('Unified lobby discovery, source isolation and stable paging', process.execPath, ['--test', 'server/relay/test-unified-lobby.js']);
    await suite('Native appointment IPC and self-network isolation', process.env.PYTHON || 'python3', ['-B', 'console/ldn_mitm/tests/appointments_ipc_test.py']);
    await suite('Public game password relay ownership and lifecycle', process.execPath, ['--test', 'server/relay/test-game-code-e2e.js']);
    await suite('Native open-room alert and Ultrahand payload', process.env.PYTHON || 'python3', ['-B', 'console/ldn_mitm/tests/notifier_behavior_test.py']);
    await suite('Native typed listing failures over loopback', process.env.PYTHON || 'python3', ['-B', 'console/ldn_mitm/tests/list_status_test.py']);
    await suite('Native TCP relay epochs, failure shutdown and negotiation', process.env.PYTHON || 'python3', ['-B', 'console/ldn_mitm/tests/tcp_relay_glue_test.py']);
    await suite('Native relay reconnect identity, deadlines and cancellation', process.env.PYTHON || 'python3', ['-B', 'console/ldn_mitm/tests/transport_recovery_test.py']);
    await suite('Native relay worker after Wi-Fi and path failures', process.env.PYTHON || 'python3', ['-B', 'console/ldn_mitm/tests/relay_recovery_worker_test.py']);
    const streamBinary = path.join(temp, 'tcp-stream-proxy-test');
    const streamBuilt = await suite('Native TCP proxy actual socket build', process.env.CXX || 'c++',
        ['-std=c++20', '-Wall', '-Wextra', '-Werror', '-pthread',
         'console/ldn_mitm/source/tcp_stream_proxy.cpp', 'console/ldn_mitm/tests/tcp_stream_proxy_test.cpp', '-o', streamBinary]);
    if (streamBuilt) await suite('Native TCP proxy sockets, credit and lifecycle', streamBinary, []);
    await suite('Actual BSD hook IPC and virtual socket semantics', process.env.PYTHON || 'python3', ['-B', 'console/ldn_mitm/tests/tcp_stream_ipc_test.py']);
    await suite('Actual native TCP proxies through the real relay budget', process.env.PYTHON || 'python3', ['-B', 'console/ldn_mitm/tests/tcp_node_budget_test.py']);
    await suite('App typed listing status and empty-result distinction', process.env.PYTHON || 'python3', ['-B', 'app/tests/list_status_test.py']);
    const identityBinary = path.join(temp, 'game-identity-test');
    const identityBuilt = await suite('NACP identity decoder build', process.env.CC || 'cc',
        ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Iapp/source', 'app/tests/game_identity_test.c', 'app/source/nacp_titles.c', '-lz', '-o', identityBinary]);
    if (identityBuilt) await suite('NACP identities and compressed titles', identityBinary, []);
    const inventoryBinary = path.join(temp, 'title-inventory-test');
    const inventoryBuilt = await suite('Installed title inventory build', process.env.CC || 'cc',
        ['-std=c11', '-Wall', '-Wextra', '-Werror', '-Iapp/source', 'app/tests/title_inventory_test.c', 'app/source/title_inventory.c', 'app/source/nacp_titles.c', '-lz', '-o', inventoryBinary]);
    if (inventoryBuilt) await suite('Installed title inventory and cache recovery', inventoryBinary, []);
    const cacheBinary = path.join(temp, 'identity-cache-filesystem-test');
    const cacheBuilt = await suite('Native title cache reader build', process.env.CXX || 'c++',
        ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-Iapp/tests/mock_horizon', 'app/tests/game_identity_cache_fs_test.cpp', '-o', cacheBinary]);
    if (cacheBuilt) await suite('Native title cache reader and fingerprint', cacheBinary, []);
    await suite('Actual title display and launch gate', process.env.PYTHON || 'python3', ['-B', 'app/tests/game_identity_ui_test.py']);
    await suite('Offline title catalog and room/lobby recovery', process.env.PYTHON || 'python3', ['-B', 'app/tests/catalog_recovery_test.py']);
    await suite('Title catalog sources, scope and deterministic generation', process.env.PYTHON || 'python3', ['-B', 'compatibility/title-catalog/test_generator.py']);
    await suite('Actual local installation verification', process.env.PYTHON || 'python3', ['-B', 'app/tests/game_info_install_test.py']);
    await suite('Actual room card icon and launch separation', process.env.PYTHON || 'python3', ['-B', 'app/tests/icon_card_test.py']);
    await suite('Actual icon cache retry', process.env.PYTHON || 'python3', ['-B', 'app/tests/icon_cache_test.py']);
    await suite('Icon diagnostic and network offline hint', process.env.PYTHON || 'python3', ['-B', 'app/tests/icon_diagnostics_test.py']);
    await suite('Actual JPEG decoding with libjpeg-turbo', process.env.PYTHON || 'python3', ['-B', 'app/tests/icon_jpeg_test.py']);
    await suite('App inventory refresh result and failure feedback', process.env.PYTHON || 'python3', ['-B', 'app/tests/inventory_result_test.py']);
    const built = await suite('App relay configuration build', process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', '-Werror',
        '-DRELAY_PROFILE_FIXED=0', '-Iapp/source', 'app/source/relay_config.c', 'app/tests/relay_config_test.c', '-o', configBinary]);
    if (built) await suite('App relay configuration', configBinary, []);
    const fixedBuilt = await suite('App built-in relay configuration build', process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', '-Werror',
        '-DRELAY_PROFILE_FIXED=1', '-Iapp/source', 'app/source/relay_config.c', 'app/tests/relay_config_fixed_test.c', '-o', fixedConfigBinary]);
    if (fixedBuilt) await suite('App uses built-in relay without SD configuration', fixedConfigBinary, []);
    const lobbyBuilt = await suite('App lobby identity build', process.env.CC || 'cc', ['-std=c11', '-Wall', '-Wextra', '-Werror',
        '-Iapp/source', 'app/source/lobby_model.c', 'app/tests/lobby_model_test.c', '-o', lobbyBinary]);
    if (lobbyBuilt) await suite('App stable room selection', lobbyBinary, []);
    const uiBinary = path.join(temp, 'ui-text-test');
    const uiBuilt = await suite('App translation format build', process.env.CC || 'cc',
        ['-std=c11', '-Wall', '-Wextra', '-Werror', 'app/tests/ui_text_test.c', '-o', uiBinary]);
    if (uiBuilt) await suite('App translation formats and fallback', uiBinary, []);
    await suite('App Chinese UI key coverage', process.env.PYTHON || 'python3', ['-B', 'app/tests/ui_text_coverage_test.py']);
    await suite('App actual input routing and nickname boundaries', process.env.PYTHON || 'python3', ['-B', 'app/tests/input_routing_test.py']);
    await suite('Game password input, display and live refresh', process.env.PYTHON || 'python3', ['-B', 'app/tests/room_password_test.py']);
    await suite('Appointment UI, language, precise time and room handoff', process.env.PYTHON || 'python3', ['-B', 'app/tests/appointments_ui_test.py']);
    const localeBinary = path.join(temp, 'ui-locale-test');
    const localeBuilt = await suite('App language preference build', process.env.CC || 'cc',
        ['-std=c11', '-Wall', '-Wextra', '-Werror', 'app/tests/ui_locale_test.c', '-o', localeBinary]);
    if (localeBuilt) await suite('App language preference persistence and failure recovery', localeBinary, []);
    await suite('Player README and game-list packaging', process.env.PYTHON || 'python3', ['-B', 'scripts/package_player_test.py']);
    await suite('Player-facing errors in English and Chinese', process.env.PYTHON || 'python3', ['-B', 'app/tests/player_errors_test.py']);
    report.status = report.suites.every((item) => item.status === 'passed') ? 'passed' : 'failed';
} catch (error) {
    report.status = 'failed';
    report.error = error.message;
    console.error(error);
} finally {
    report.finishedAt = new Date().toISOString();
    try {
        await mkdir(path.dirname(reportPath), { recursive: true });
        await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        console.log(`\nReport: ${reportPath}`);
    } finally {
        await rm(temp, { recursive: true, force: true });
    }
}
if (report.status !== 'passed') process.exitCode = 1;
