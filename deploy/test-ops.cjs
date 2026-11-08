'use strict';

const assert = require('node:assert/strict');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');

const run = promisify(execFile);
const { validateConfig } = require('./validate-config.cjs');
const root = path.resolve(__dirname, '..');

function tool(name, args = [], env = process.env) {
    return run(process.execPath, [path.join(__dirname, name), ...args], { env, timeout: 10000 });
}

async function ephemeralPorts() {
    const sockets = Array.from({ length: 3 }, () => net.createServer());
    await Promise.all(sockets.map((socket) => new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.listen(0, '127.0.0.1', resolve);
    })));
    const ports = sockets.map((socket) => socket.address().port);
    await Promise.all(sockets.map((socket) => new Promise((resolve) => socket.close(resolve))));
    return ports;
}

async function relay(t, paused = false) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'switch-online-ops-'));
    let child, exited;
    t.after(async () => {
        if (child) {
            child.kill('SIGTERM');
            const force = setTimeout(() => child.kill('SIGKILL'), 2000);
            await exited;
            clearTimeout(force);
        }
        await fs.rm(directory, { recursive: true, force: true });
    });
    const [port, dashboard, operations] = await ephemeralPorts();
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LANYWHERE_')));
    const env = {
        ...inherited,
        LANYWHERE_STATE_DIR: directory,
        LANYWHERE_STATS_PORT: String(dashboard),
        LANYWHERE_OPS_PORT: String(operations),
        LANYWHERE_PUBLIC_PORT: '0',
        LANYWHERE_LANPLAY_PORT: '0',
        LANYWHERE_HEALTH_CONTROL_PORT: String(port),
        LANYWHERE_SHUTDOWN_GRACE_MS: '250',
        LANYWHERE_CAP_GB: paused ? '0.000001' : '100',
    };
    if (paused) {
        const month = new Date().toISOString().slice(0, 7);
        await fs.writeFile(path.join(directory, 'traffic.json'), JSON.stringify({ month, bytes: 5000 }));
    }
    child = spawn(process.execPath, [path.join(root, 'server/relay/server.js'), '--port', String(port)], {
        env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    exited = new Promise((resolve) => {
        child.once('exit', resolve);
        child.once('error', resolve);
    });
    let errors = '';
    child.stderr.on('data', (chunk) => { errors += chunk.toString(); });

    try {
        await tool('healthcheck.cjs', paused ? ['--allow-paused'] : [], env);
    } catch (error) {
        throw new Error(`${error.stderr || error.message}\n${errors}`);
    }
    const readiness = () => fetch(`http://127.0.0.1:${operations}/api/ready`, { signal: AbortSignal.timeout(1000) });
    return { child, env, port, readiness };
}

test('configuration accepts documented values and rejects injection, duplicates and invalid limits', () => {
    validateConfig('LANYWHERE_CAP_GB=50.5\nLANYWHERE_MATCH_HOLD_MS=30000\nLANYWHERE_SHUTDOWN_GRACE_MS=0');
    assert.throws(() => validateConfig('LD_PRELOAD=/tmp/unsafe.so'), /not a managed setting/);
    assert.throws(() => validateConfig('LANYWHERE_CAP_GB=1\nLANYWHERE_CAP_GB=2'), /repeated/);
    assert.throws(() => validateConfig('LANYWHERE_OPS_TOKEN=wrong'), /generated/);
    assert.throws(() => validateConfig('LANYWHERE_LANPLAY_PORT=11460'), /separate port/);
    assert.throws(() => validateConfig('LANYWHERE_MAX_CONNECTIONS=2'), /exceeds/);
    validateConfig('LANYWHERE_UDP_BIND_ADDRESS=0.0.0.0\nLANYWHERE_JOIN_TIMEOUT_MS=100\nLANYWHERE_CREATE_PER_MIN=1');
    validateConfig('LANYWHERE_UDP_BIND_ADDRESS=192.0.2.10\nLANYWHERE_JOIN_TIMEOUT_MS=120000\nLANYWHERE_CREATE_PER_MIN=1000',
        { localAddresses: ['192.0.2.10'] });
    for (const value of ['localhost', '1.2.3.999', '127.00.0.1', '::1'])
        assert.throws(() => validateConfig(`LANYWHERE_UDP_BIND_ADDRESS=${value}`), /literal IPv4/);
    assert.throws(() => validateConfig('LANYWHERE_UDP_BIND_ADDRESS=198.51.100.10', { localAddresses: ['192.0.2.10'] }), /local interface/);
    for (const setting of ['LANYWHERE_JOIN_TIMEOUT_MS=99', 'LANYWHERE_JOIN_TIMEOUT_MS=120001',
        'LANYWHERE_CREATE_PER_MIN=0', 'LANYWHERE_CREATE_PER_MIN=1001']) assert.throws(() => validateConfig(setting), /between/);
});

test('real relay smoke, private metrics and drain readiness', { timeout: 20000 }, async (t) => {
    const { child, env, port, readiness } = await relay(t);
    assert.match((await tool('smoke-relay.cjs', ['127.0.0.1', String(port)], env)).stdout, /bidirectional UDP, leave/);
    assert.match((await tool('smoke-relay-v2.cjs', ['127.0.0.1', String(port)], env)).stdout,
        /bidirectional 1472\/4096\/65507-byte datagrams.*nonce heartbeats.*two-room/);
    const { stdout } = await tool('metrics.cjs', [], env);
    const values = stdout.split('\n').filter((line) => line && !line.startsWith('#'));
    assert.ok(values.every((line) => /^switch_online_[a-z_]+ \d+$/.test(line)));
    assert.ok(values.includes('switch_online_ready 1'));
    assert.ok(values.includes('switch_online_rooms 0'));
    assert.doesNotMatch(stdout, /RelaySmoke|127\.0\.0\.1|\{|room_code|nickname/);

    child.kill('SIGUSR2');
    let draining = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await readiness();
        const data = await response.json();
        if (response.status === 503 && data.status === 'draining') {
            draining = true;
            break;
        }
        await delay(50);
    }
    assert.ok(draining);
    await assert.rejects(tool('healthcheck.cjs', ['--once'], env), (error) => /not ready \(draining\)/.test(error.stderr));
    assert.match((await tool('healthcheck.cjs', ['--once', '--live'], env)).stdout, /are alive/);
});

test('traffic cap pause does not look ready and explicitly permits process startup', { timeout: 12000 }, async (t) => {
    const { env, readiness } = await relay(t, true);
    const response = await readiness();
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: 'paused' });
    await assert.rejects(tool('healthcheck.cjs', ['--once'], env), (error) => /not ready \(paused\)/.test(error.stderr));
    assert.match((await tool('healthcheck.cjs', ['--once', '--allow-paused'], env)).stdout, /traffic cap reached/);
    assert.match((await tool('metrics.cjs', [], env)).stdout, /^switch_online_traffic_paused 1$/m);
});
