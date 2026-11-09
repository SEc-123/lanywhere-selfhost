'use strict';
// Real parent relay, loopback only. The external provider is a synthetic local
// control endpoint and never contacts LAN Play or the public Internet.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ConsolePeer, networkInfo, until } = require('./test-public-e2e');

const T_REQUEST = 0x26, T_REPLY = 0xa6;
const ID_A = Buffer.alloc(16, 0x11), ID_B = Buffer.alloc(16, 0x22);
const GAME = 0x0100000000abc000n, APP = 0x0100abcd12345000n;
function request(op, client, {offset = 0, id = 0n, start = 0n, game = 0n, app = 0n} = {}) {
    const b = Buffer.alloc(56); b[0] = op; b.writeUInt32LE(offset, 4); client.copy(b, 8);
    b.writeBigUInt64LE(id, 24); b.writeBigUInt64LE(start, 32);
    b.writeBigUInt64LE(game, 40); b.writeBigUInt64LE(app, 48); return b;
}
function parse(body) {
    assert.equal(body.length, 264, 'fixed reply length');
    const status = body.readUInt32LE(0), count = body.readUInt32LE(4), next = body.readUInt32LE(8);
    assert(count <= 6); assert.equal(body.readUInt32LE(12), 0);
    const now = body.readBigUInt64LE(16); assert(now > 1_500_000_000n);
    const rows = Array.from({ length: count }, (_, i) => {
        const p = 24 + i * 40;
        assert.equal(body[p + 37] | body[p + 38] | body[p + 39], 0);
        assert(body[p + 36] <= 1);
        return { id: body.readBigUInt64LE(p), start: body.readBigUInt64LE(p + 8),
            game: body.readBigUInt64LE(p + 16), app: body.readBigUInt64LE(p + 24),
            interested: body.readUInt32LE(p + 32), followed: !!body[p + 36] };
    });
    assert(body.subarray(24 + count * 40).equals(Buffer.alloc((6 - count) * 40)), 'unused rows zero');
    return { status, next, now, rows };
}
async function ask(peer, payload) { peer.send(T_REQUEST, payload); return parse(await peer.frame(T_REPLY)); }
async function boot(state, {upstreamPort, slowRenameMs = 0} = {}) {
    let command = path.join(__dirname, 'server.js');
    if (upstreamPort || slowRenameMs) {
        const gateway = path.join(__dirname, 'upstream-gateway.js');
        const target = command; command = path.join(state, 'fixture-wrapper.cjs');
        const upstream = upstreamPort ? `const g=require(${JSON.stringify(gateway)});g.PUBLIC_PROVIDERS=[{id:'lanywhere-public',host:'127.0.0.1',port:${upstreamPort},maxConnections:8,connectTimeoutMs:3000,adapterMetadata:true,localTransport:true}];` : '';
        const delay = slowRenameMs ? `const fs=require('node:fs');const rename=fs.promises.rename;fs.promises.rename=async (...a)=>{if(a[1].endsWith('/appointments.json'))await new Promise(r=>setTimeout(r,${slowRenameMs}));return rename(...a);};` : '';
        await fs.writeFile(command, `${upstream}${delay}require(${JSON.stringify(target)});`);
    }
    const child = spawn(process.execPath, [command, '--port', '0'], {
        env: { ...process.env, LANYWHERE_STATE_DIR: state, LANYWHERE_STATS_PORT: '0',
            LANYWHERE_PUBLIC_PORT: '0', LANYWHERE_LANPLAY_PORT: '0', LANYWHERE_OPS_PORT: '0',
            LANYWHERE_SHUTDOWN_GRACE_MS: '0', LANYWHERE_ENABLE_PUBLIC_UPSTREAM: upstreamPort ? '1' : '0',
            LANYWHERE_ENABLE_LANPLAY_UPSTREAM: '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = ''; child.stdout.on('data', b => logs += b); child.stderr.on('data', b => logs += b);
    const port = await until(() => {
        if (child.exitCode !== null) throw Error(`test relay exited: ${logs}`);
        return Number(/datos UDP en (\d+)/.exec(logs)?.[1]) || null;
    }, 'appointment relay ready');
    async function stop() {
        if (child.exitCode === null && child.signalCode === null) {
            const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
        }
    }
    return { port, stop };
}
async function peer(port) {
    const p = new ConsolePeer('anonymous-fixture', port); await p.open({udp: false}); return p;
}
async function fakeLegacy(t) {
    let forwarded = 0; const sockets = new Set();
    const server = net.createServer(s => {
        sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => {});
        let pending = Buffer.alloc(0);
        s.on('data', bytes => {
            pending = Buffer.concat([pending, bytes]);
            while (pending.length >= 3 && pending.length >= pending.readUInt16LE() + 2) {
                const n = pending.readUInt16LE(), type = pending[2]; pending = pending.subarray(n + 2);
                if (type === T_REQUEST) forwarded++;
                if (type === 0x0b) s.write(Buffer.from([2, 0, 0x85, 4])); // legacy capability fallback
                if (type === 5) s.write(Buffer.from([1, 0, 0x86]));
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { for (const s of sockets) s.destroy(); await new Promise(resolve => server.close(resolve)); });
    return { port: server.address().port, forwarded: () => forwarded };
}

test('appointment wire contract: dedupe, ready leases, pagination and restart', {timeout: 20000}, async t => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'lanywhere-appointment-e2e-'));
    let server; const clients = [];
    t.after(async () => { for (const p of clients) p.close(); if (server) await server.stop(); await fs.rm(state, {recursive: true, force: true}); });
    server = await boot(state); const p = await peer(server.port); clients.push(p);
    let page = await ask(p, request(1, ID_A)); assert.equal(page.status, 0); assert.equal(page.rows.length, 0); assert.equal(page.next, 0xffffffff);
    const start = BigInt(Math.floor(Date.now() / 1000) + 600);
    page = await ask(p, request(2, ID_A, {start, game: GAME, app: APP}));
    assert.equal(page.status, 0); assert.equal(page.rows.length, 1);
    const first = page.rows[0]; assert(first.id > 0n); assert.equal(first.game, GAME); assert.equal(first.app, APP); assert.equal(first.start, start);
    assert.equal(first.interested, 0); assert.equal(first.followed, false, 'creation does not set ready');
    page = await ask(p, request(2, ID_B, {start, game: GAME, app: APP}));
    assert.equal(page.status, 0); assert.equal(page.rows.length, 1); assert.equal(page.rows[0].id, first.id);
    assert.equal(page.rows[0].interested, 0); assert.equal(page.rows[0].followed, false);
    // Ready count is not capped at the capacity of one live room.
    for (let i = 3; i < 12; i++) {
        page = await ask(p, request(3, Buffer.alloc(16, i), {id: first.id})); assert.equal(page.status, 0);
    }
    page = await ask(p, request(3, ID_A, {id: first.id})); assert.equal(page.rows[0].interested, 10);
    page = await ask(p, request(3, ID_A, {id: first.id})); assert.equal(page.rows[0].interested, 10);
    page = await ask(p, request(3, ID_B, {id: first.id})); assert.equal(page.rows[0].interested, 11);
    page = await ask(p, request(4, ID_B, {id: first.id})); assert.equal(page.rows[0].interested, 10); assert.equal(page.rows[0].followed, false);
    page = await ask(p, request(4, ID_B, {id: first.id})); assert.equal(page.rows[0].interested, 10);
    // Distinct titles can legitimately share an LCID and schedule time.
    page = await ask(p, request(2, ID_B, {start, game: GAME, app: APP + 1n}));
    assert.equal(page.status, 0); assert.equal(page.rows.length, 2);
    const otherTitle = page.rows.find(row => row.app === APP + 1n);
    assert(otherTitle && otherTitle.id !== first.id);
    assert.equal(otherTitle.followed, false); assert.equal(otherTitle.interested, 0);
    page = await ask(p, request(3, ID_B, {id: otherTitle.id}));
    assert.equal(page.rows[0].id, otherTitle.id, 'ready appointment precedes the others');
    assert.equal(page.rows[0].followed, true); assert.equal(page.rows[0].interested, 1);
    page = await ask(p, request(3, ID_A, {id: otherTitle.id}));
    assert.equal(page.rows[0].id, otherTitle.id); assert.equal(page.rows[0].interested, 2);
    assert.equal(page.rows.find(x => x.id === first.id).interested, 9, 'switching ready removes prior lease');
    page = await ask(p, request(3, ID_A, {id: first.id}));
    assert.equal(page.rows[0].id, first.id); assert.equal(page.rows[0].interested, 10);
    assert.equal(page.rows.find(x => x.id === otherTitle.id).interested, 1);
    for (let i = 1; i < 12; i++) {
        page = await ask(p, request(2, ID_A, {start: start + BigInt(i * 60), game: GAME + BigInt(i), app: APP}));
        assert.equal(page.status, 0); // every mutation returns offset-zero first page
    }
    page = await ask(p, request(1, ID_A));
    const otherGame = page.rows.find(x => x.game === GAME + 1n);
    assert(otherGame);
    page = await ask(p, request(3, ID_A, {id: otherGame.id}));
    assert.equal(page.rows[0].id, otherGame.id); assert.equal(page.rows[0].interested, 1);
    assert.equal(page.rows.find(x => x.id === first.id).interested, 9, 'ready switch works across LCIDs');
    page = await ask(p, request(4, ID_A, {id: first.id}));
    assert.equal(page.rows[0].id, otherGame.id); assert(page.rows[0].followed, 'cancel non-current is idempotent');
    page = await ask(p, request(3, ID_A, {id: first.id}));
    assert.equal(page.rows[0].id, first.id); assert.equal(page.rows[0].interested, 10);
    const all = [], pages = []; let offset = 0;
    while (offset !== 0xffffffff) {
        page = await ask(p, request(1, ID_A, {offset})); assert.equal(page.status, 0);
        pages.push(page.rows.length); all.push(...page.rows); offset = page.next;
        assert(pages.length <= 3);
    }
    assert.deepEqual(pages, [6, 6, 1]); assert.equal(new Set(all.map(x => x.id.toString())).size, 13);
    assert.equal(all[0].id, first.id); assert(all[0].followed);
    assert(all.slice(1).every(x => !x.followed), 'only one ready per device across pages');
    const starts = all.slice(1).map(x => x.start);
    assert.deepEqual(starts, [...starts].sort((a,b) => a < b ? -1 : a > b ? 1 : 0));
    const disk = await fs.readFile(path.join(state, 'appointments.json'), 'utf8');
    for (const id of [ID_A, ID_B, ...Array.from({length: 9}, (_, i) => Buffer.alloc(16, i + 3))])
        assert(!disk.includes(id.toString('hex')), 'anonymous ready identifiers are never persisted');
    p.close(); await server.stop(); server = await boot(state);
    const after = await peer(server.port); clients.push(after);
    page = await ask(after, request(1, ID_A)); assert.equal(page.status, 0); assert.equal(page.rows.length, 6);
    assert.equal(page.rows.find(row => row.id === first.id)?.interested, 0);
    assert(page.rows.every(row => !row.followed && row.interested === 0));
    page = await ask(after, request(1, ID_B));
    assert.equal(page.rows.find(row => row.id === otherTitle.id)?.interested, 0);
    assert(page.rows.every(row => !row.followed));
});

test('malformed requests and invalid appointment ranges return bounded fixed replies', {timeout: 12000}, async t => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'lanywhere-appointment-bad-'));
    const server = await boot(state); const p = await peer(server.port);
    t.after(async () => { p.close(); await server.stop(); await fs.rm(state, {recursive: true, force: true}); });
    const start = BigInt(Math.floor(Date.now() / 1000));
    const cases = [
        Buffer.alloc(55), request(0, ID_A), request(1, Buffer.alloc(16)),
        request(2, ID_A, {start: start - 3n * 3600n, game: GAME, app: APP}),
        request(2, ID_A, {start: start + 8n * 86400n, game: GAME, app: APP}),
    ];
    const reserved = request(1, ID_A); reserved[1] = 1; cases.push(reserved);
    for (const invalid of cases) assert.equal((await ask(p, invalid)).status, 2);
    assert.equal((await ask(p, request(3, ID_A, {id: 0xffffffffffffffffn}))).status, 4);
    assert.equal((await ask(p, request(1, ID_A))).rows.length, 0);
    const future = await ask(p, request(2, ID_A, {start: start + 3600n, game: GAME, app: APP}));
    assert.equal(future.status, 0); assert.equal(future.rows[0].interested, 0);
    assert.equal((await ask(p, request(3, ID_A, {id: future.rows[0].id}))).status, 2, 'ready is rejected before start−30min');
});

test('external provider returns unavailable without forwarding appointment data', {timeout: 12000}, async t => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'lanywhere-appointment-external-'));
    const upstream = await fakeLegacy(t), server = await boot(state, {upstreamPort: upstream.port});
    const p = await peer(server.port);
    t.after(async () => { p.close(); await server.stop(); await fs.rm(state, {recursive: true, force: true}); });
    p.send(0x20, Buffer.from('lanywhere-public')); const selected = await p.frame(0xa0); assert.equal(selected.readUInt32LE(0), 64);
    const result = await ask(p, request(1, ID_A)); assert.equal(result.status, 1); assert.equal(result.rows.length, 0);
    assert.equal(upstream.forwarded(), 0, 'anonymous appointment data stays on self');
});

test('offline appointment creator does not prevent multiple same-game rooms being discovered and joined', {timeout: 12000}, async t => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'lanywhere-appointment-rooms-'));
    const server = await boot(state), clients = [];
    t.after(async () => { for (const p of clients) p.close(); await server.stop(); await fs.rm(state, {recursive: true, force: true}); });
    const creator = await peer(server.port); clients.push(creator);
    const start = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const created = await ask(creator, request(2, ID_A, {start, game: GAME, app: APP}));
    assert.equal(created.status, 0); assert.equal(created.rows.length, 1);
    const appointmentId = created.rows[0].id;
    creator.close(); // no game room or creator session remains

    const [hostB, hostC, unrelated, finder] = await Promise.all(
        Array.from({length: 4}, async () => { const p = await peer(server.port); clients.push(p); return p; }));
    const otherGame = GAME + 1n;
    for (const [host, game] of [[hostB, GAME], [hostC, GAME], [unrelated, otherGame]]) {
        await host.create(game);
        await host.publish(networkInfo([host], 8, game));
    }
    assert.notEqual(hostB.code, hostC.code);

    // A fresh anonymous installation can still see the persisted appointment.
    const listing = await ask(finder, request(1, ID_B));
    assert.equal(listing.status, 0); assert.equal(listing.rows[0].id, appointmentId);
    assert.equal(listing.rows[0].game, GAME); assert.equal(listing.rows[0].followed, false);
    const matching = await finder.find(GAME);
    assert.deepEqual(new Set(matching.map(r => r.code)), new Set([hostB.code, hostC.code]));
    assert(!matching.some(r => r.code === unrelated.code));
    assert.equal(await finder.join(hostC.code, {game: GAME}), 2);
    assert.equal(finder.code, hostC.code);
    assert.equal((await ask(finder, request(1, ID_B))).rows[0].id, appointmentId);
});

test('slow appointment commit leaves relay PING responsive and reports only committed data', {timeout: 12000}, async t => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'lanywhere-appointment-slow-'));
    const server = await boot(state, {slowRenameMs: 700}); const writer = await peer(server.port), reader = await peer(server.port);
    t.after(async () => { writer.close(); reader.close(); await server.stop(); await fs.rm(state, {recursive: true, force: true}); });
    const start = BigInt(Math.floor(Date.now() / 1000) + 3600);
    writer.send(T_REQUEST, request(2, ID_A, {start, game: GAME, app: APP}));
    // TCP ordering ensures the server receives the mutation before this ping.
    writer.send(5); await writer.frame(0x86);
    assert(!writer.frames.some(x => x.type === T_REPLY), 'commit response must wait for durable rename');
    const pending = await ask(reader, request(1, ID_A)); assert.equal(pending.rows.length, 0, 'read sees last committed snapshot');
    const done = parse(await writer.frame(T_REPLY)); assert.equal(done.status, 0); assert.equal(done.rows.length, 1);
    const after = await ask(reader, request(1, ID_A)); assert.equal(after.rows.length, 1);
});
