'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ConsolePeer, networkInfo, u64, until } = require('./test-public-e2e');

const GAME = 0x0100000000abc000n, END = 0xffffffff;
const UNIFIED = 0x28, UNIFIED_REPLY = 0xa8, CAPABILITY = 2048;
const METADATA_BYTES = 336, UNIFIED_BYTES = 376;
const SHARED_CODE = 'ABC234';

function frame(socket, type, body) {
    const head = Buffer.alloc(3);
    head.writeUInt16LE(body.length + 1);
    head[2] = type;
    socket.write(Buffer.concat([head, body]));
}

function row(code, label) {
    const data = Buffer.alloc(METADATA_BYTES);
    data.write(code, 0, 6, 'ascii');
    data.writeBigUInt64LE(GAME, 8);
    data[32] = 1;
    data[33] = 4;
    data[34] = 1;
    data[35] = 2; // External mode claims must not leak into the self-only feature.
    data.write(label, 40);
    data.write(label, 80);
    return data;
}

async function upstream(t, metadata, rows) {
    const sockets = new Set(), hold = [];
    const state = { held: true, bad: false, connections: 0, finds: 0, joins: 0, incoming: [] };
    const server = net.createServer(socket => {
        state.connections++;
        sockets.add(socket);
        socket.on('error', () => {});
        socket.on('close', () => sockets.delete(socket));
        let pending = Buffer.alloc(0);
        socket.on('data', bytes => {
            pending = Buffer.concat([pending, bytes]);
            while (pending.length >= 3 && pending.length >= pending.readUInt16LE() + 2) {
                const length = pending.readUInt16LE(), type = pending[2], body = pending.subarray(3, length + 2);
                pending = pending.subarray(length + 2);
                state.incoming.push(type);
                if (type === 0x0b) {
                    const caps = Buffer.alloc(4);
                    caps.writeUInt32LE(CAPABILITY | (metadata ? 64 : 0));
                    frame(socket, 0x89, caps);
                } else if (type === 0x22 || type === 8) {
                    assert.equal(type, metadata ? 0x22 : 8);
                    state.finds++;
                    const answer = () => {
                        if (socket.destroyed) return;
                        if (state.bad) return frame(socket, metadata ? 0xa2 : 0x87, Buffer.from([1]));
                        if (metadata) {
                            const offset = body.readUInt32LE(8), page = rows.slice(offset, offset + 6), head = Buffer.alloc(5);
                            head.writeUInt32LE(offset + page.length < rows.length ? offset + page.length : END);
                            head[4] = page.length;
                            return frame(socket, 0xa2, Buffer.concat([head, ...page]));
                        }
                        const groups = rows.map(data => Buffer.concat([data.subarray(0, 6),
                            networkInfo([{ ip: 0x0a0d1234 }], 4)]));
                        frame(socket, 0x87, Buffer.concat([Buffer.from([groups.length]), ...groups]));
                    };
                    if (state.held) hold.push(answer);
                    else answer();
                } else if (type === 2) {
                    state.joins++;
                    assert.equal(body.subarray(0, 6).toString(), SHARED_CODE);
                    const room = Buffer.alloc(61);
                    body.copy(room, 0, 0, 6);
                    room[6] = 1;
                    room.writeUInt32LE(0x0a0d6543, 7);
                    room.writeUInt32LE(12345, 11);
                    room.writeBigUInt64LE(GAME, 15);
                    room[23] = 1;
                    room[24] = 1;
                    room.writeUInt32LE(0x0a0d6543, 25);
                    frame(socket, 0x81, room);
                } else if (type === 5) frame(socket, 0x86, Buffer.alloc(0));
                else assert.fail('unexpected upstream command ' + type);
            }
        });
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => server.close(resolve));
    });
    return {
        port: server.address().port, state,
        release: () => { state.held = false; for (const send of hold.splice(0)) send(); },
    };
}

async function launch(t, providers) {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'lanywhere-unified-'));
    const bootstrap = path.join(state, 'bootstrap.cjs');
    await fs.writeFile(bootstrap, `const gateway = require(${JSON.stringify(path.join(__dirname, 'upstream-gateway.js'))});
gateway.PUBLIC_PROVIDERS = ${JSON.stringify(providers)};
const lobby = require(${JSON.stringify(path.join(__dirname, 'unified-lobby.js'))}), create = lobby.create;
let jump = 0;
process.on('SIGALRM', () => jump += 26000);
lobby.create = options => create({ ...options, now: () => performance.now() + jump });
require(${JSON.stringify(path.join(__dirname, 'server.js'))});`);
    const server = spawn(process.execPath, [bootstrap, '--port', '0'], {
        env: { ...process.env, LANYWHERE_STATE_DIR: state, LANYWHERE_STATS_PORT: '0', LANYWHERE_PUBLIC_PORT: '0',
            LANYWHERE_OPS_PORT: '0', LANYWHERE_LANPLAY_PORT: '0', LANYWHERE_SHUTDOWN_GRACE_MS: '0',
            LANYWHERE_ENABLE_PUBLIC_UPSTREAM: '1', LANYWHERE_ENABLE_LANPLAY_UPSTREAM: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [server.stdout, server.stderr]) stream.on('data', bytes => { output += bytes; });
    const peers = [], exited = once(server, 'exit');
    t.after(async () => {
        for (const peer of peers) peer.close();
        server.kill('SIGTERM');
        await exited;
        await fs.rm(state, { recursive: true, force: true });
    });
    const port = await until(() => {
        if (server.exitCode !== null) throw Error(output);
        return Number(/datos UDP en (\d+)/.exec(output)?.[1]) || null;
    }, 'unified lobby relay ready');
    async function peer(name) {
        const client = new ConsolePeer(name, port);
        peers.push(client);
        await client.open({ udp: false });
        return client;
    }
    return { peer, jump: () => server.kill('SIGALRM'), output: () => output };
}

async function page(peer, offset = 0, snapshot = 0) {
    const request = Buffer.alloc(8);
    request.writeUInt32LE(offset);
    request.writeUInt32LE(snapshot, 4);
    peer.send(UNIFIED, request);
    const packet = await peer.receive(peer.frames, entry => [UNIFIED_REPLY, 0x85].includes(entry.type), 'unified page');
    assert.equal(packet.type, UNIFIED_REPLY, `unified page error: ${packet.body.toString()}`);
    const reply = packet.body;
    const count = reply[8], available = reply[9], total = reply[10], status = reply[11];
    assert(count <= 6 && available <= total && status <= 1);
    assert.equal(reply.length, 12 + count * UNIFIED_BYTES);
    const rows = [];
    for (let i = 0; i < count; i++) {
        const data = reply.subarray(12 + i * UNIFIED_BYTES, 12 + (i + 1) * UNIFIED_BYTES);
        assert(data.subarray(369).every(byte => byte === 0));
        const end = data.indexOf(0, METADATA_BYTES);
        assert(end > METADATA_BYTES && end <= 368);
        rows.push({ code: data.toString('ascii', 0, 6), game: data.readBigUInt64LE(8), count: data[32], max: data[33],
            access: data[35], provider: data.toString('ascii', METADATA_BYTES, end) });
    }
    return { snapshot: reply.readUInt32LE(), next: reply.readUInt32LE(4), available, total, status, rows };
}

test('shared cold/warm unified generations preserve provider identity, stable paging, partial failures and legacy routing', {timeout: 15000}, async t => {
    const pagedRows = [row(SHARED_CODE, 'Metadata twin'),
        ...['ACD234', 'ACE234', 'ACF234', 'ACG234', 'ACH234', 'ACJ234'].map(code => row(code, code))];
    const modern = await upstream(t, true, pagedRows);
    const legacy = await upstream(t, false, [row(SHARED_CODE, 'Legacy twin'), row('BCF234', 'Legacy two')]);
    const service = await launch(t, [
        { id: 'up-modern', host: '127.0.0.1', port: modern.port, capabilities: CAPABILITY | 64, maxConnections: 4 },
        { id: 'up-legacy', host: '127.0.0.1', port: legacy.port, capabilities: CAPABILITY, maxConnections: 4 },
    ]);
    const host = await service.peer('Own room'), browser = await service.peer('Browser');
    const peer = await service.peer('Second browser');
    await host.create();
    await host.publish(networkInfo([host], 1));
    const hidden = Buffer.alloc(48);
    hidden.write(host.code, 0, 6, 'ascii');
    hidden[6] = 3;
    hidden[7] = 4;
    hidden.writeUInt32LE(host.token, 8);
    hidden.writeBigUInt64LE(GAME, 16);
    hidden.write('0192', 24);
    host.send(0x27, hidden);
    assert.equal((await host.frame(0xa7)).readUInt32LE(), 0);

    browser.send(0x0b);
    assert((await browser.frame(0x89)).readUInt32LE() & CAPABILITY);
    const cold = await page(browser);
    assert(cold.snapshot);
    assert.deepEqual(cold, {
        snapshot: cold.snapshot, next: END, available: 1, total: 3, status: 0,
        rows: [{ code: host.code, game: GAME, count: 1, max: 1, access: 2, provider: 'self' }],
    });
    await Promise.all([page(browser), page(peer)]);
    await until(() => modern.state.finds === 1 && legacy.state.finds === 1, 'single discovery cycle');
    assert.equal(modern.state.connections, 1);
    assert.equal(legacy.state.connections, 1);

    modern.release();
    const partial = await until(async () => {
        const result = await page(browser);
        return result.available === 2 ? result : null;
    }, 'incremental source availability');
    assert.notEqual(partial.snapshot, cold.snapshot);
    assert.equal(partial.next, 6);
    assert.equal(modern.state.finds, 2);
    assert.deepEqual(await page(peer, 0, cold.snapshot), cold);

    legacy.release();
    const warm = await until(async () => {
        const result = await page(browser);
        return result.available === 3 ? result : null;
    }, 'both sources warm');
    const last = await page(browser, warm.next, warm.snapshot);
    assert.equal(last.next, END);
    assert.equal(last.snapshot, warm.snapshot);
    const all = [...warm.rows, ...last.rows];
    assert.equal(all.length, 10);
    assert.deepEqual(all.filter(r => r.code === SHARED_CODE).map(r => [r.provider, r.game, r.access]),
        [['up-legacy', GAME, 0], ['up-modern', GAME, 0]]);
    assert.equal((await page(peer)).snapshot, warm.snapshot);
    assert.equal(legacy.state.finds, 1);
    assert.deepEqual(await browser.find(GAME), [], 'ordinary game discovery does not reveal own full/locked room');

    const target = all.find(room => room.code === SHARED_CODE && room.provider === 'up-legacy');
    const joiner = await service.peer('Legacy joiner');
    joiner.send(0x20, Buffer.from(target.provider));
    assert.equal((await joiner.frame(0xa0)).readUInt32LE() & CAPABILITY, 0);
    joiner.send(UNIFIED, Buffer.alloc(8));
    assert.equal((await joiner.frame(0x85))[0], 4);
    await joiner.join(target.code, { game: target.game });
    assert.equal(legacy.state.joins, 1);
    assert.equal(modern.state.joins, 0);
    assert(!legacy.state.incoming.includes(UNIFIED));

    legacy.state.bad = true;
    service.jump();
    const degraded = await until(async () => {
        const result = await page(browser);
        return result.available === 2 ? result : null;
    }, 'failed source removed on warm refresh').catch(error => {
        throw new Error(`${error.message}; modern=${modern.state.finds} legacy=${legacy.state.finds} logs=${service.output()}`);
    });
    const degradedTail = await page(browser, degraded.next, degraded.snapshot);
    assert([...degraded.rows, ...degradedTail.rows].every(room => room.provider !== 'up-legacy'));
    assert.equal((await page(peer, 0, warm.snapshot)).available, 3, 'paging a retained generation is immutable');
    service.jump();
    const stale = await until(async () => {
        const result = await page(peer, 0, warm.snapshot);
        return result.status === 1 ? result : null;
    }, 'expired snapshot');
    assert.deepEqual(stale.rows, []);
});
