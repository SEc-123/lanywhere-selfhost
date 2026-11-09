'use strict';
const { fork } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const catalog = require('./lanplay-providers');

// Each external LAN owns its own member/IP maps and LDN TCP state. Dormant
// realms live longer than the gateway's 55-second resume-token window.
function create({ count = () => {}, paused = () => false, log = () => {}, onEvent = () => {}, idleMs = 65000,
    startupMs = 12000, maxRealms = 3, serverFile = path.join(__dirname, 'server.js'), providers = catalog } = {}) {
    if (!Number.isInteger(maxRealms) || maxRealms < 1 || maxRealms > 8) throw Error('Invalid LAN Play realm limit');
    const realms = new Map(); let stopping = false;
    let allocationTail = Promise.resolve();
    function failure(code, message) { const error = new Error(message); error.code = code; return error; }
    function stop(r, reason = "stopped") {
        if (r.stopping) return r.exited;
        r.stopping = true; clearTimeout(r.idle); clearTimeout(r.startTimer);
        r.reject?.(failure(reason === 'startup_timeout' ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE', 'LAN Play realm stopped')); r.reject = null;
        if (reason !== 'idle' && reason !== 'stopped') onEvent({ provider: r.id, reason });
        r.child.kill('SIGTERM');
        r.killTimer = setTimeout(() => r.child.kill('SIGKILL'), 2000).unref();
        return r.exited;
    }
    function start(provider) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanywhere-realm-'));
        const child = fork(serverFile, ['--port', '0'], { execArgv: ['--max-old-space-size=32'],
            stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env,
                LANYWHERE_STATE_DIR: dir, LANYWHERE_STATS_PORT: '0', LANYWHERE_PUBLIC_PORT: '0', LANYWHERE_OPS_PORT: '0',
                LANYWHERE_CONTROL_BIND_ADDRESS: '127.0.0.1', LANYWHERE_UDP_BIND_ADDRESS: '127.0.0.1',
                LANYWHERE_ENABLE_PUBLIC_UPSTREAM: '0', LANYWHERE_ENABLE_LANPLAY_UPSTREAM: '0', LANYWHERE_LANPLAY_PORT: '0',
                LANYWHERE_LANPLAY_REALM: provider.id, LANYWHERE_LANPLAY_PROVIDERS: provider.id, LANYWHERE_MAX_CONNECTIONS: '8', LANYWHERE_MAX_CONNECTIONS_PER_IP: '8',
                LANYWHERE_SHUTDOWN_GRACE_MS: '0', LANYWHERE_CREATE_PER_MIN: '60', LANYWHERE_CAP_GB: '8000' } });
        const r = { id: provider.id, child, dir, refs: 0, foregroundRefs: 0, stopping: false, endpoint: null, idleSince: 0 };
        r.ready = new Promise((resolve, reject) => { r.resolve = resolve; r.reject = reject; });
        // A rejected startup can precede the first await on acquire.
        r.ready.catch(() => {});
        r.exited = new Promise(resolve => child.once('close', (code, signal) => {
            clearTimeout(r.startTimer); clearTimeout(r.killTimer); clearTimeout(r.idle);
            if (!r.stopping) onEvent({ provider: provider.id, reason: 'unexpected_exit', code: Number.isInteger(code) ? code : 0, signal: ['SIGTERM','SIGKILL','SIGABRT','SIGSEGV'].includes(signal) ? signal : null });
            r.reject?.(failure('UPSTREAM_UNAVAILABLE', 'LAN Play realm exited')); r.reject = null;
            if (realms.get(provider.id) === r) realms.delete(provider.id);
            fs.rmSync(dir, { recursive: true, force: true }); resolve();
        }));
        child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
        child.on('error', () => stop(r, 'process_error'));
        child.on('message', m => {
            if (r.stopping || !m || typeof m !== 'object') return;
            if (m.type === 'ready' && Number.isInteger(m.port) && m.port > 0 && m.port < 65536) {
                clearTimeout(r.startTimer); r.endpoint = { host: '127.0.0.1', port: m.port };
                r.resolve(r.endpoint); r.reject = null; log(`LAN Play realm ready: ${provider.id}`);
            } else if (m.type === 'traffic' && Number.isSafeInteger(m.bytes) && m.bytes >= 0 && m.bytes <= 16 * 1024 * 1024) count(m.bytes);
            else if (m.type === 'failed') stop(r, 'upstream_unavailable');
        });
        r.startTimer = setTimeout(() => stop(r, 'startup_timeout'), startupMs).unref();
        realms.set(provider.id, r); return r;
    }
    // Serialize only allocation/teardown. Reservation happens inside this gate,
    // so a simultaneous acquire cannot evict a realm just handed to another caller.
    async function reserve(provider, discoveryOnly) {
        const previous = allocationTail;
        let unlock;
        allocationTail = new Promise(resolve => { unlock = resolve; });
        await previous;
        try {
            if (stopping || paused()) throw failure('UPSTREAM_UNAVAILABLE', 'LAN Play gateways unavailable');
            let r = realms.get(provider.id);
            if (r?.stopping) {
                await r.exited;
                if (stopping || paused()) throw failure('UPSTREAM_UNAVAILABLE', 'LAN Play gateways unavailable');
                r = realms.get(provider.id);
            }
            if (!r) {
                if (realms.size >= maxRealms) {
                    // Gateway member/resume tokens retain their lease, hence a
                    // zero-ref ready realm has only an expendable discovery cache.
                    const idle = [...realms.values()].filter(item => item.refs === 0 && item.endpoint && !item.stopping)
                        .sort((a,b) => a.idleSince - b.idleSince)[0];
                    // A foreground player can reclaim a realm held only by
                    // background lobby discovery, including during startup.
                    const expendable = idle || (!discoveryOnly &&
                        [...realms.values()].find(item => !item.foregroundRefs && !item.stopping));
                    if (!expendable) {
                        onEvent({ provider: provider.id, reason: 'capacity' });
                        throw failure('REALM_CAPACITY', 'LAN Play community capacity reached');
                    }
                    onEvent({ provider: expendable.id, reason: 'query_cache_recycled' });
                    await stop(expendable, 'idle');
                    if (stopping || paused()) throw failure('UPSTREAM_UNAVAILABLE', 'LAN Play gateways unavailable');
                }
                if (realms.size >= maxRealms) throw failure('REALM_CAPACITY', 'LAN Play community capacity reached');
                r = start(provider);
            }
            r.refs++;
            if (!discoveryOnly) r.foregroundRefs++;
            clearTimeout(r.idle);
            return r;
        } finally { unlock(); }
    }
    async function acquire(provider, discoveryOnly) {
        const r = await reserve(provider, discoveryOnly);
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            if (!discoveryOnly) r.foregroundRefs--;
            if (--r.refs === 0 && !r.stopping) {
                r.idleSince = Date.now();
                r.idle = setTimeout(() => stop(r, 'idle'), idleMs).unref();
            }
        };
        try { return { ...await r.ready, release }; } catch (e) { release(); throw e; }
    }
    const timer = setInterval(() => { if (paused()) for (const r of realms.values()) stop(r); }, 250).unref();
    return {
        providers: providers.map(p => ({ id: p.id, maxConnections: 8, acquire: ({ discoveryOnly = false } = {}) => acquire(p, discoveryOnly),
            connectTimeoutMs: startupMs + 2000, localTransport: true, lanplay: true, udpCaps: 12, capabilities: 78 | 128 | 256 })),
        snapshot: () => [...realms].map(([id, r]) => ({ id, pid: r.child.pid, refs: r.refs, stopping: r.stopping, ready: !!r.endpoint })),
        shutdown: () => { stopping = true; clearInterval(timer); return Promise.all([...realms.values()].map(r => stop(r))); },
    };
}
module.exports = { create };
