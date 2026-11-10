'use strict';
// Real parent relay, loopback only. The external provider is a synthetic local
// control endpoint and never contacts LAN Play or the public Internet.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ConsolePeer, networkInfo, u64, until } = require('./test-public-e2e');

const T_REQUEST = 0x26, T_REPLY = 0xa6, T_SUBSCRIBE = 0x29, T_PUSH = 0xa9;
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
async function boot(state, {upstreamPort, slowRenameMs = 0, clockFile} = {}) {
    let command = path.join(__dirname, 'server.js');
    if (upstreamPort || slowRenameMs || clockFile) {
        const gateway = path.join(__dirname, 'upstream-gateway.js');
        const target = command; command = path.join(state, 'fixture-wrapper.cjs');
        const upstream = upstreamPort ? `const g=require(${JSON.stringify(gateway)});g.PUBLIC_PROVIDERS=[{id:'lanywhere-public',host:'127.0.0.1',port:${upstreamPort},maxConnections:8,connectTimeoutMs:3000,capabilities:4096,adapterMetadata:true,localTransport:true}];` : '';
        const delay = slowRenameMs ? `const fs=require('node:fs');const rename=fs.promises.rename;fs.promises.rename=async (...a)=>{if(a[1].endsWith('/appointments.json'))await new Promise(r=>setTimeout(r,${slowRenameMs}));return rename(...a);};` : '';
        const clock = clockFile ? `Date.now=()=>Number(require('node:fs').readFileSync(${JSON.stringify(clockFile)},'utf8'))*1000;` : '';
        await fs.writeFile(command, `${upstream}${delay}${clock}require(${JSON.stringify(target)});`);
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
                if (type === T_REQUEST || type === T_SUBSCRIBE) forwarded++;
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
    p.send(T_SUBSCRIBE, subscription([]));
    assert.equal((await p.frame(0x85))[0], 4, 'external routes cannot subscribe');
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

function subscription(ids) {
    const body = Buffer.alloc(208);
    body.writeUInt32LE(ids.length);
    ids.forEach((id, i) => body.writeBigUInt64LE(id, 8 + i * 8));
    return body;
}

function pushFrame(body) {
    assert.equal(body.length, 360);
    return {
        time: body.readBigUInt64LE(0), event: body.readBigUInt64LE(8), delivery: body.readBigUInt64LE(16),
        room: body.toString('ascii', 24, 30), game: body.readBigUInt64LE(32), app: body.readBigUInt64LE(40),
        players: body[56], capacity: body[57], row: body.subarray(24),
    };
}

async function subscribe(client, ids) {
    client.send(T_SUBSCRIBE, subscription(ids));
    const ack = pushFrame(await client.frame(T_PUSH));
    assert(ack.time > 1_500_000_000n);
    assert.equal(ack.event | ack.delivery, 0n);
    assert(!ack.row.some(Boolean));
    return ack;
}

async function nextPush(client, event, host) {
    const result = pushFrame(await client.frame(T_PUSH));
    assert.equal(result.event, event);
    assert.equal(result.room, host.code);
    assert.equal(result.game, GAME);
    assert(result.delivery > 0n);
    return result;
}

async function noPush(client, message) {
    await client.barrier();
    assert(!client.frames.some(frame => frame.type === T_PUSH), message);
}

async function updatePassword(host, hidden) {
    const body = Buffer.alloc(48);
    body.write(host.code, 0, 6, 'ascii');
    body[6] = hidden ? 3 : 2;
    body[7] = hidden ? 1 : 0;
    body.writeUInt32LE(host.token, 8);
    body.writeBigUInt64LE(GAME, 16);
    if (hidden) body[24] = 0x31;
    host.send(0x27, body);
    assert.equal((await host.frame(0xa7))[0], 0);
}

async function announceApp(host, app) {
    const metadata = Buffer.alloc(272);
    metadata.writeBigUInt64LE(app, 8);
    host.send(0x21, metadata);
    await host.barrier();
}

test('appointment push binds a real host to one event and reports each open-room generation once', {timeout: 16000}, async t => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'lanywhere-appointment-push-'));
    const server = await boot(state), clients = [];
    t.after(async () => { for (const p of clients) p.close(); await server.stop(); await fs.rm(state, {recursive: true, force: true}); });
    async function open() { const p = await peer(server.port); clients.push(p); return p; }
    const [scheduler, watcher, sameGame, wrongApp, host, guest] = await Promise.all(Array.from({length: 6}, open));
    scheduler.send(0x0b);
    assert((await scheduler.frame(0x89)).readUInt32LE() & 4096);
    const start = BigInt(Math.floor(Date.now() / 1000) + 60);
    const first = (await ask(scheduler, request(2, ID_A, {start, game: GAME, app: APP}))).rows[0];
    const other = (await ask(scheduler, request(2, ID_A, {start: start + 1n, game: GAME, app: APP}))).rows
        .find(row => row.start === start + 1n);
    const mismatch = (await ask(scheduler, request(2, ID_A, {start, game: GAME, app: APP + 1n}))).rows
        .find(row => row.app === APP + 1n);
    assert(first && other && mismatch);

    // The dedicated socket can keep itself alive and replace subscriptions, but cannot create a room.
    await subscribe(watcher, [other.id, first.id]);
    watcher.send(1, u64(GAME), watcher.nickname());
    assert.equal((await watcher.frame(0x85))[0], 4);
    await subscribe(sameGame, [other.id]);
    await subscribe(wrongApp, [mismatch.id]);

    await host.create(GAME);
    await announceApp(host, APP);
    await host.publish(Buffer.concat([networkInfo([host], 2, GAME), u64(first.id)]));
    const initial = await nextPush(watcher, first.id, host);
    assert.equal(initial.app, APP);
    assert.equal(initial.players, 1);
    assert.equal(initial.capacity, 2);
    await noPush(sameGame, 'bound room is not offered to another event with the same game');
    await noPush(wrongApp, 'known app metadata excludes other titles sharing the LCID');
    await subscribe(watcher, [first.id, other.id]);
    await noPush(watcher, 'subscription replacement does not duplicate an already delivered room');

    const disconnected = once(watcher.tcp, 'close');
    watcher.close();
    await disconnected;
    const reconnected = await open();
    await subscribe(reconnected, [first.id, other.id]);
    assert.equal((await nextPush(reconnected, first.id, host)).delivery, initial.delivery);

    // Occupancy publications, including the unextended legacy form, preserve the binding.
    await host.publish(networkInfo([host], 2, GAME));
    await host.publish(Buffer.concat([networkInfo([host], 2, GAME), u64(0n)]));
    await noPush(reconnected, 'same-session occupancy update does not reopen delivery');
    await subscribe(sameGame, [other.id]);
    await noPush(sameGame, 'same-session legacy and zero-suffix publications preserve the binding');
    assert.equal(await guest.join(host.code, {game: GAME}), 2);
    guest.send(3);
    await host.frame(0x83);
    const reopened = await nextPush(reconnected, first.id, host);
    assert.notEqual(reopened.delivery, initial.delivery, 'new space has a new delivery ID');

    await updatePassword(host, true);
    await subscribe(reconnected, [first.id, other.id]);
    await noPush(reconnected, 'private rooms are excluded');
    await updatePassword(host, false);
    const unlocked = await nextPush(reconnected, first.id, host);
    assert.notEqual(unlocked.delivery, reopened.delivery);

    const reservation = Buffer.alloc(122);
    reservation.fill(0x42, 0, 16);
    reservation.writeBigUInt64LE(GAME, 16);
    reservation.writeUInt32LE(1, 108);
    reservation[115] = 1;
    reservation.write(host.code, 116, 'ascii');
    guest.send(9, reservation);
    assert.equal((await guest.frame(0x88))[0], 1, 'reservation held the only available space');
    guest.send(10, reservation.subarray(0, 16));
    assert.equal((await guest.frame(0x88))[0], 2);
    const released = await nextPush(reconnected, first.id, host);
    assert.notEqual(released.delivery, unlocked.delivery, 'releasing a reservation opens a new delivery');

    const nextSession = networkInfo([host], 2, GAME);
    nextSession[16] = 1;
    // A confirmed host with different app metadata can still publish normally.
    await host.publish(Buffer.concat([nextSession, u64(mismatch.id)]));
    const a = await nextPush(reconnected, first.id, host), b = await nextPush(sameGame, other.id, host);
    assert.equal(a.delivery, b.delivery, 'unbound same-game fallback shares one stable room delivery');
    assert.notEqual(a.delivery, released.delivery, 'new session resets its delivery and binding');
    await noPush(wrongApp, 'ignored invalid binding cannot notify a wrong app');
    await noPush(reconnected, 'multiple matching events do not duplicate one room on the same socket');

    // The metadata hint can change which events match without opening a new room.
    await announceApp(host, APP + 1n);
    const newlyMatched = await nextPush(wrongApp, mismatch.id, host);
    assert.equal(newlyMatched.delivery, a.delivery);
    await announceApp(host, APP);
    await noPush(reconnected, 'metadata updates cannot duplicate a delivery to an already notified subscriber');
});

test('appointment push opens the authoritative alert window and stops at the expiry boundary', {timeout: 10000}, async t => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'lanywhere-appointment-window-'));
    const clockFile = path.join(state, 'clock');
    const initial = BigInt(Math.floor(Date.now() / 1000));
    async function setClock(time) {
        await fs.writeFile(clockFile + '.next', time.toString());
        await fs.rename(clockFile + '.next', clockFile);
    }
    await setClock(initial);
    const server = await boot(state, {clockFile}), clients = [];
    t.after(async () => { for (const p of clients) p.close(); await server.stop(); await fs.rm(state, {recursive: true, force: true}); });
    async function open() { const p = await peer(server.port); clients.push(p); return p; }
    const [scheduler, watcher, host] = await Promise.all([open(), open(), open()]);
    const start = initial + 1801n;
    const event = (await ask(scheduler, request(2, ID_A, {start, game: GAME, app: APP}))).rows[0];
    await host.create(GAME);
    await host.publish(networkInfo([host], 3, GAME));
    assert.equal((await subscribe(watcher, [event.id])).time, initial);
    await noPush(watcher, 'initial snapshot excludes a room for an appointment before the alert window');

    await setClock(start - 1800n);
    const opened = await nextPush(watcher, event.id, host);
    assert.equal(opened.time, start - 1800n, 'push opens at server time without client polling');
    await setClock(start + 7199n);
    const reconnect = await open();
    assert.equal((await subscribe(reconnect, [event.id])).time, start + 7199n);
    assert.equal((await nextPush(reconnect, event.id, host)).delivery, opened.delivery, 'reconnect snapshot uses existing delivery');
    await setClock(start + 7200n);
    assert.equal((await subscribe(reconnect, [event.id])).time, start + 7200n);
    const fresh = await open();
    await subscribe(fresh, [event.id]);
    await noPush(fresh, 'initial snapshot excludes the expired appointment');
    await host.publish();
    await host.publish(networkInfo([host], 3, GAME));
    await delay(100);
    await noPush(watcher, 'room reopen cannot push an expired appointment');
    assert.deepEqual((await ask(scheduler, request(1, ID_A))).rows, []);
});

test('appointment push validates the fixed payload and bounds dedicated sockets per IP', {timeout: 10000}, async t => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'lanywhere-appointment-push-bound-'));
    const server = await boot(state), clients = [];
    t.after(async () => { for (const p of clients) p.close(); await server.stop(); await fs.rm(state, {recursive: true, force: true}); });
    async function open() { const p = await peer(server.port); clients.push(p); return p; }
    const bad = await open();
    const padding = subscription([1n]); padding[24] = 1;
    const reserved = subscription([]); reserved[4] = 1;
    for (const body of [Buffer.alloc(200), subscription([0n]), subscription([1n, 1n]), padding, reserved]) {
        bad.send(T_SUBSCRIBE, body);
        assert.equal((await bad.frame(0x85))[0], 4);
    }
    // The 25th slot permits an independent Ready appointment in addition to the 24 joined ones.
    await subscribe(bad, Array.from({length: 25}, (_, i) => BigInt(i + 1)));
    for (let i = 0; i < 3; i++) await subscribe(await open(), []);
    const extra = await open();
    extra.send(T_SUBSCRIBE, subscription([]));
    assert.equal((await extra.frame(0x85))[0], 7);
    const disconnected = once(bad.tcp, 'close');
    bad.tcp.end();
    await disconnected;
    await subscribe(extra, []);
});
