'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ConsolePeer, networkInfo, until } = require('./test-public-e2e');
const regional = require('./regional-directory');

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

async function launch(t, providers, { eu } = {}) {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'lanywhere-unified-'));
    const bootstrap = path.join(state, 'bootstrap.cjs');
    await fs.writeFile(bootstrap, `const gateway = require(${JSON.stringify(path.join(__dirname, 'upstream-gateway.js'))});
gateway.PUBLIC_PROVIDERS = ${JSON.stringify(providers)};
const lobby = require(${JSON.stringify(path.join(__dirname, 'unified-lobby.js'))}), create = lobby.create;
let jump = 0;
process.on('SIGALRM', () => jump += 26000);
lobby.create = options => create({ ...options, now: () => performance.now() + jump });
require(${JSON.stringify(path.join(__dirname, 'server.js'))});`);
    const environment = { ...process.env };
    delete environment.LANYWHERE_EU_RELAY;
    const server = spawn(process.execPath, [bootstrap, '--port', '0'], {
        env: { ...environment, ...(eu ? { LANYWHERE_EU_RELAY: eu } : {}),
            LANYWHERE_STATE_DIR: state, LANYWHERE_STATS_PORT: '0', LANYWHERE_PUBLIC_PORT: '0',
            LANYWHERE_OPS_PORT: '0', LANYWHERE_LANPLAY_PORT: '0', LANYWHERE_SHUTDOWN_GRACE_MS: '0',
            LANYWHERE_ENABLE_PUBLIC_UPSTREAM: '1', LANYWHERE_ENABLE_LANPLAY_UPSTREAM: '0',
            LANYWHERE_CONTROL_BIND_ADDRESS: '127.0.0.1', LANYWHERE_UDP_BIND_ADDRESS: '127.0.0.1' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [server.stdout, server.stderr]) stream.on('data', bytes => { output += bytes; });
    const peers = [], exited = once(server, 'exit');
    async function stop() {
        for (const peer of peers) peer.close();
        if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
        await exited;
    }
    t.after(async () => {
        await stop();
        await fs.rm(state, { recursive: true, force: true });
    });
    const port = await until(() => {
        if (server.exitCode !== null) throw Error(output);
        return Number(/datos UDP en (\d+)/.exec(output)?.[1]) || null;
    }, 'unified lobby relay ready');
    async function peer(name, udp = false) {
        const client = new ConsolePeer(name, port);
        peers.push(client);
        await client.open({ udp });
        return client;
    }
    return { peer, port, stop, jump: () => server.kill('SIGALRM'), output: () => output };
}

async function page(peer, offset = 0, snapshot = 0, regionalView = false) {
    const request = Buffer.alloc(8);
    request.writeUInt32LE(offset);
    request.writeUInt32LE(snapshot, 4);
    peer.send(regionalView ? regional.REQUEST : UNIFIED, request);
    const replyType = regionalView ? regional.RESPONSE : UNIFIED_REPLY;
    const packet = await peer.receive(peer.frames, entry => [replyType, 0x85].includes(entry.type), 'unified page');
    assert.equal(packet.type, replyType, `unified page error: ${packet.body.toString()}`);
    const reply = packet.body;
    const count = reply[8], available = reply[9], total = reply[10], status = reply[11];
    assert(count <= 6 && available <= total && status <= 1);
    assert.equal(reply.length, 12 + count * UNIFIED_BYTES);
    const rows = [];
    for (let i = 0; i < count; i++) {
        const data = reply.subarray(12 + i * UNIFIED_BYTES, 12 + (i + 1) * UNIFIED_BYTES);
        const end = data.indexOf(0, METADATA_BYTES);
        assert(end > METADATA_BYTES && end <= 368);
        const provider = data.toString('ascii', METADATA_BYTES, end);
        const extra = data.subarray(369);
        const endpoint = regionalView && provider === regional.PROVIDER ?
            { host: [...extra.subarray(0, 4)].join('.'), port: extra.readUInt16BE(4) } : null;
        assert(endpoint ? extra[6] === 0 : !extra.some(Boolean));
        rows.push({ code: data.toString('ascii', 0, 6), game: data.readBigUInt64LE(8), count: data[32], max: data[33],
            access: data[35], provider, ...(endpoint ? { endpoint } : {}) });
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
        { id: 'up-legacy', host: '127.0.0.1', port: legacy.port, capabilities: CAPABILITY | regional.CAPABILITY, maxConnections: 4 },
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
    assert.equal((await joiner.frame(0xa0)).readUInt32LE() & (CAPABILITY | regional.CAPABILITY), 0);
    joiner.send(UNIFIED, Buffer.alloc(8));
    assert.equal((await joiner.frame(0x85))[0], 4);
    joiner.send(regional.REQUEST, Buffer.alloc(8));
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

test('regional directory keeps legacy pages and room admission isolated across two real nodes', { timeout: 15000 }, async t => {
    const eu = await launch(t, []);
    const central = await launch(t, [], { eu: `127.0.0.1:${eu.port}` });
    const centralHost = await central.peer('Central host'), browser = await central.peer('Central browser');
    await centralHost.create();
    await centralHost.publish(networkInfo([centralHost], 2));

    const old = await page(browser);
    assert.deepEqual(old.rows.map(row => row.code), [centralHost.code]);
    assert.equal(old.total, 1);
    browser.send(0x0b);
    assert.equal((await browser.frame(0x89)).readUInt32LE() & regional.CAPABILITY, regional.CAPABILITY);
    const ready = await until(async () => {
        const listing = await page(browser, 0, 0, true);
        return listing.available === 2 ? listing : null;
    }, 'empty region is reachable');
    assert.equal(ready.total, 2);
    assert.deepEqual(ready.rows, old.rows);
    assert.equal((await page(browser, 0, ready.snapshot)).status, 1);
    assert.equal((await page(browser, 0, old.snapshot, true)).status, 1);

    const hosts = [];
    for (let i = 0; i < 7; i++) {
        const host = await eu.peer(`Europe host ${i}`, i === 0);
        hosts.push(host);
        await host.create();
        await host.publish(networkInfo([host], 2));
    }
    const [openHost, lockedHost, sharedHost] = hosts;
    for (const [host, mode] of [[lockedHost, 3], [sharedHost, 2]]) {
        const command = Buffer.alloc(48);
        command.write(host.code, 0, 6, 'ascii');
        command[6] = mode;
        command[7] = 4;
        command.writeUInt32LE(host.token, 8);
        command.writeBigUInt64LE(GAME, 16);
        command.write('0192', 24);
        host.send(0x27, command);
        assert.equal((await host.frame(0xa7)).readUInt32LE(), 0);
    }
    const remoteView = await eu.peer('Regional browser');
    remoteView.send(0x0b);
    assert.equal((await remoteView.frame(0x89)).readUInt32LE() & (CAPABILITY | regional.CAPABILITY), CAPABILITY);
    remoteView.send(regional.REQUEST, Buffer.alloc(8));
    const unavailableRegion = await remoteView.frame(0x85);
    assert.equal(unavailableRegion[0], 4);
    assert.equal(unavailableRegion.subarray(1).toString(), 'regional lobby is not configured');
    const directLegacy = await page(remoteView);
    assert.equal(directLegacy.total, 1);
    assert.equal(directLegacy.available, 1);
    assert(directLegacy.rows.some(row => row.code === lockedHost.code && row.access === 2 && row.provider === 'self'));
    central.jump();
    const warm = await until(async () => {
        const listing = await page(browser, 0, 0, true);
        return listing.rows.some(row => row.provider === regional.PROVIDER) ? listing : null;
    }, 'central finds regional rows');
    assert.equal(warm.next, 6);
    const tail = await page(browser, warm.next, warm.snapshot, true);
    assert.equal(tail.next, END);
    const remoteRows = [...warm.rows, ...tail.rows].filter(row => row.provider === regional.PROVIDER);
    assert.deepEqual(new Set(remoteRows.map(row => row.code)), new Set(hosts.map(host => host.code)));
    for (const row of remoteRows) assert.deepEqual(row.endpoint, { host: '127.0.0.1', port: eu.port });
    assert.equal(remoteRows.find(row => row.code === lockedHost.code).access, 2);
    assert.equal(remoteRows.find(row => row.code === sharedHost.code).access, 1);
    assert.deepEqual((await page(browser)).rows, old.rows, 'regional rooms never appear in the legacy query');

    const remoteGame = await eu.peer('Direct joiner', true);
    await remoteGame.join(lockedHost.code, { game: GAME, error: 5 });
    const lookup = Buffer.alloc(48);
    lookup.write(lockedHost.code, 0, 6, 'ascii');
    lookup[6] = 1;
    lookup.writeBigUInt64LE(GAME, 16);
    remoteGame.send(0x27, lookup);
    assert.equal((await remoteGame.frame(0xa7)).readUInt32LE(), 6);

    const target = remoteRows.find(row => row.code === openHost.code);
    await remoteGame.join(target.code, { game: target.game });
    const station = networkInfo([remoteGame], 2).subarray(0x68, 0xa8);
    remoteGame.relay(openHost.index, 3, station);
    assert.equal((await openHost.ldn(remoteGame, 3)).readUInt32LE(), remoteGame.ip);
    const connected = networkInfo([openHost, remoteGame], 2);
    await openHost.publish(connected);
    openHost.relay(remoteGame.index, 4, connected);
    assert.equal((await remoteGame.ldn(openHost, 4))[0x67], 2);
    await Promise.all([remoteGame.register(), openHost.register()]);
    await remoteGame.sendGameData(openHost.ip, 'regional guest to host');
    await openHost.gameData(remoteGame, 'regional guest to host');
    await openHost.sendGameData(remoteGame.ip, 'regional host to guest');
    await remoteGame.gameData(openHost, 'regional host to guest');
    remoteGame.close();
    const resumed = await eu.peer('Direct joiner');
    await resumed.resume(remoteGame);

    await eu.stop();
    central.jump();
    const unavailable = await until(async () => {
        const listing = await page(browser, 0, 0, true);
        return listing.available === 1 ? listing : null;
    }, 'offline regional source is removed');
    assert.equal(unavailable.total, 2);
    assert.deepEqual(unavailable.rows, old.rows);
    assert.deepEqual(await page(browser, warm.next, warm.snapshot, true), tail, 'retained paging stays consistent');
    central.jump();
    await until(async () => (await page(browser, 0, warm.snapshot, true)).status === 1,
        'expired regional snapshot');
});
