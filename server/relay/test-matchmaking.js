'use strict';

// Real relay process and simulated console wire clients. No game or hardware runs here.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { ConsolePeer, networkInfo, u64, until } = require('./test-public-e2e');

const GAME = 0x0100000000abc000n;
const OTHER_GAME = 0x0100000000def000n;
const T = { JOIN: 2, LEAVE: 3, RESERVE: 9, CANCEL: 10, CAPS: 11, ROOM: 0x81, MEMBER_LEFT: 0x83, ERROR: 0x85,
    RESERVATION: 0x88, CAPABILITIES: 0x89 };
const S = { WAITING: 0, ASSIGNED: 1, CLOSED: 2, JOINED: 3 };
const E = { FULL: 2, BAD_REQUEST: 4, NO_SEAT: 5, BUSY: 7, VERSION: 9 };

async function launch(t, env = {}) {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'lanywhere-match-'));
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', '0'], {
        env: { ...process.env, LANYWHERE_STATE_DIR: state, LANYWHERE_STATS_PORT: '0', LANYWHERE_PUBLIC_PORT: '0',
            LANYWHERE_OPS_PORT: '0', LANYWHERE_LANPLAY_PORT: '0', LANYWHERE_SHUTDOWN_GRACE_MS: '0',
            LANYWHERE_CAP_GB: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const clients = [];
    const exited = once(child, 'exit');
    t.after(async () => {
        for (const peer of clients) peer.close();
        child.kill();
        await exited;
        await fs.rm(state, { recursive: true, force: true });
    });
    let output = '';
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (data) => { output += data; });
    const listening = await until(() => {
        if (child.exitCode !== null) throw new Error(output);
        return /datos UDP en (\d+)/.exec(output);
    }, 'match relay to listen');
    const open = async (name) => {
        const peer = new ConsolePeer(name, Number(listening[1]));
        clients.push(peer);
        await peer.open();
        return peer;
    };
    return { open, child, state, exited };
}

function request({ game = GAME, version = 1, scene, session, type, ssid, target, ticket = randomBytes(16) } = {}) {
    const body = Buffer.alloc(122);
    ticket.copy(body);
    body.writeBigUInt64LE(game, 16);
    let flags = 1;
    if (scene !== undefined) { flags |= 32; body.writeUInt16LE(scene, 26); }
    if (session) { flags |= 2; session.copy(body, 32); }
    if (type !== undefined) { flags |= 4; body.writeUInt32LE(type, 48); }
    if (ssid !== undefined) { flags |= 16; body[58] = Buffer.byteLength(ssid); body.write(ssid, 59); }
    body.writeUInt32LE(flags, 108);
    if (version !== null) { body[112] = 1; body.writeUInt16LE(version, 113); }
    body[115] = 1;
    if (target) body.write(target, 116, 'ascii');
    return body;
}

function group(peers, max, { game = GAME, version = 1, scene = 0, session, type = 0, ssid = '' } = {}) {
    const info = networkInfo(peers, max, game);
    info.writeUInt16LE(version, 0x96);
    info.writeUInt16LE(scene, 10);
    if (session) session.copy(info, 16);
    info[0x4b] = type;
    info[0x26] = Buffer.byteLength(ssid);
    info.write(ssid, 0x27);
    return info;
}

async function reservation(peer, body, type = T.RESERVE) {
    peer.send(type, body);
    const reply = await peer.frame(T.RESERVATION);
    assert.equal(reply.length, reply[0] === S.ASSIGNED ? 11 + 0x480 : 5);
    return { state: reply[0], ttl: reply.readUInt32LE(1), code: reply.toString('ascii', 5, 11), info: reply.subarray(11) };
}

const cancel = (peer, requestBody) => reservation(peer, requestBody.subarray(0, 16), T.CANCEL);

function sendClaim(peer, room, requestBody, version = 1, game = GAME, features = 1) {
    const versionBytes = Buffer.alloc(2);
    versionBytes.writeUInt16LE(version);
    peer.send(T.JOIN, Buffer.from(room.code, 'ascii'), peer.nickname(), u64(game), Buffer.from([features]),
        requestBody.subarray(0, 16), versionBytes);
}

async function answerClaim(peer) {
    const packet = await peer.receive(peer.frames, (frame) => [T.ROOM, T.ERROR].includes(frame.type), 'JOIN result');
    if (packet.type === T.ERROR) return { error: packet.body[0] };
    return { room: packet.body, index: packet.body[6], ip: packet.body.readUInt32LE(7), token: packet.body.readUInt32LE(11) };
}

test('reserved JOIN retains network identity when TCP capability is negotiated after RESERVE', { timeout: 10000 }, async t => {
    const { open } = await launch(t);
    const host = await open('OwnTcpHost'), guest = await open('OwnTcpGuest');
    await host.create(); await host.publish(group([host], 2));
    const wanted = request({ target: host.code });
    assert.equal(wanted[115], 1, 'RESERVE declares only its network feature');
    assert.equal((await reservation(guest, wanted)).state, S.ASSIGNED);
    sendClaim(guest, host, wanted, 1, GAME, 2);
    assert.equal((await answerClaim(guest)).error, 8, 'TCP capability cannot replace the required NET13 network bit');
    sendClaim(guest, host, wanted, 1, GAME, 3);
    const admitted = await answerClaim(guest); assert(admitted.room, 'NET13 plus negotiated TCP must claim the original seat');
    sendClaim(guest, host, wanted, 1, GAME, 3);
    assert.equal((await answerClaim(guest)).token, admitted.token, 'same-socket claim recovery remains idempotent');
});

test('eight FIFO requests wait for real publication, hold capacity, and consume a racing ticket once', async (t) => {
    const { open } = await launch(t);
    const [host, legacy, reconnect] = await Promise.all(['Harbor', 'Birch', 'Robin'].map(open));
    const waiters = await Promise.all(Array.from({ length: 8 }, (_, i) => open(`Guest ${i + 1}`)));
    const requests = waiters.map(() => request());
    legacy.send(T.CAPS);
    assert.equal((await legacy.frame(T.CAPABILITIES)).readUInt32LE() & 3, 3);
    for (const [i, peer] of waiters.entries()) assert.equal((await reservation(peer, requests[i])).state, S.WAITING);
    legacy.send(T.RESERVE, request());
    assert.equal((await legacy.frame(T.ERROR))[0], E.BUSY);
    await host.create();
    assert.equal((await reservation(waiters[0], requests[0])).state, S.WAITING, 'CREATE alone must not produce a match');
    await host.publish(group([host], 3));
    const first = await reservation(reconnect, requests[0]);
    const second = await reservation(waiters[1], requests[1]);
    assert.equal(first.state, S.ASSIGNED);
    assert.equal(first.code, host.code);
    assert.equal(first.info[0x67], 1);
    assert.equal(second.state, S.ASSIGNED);
    assert.equal(second.code, host.code);
    assert.ok((await reservation(waiters[0], requests[0])).ttl <= first.ttl, 'polling cannot renew a hold');
    for (let i = 2; i < waiters.length; i++) assert.equal((await reservation(waiters[i], requests[i])).state, S.WAITING);
    await legacy.join(host.code, { error: E.FULL });
    assert.deepEqual(await legacy.find(GAME), [], 'legacy discovery may not advertise fully held rooms');

    sendClaim(waiters[0], host, requests[0]);
    sendClaim(reconnect, host, requests[0]);
    const results = await Promise.all([answerClaim(waiters[0]), answerClaim(reconnect)]);
    assert.equal(results.filter((result) => result.room).length, 1);
    assert.equal(results.find((result) => !result.room).error, E.BUSY);
    const winner = results[0].room ? waiters[0] : reconnect;
    const loser = results[0].room ? reconnect : waiters[0];
    const admitted = results.find((result) => result.room);
    sendClaim(winner, host, requests[0]);
    assert.equal((await answerClaim(winner)).token, admitted.token, 'same socket replay returns its original seat');
    assert.equal((await reservation(loser, requests[0])).state, S.JOINED);

    winner.close();
    const recovered = await until(async () => {
        sendClaim(loser, host, requests[0]);
        const reply = await answerClaim(loser);
        if (reply.error) assert.equal(reply.error, E.BUSY);
        return reply.room ? reply : null;
    }, 'lost JOIN response to recover its original room seat');
    assert.equal(recovered.token, admitted.token);
    assert.equal(recovered.ip, admitted.ip);
    assert.equal(recovered.index, admitted.index);
    loser.send(T.LEAVE);
    await host.frame(T.MEMBER_LEFT, (body) => body[0] === admitted.index);
    assert.equal((await reservation(waiters[2], requests[2])).state, S.ASSIGNED);
    assert.equal((await reservation(waiters[3], requests[3])).state, S.WAITING);
    assert.equal((await cancel(waiters[1], requests[1])).state, S.CLOSED);
    assert.equal((await reservation(waiters[3], requests[3])).state, S.ASSIGNED);
    sendClaim(legacy, host, requests[1]);
    assert.equal((await answerClaim(legacy)).error, E.NO_SEAT);
});

test('uses real local communication filters, prefers fullest eligible room, and never falls back from an exact target', async (t) => {
    const { open } = await launch(t);
    const [fuller, quieter, versionMismatch, otherGame, visitor, occupied] = await Promise.all(
        ['Harbor', 'Birch', 'Clover', 'Fern', 'Maple', 'Willow'].map(open));
    const session = randomBytes(16);
    const fields = { version: 7, scene: 44, session, type: 2, ssid: 'round-robin' };
    await Promise.all([fuller.create(), quieter.create(), versionMismatch.create(), otherGame.create(OTHER_GAME)]);
    await Promise.all([fuller.publish(group([fuller], 4, fields)), quieter.publish(group([quieter], 4, fields)),
        versionMismatch.publish(group([versionMismatch], 4, { ...fields, version: 8 })),
        otherGame.publish(group([otherGame], 4, { ...fields, game: OTHER_GAME }))]);
    await occupied.join(fuller.code);
    await fuller.publish(group([fuller, occupied], 4, fields));

    const wanted = request(fields);
    const chosen = await reservation(visitor, wanted);
    assert.equal(chosen.code, fuller.code);
    assert.equal(chosen.info.readUInt16LE(10), fields.scene);
    assert.equal(chosen.info.readUInt16LE(0x96), fields.version);
    for (const mismatch of [{ scene: 45 }, { type: 3 }, { ssid: 'different' }, { session: Buffer.alloc(16, 1) }, { version: 9 },
        { target: versionMismatch.code }, { target: otherGame.code }]) {
        const exact = request({ ...fields, ...mismatch });
        assert.equal((await reservation(visitor, exact)).state, S.WAITING);
        assert.equal((await cancel(visitor, exact)).state, S.CLOSED);
    }
    const ownGame = request({ ...fields, game: OTHER_GAME });
    assert.equal((await reservation(visitor, ownGame)).code, otherGame.code);
    assert.equal((await cancel(visitor, ownGame)).state, S.CLOSED);

    const provisional = request({ ...fields, version: null, target: versionMismatch.code });
    assert.equal((await reservation(visitor, provisional)).code, versionMismatch.code);
    sendClaim(visitor, versionMismatch, provisional, fields.version);
    assert.equal((await answerClaim(visitor)).error, E.VERSION);
    assert.equal((await reservation(visitor, provisional)).state, S.CLOSED);

    const changed = Buffer.from(wanted);
    changed.writeUInt16LE(fields.version + 1, 113);
    visitor.send(T.RESERVE, changed);
    assert.equal((await visitor.frame(T.ERROR))[0], E.BAD_REQUEST, 'a ticket may not change its compatibility criteria');
    sendClaim(visitor, quieter, wanted, fields.version);
    assert.equal((await answerClaim(visitor)).error, E.NO_SEAT, 'the assigned room identity is mandatory');
    sendClaim(visitor, fuller, wanted, fields.version);
    assert.ok((await answerClaim(visitor)).room);
});

test('expires held tickets, reassigns the seat, and invalidates an offer when the host changes its session', async (t) => {
    const { open } = await launch(t, { LANYWHERE_MATCH_HOLD_MS: '800', LANYWHERE_MATCH_WAIT_MS: '3000' });
    const [host, first, next] = await Promise.all(['Harbor', 'Birch', 'Maple'].map(open));
    const beforeHost = request({ game: OTHER_GAME });
    assert.equal((await reservation(first, beforeHost)).state, S.WAITING);
    const lost = request();
    const following = request();
    await host.create();
    await host.publish(group([host], 2));
    assert.equal((await reservation(first, lost)).state, S.ASSIGNED);
    assert.equal((await reservation(next, following)).state, S.WAITING);
    await until(async () => (await reservation(next, following)).state === S.ASSIGNED, 'held seat to expire and go to next waiter');
    assert.equal((await reservation(first, lost)).state, S.CLOSED);
    sendClaim(first, host, lost);
    assert.equal((await answerClaim(first)).error, E.NO_SEAT);
    await host.publish(group([host], 2, { session: randomBytes(16) }));
    assert.equal((await reservation(next, following)).state, S.CLOSED);
    sendClaim(next, host, following);
    assert.equal((await answerClaim(next)).error, E.NO_SEAT);
    const newOffer = request();
    assert.equal((await reservation(next, newOffer)).code, host.code);
    await host.publish();
    assert.equal((await reservation(next, newOffer)).state, S.CLOSED);
    await until(async () => (await reservation(first, beforeHost)).state === S.CLOSED, 'waiting ticket to expire without a host');
});

test('drain stops admission while active peers exchange UDP and SIGTERM checkpoints after they leave', async (t) => {
    const { open, child, state, exited } = await launch(t, { LANYWHERE_SHUTDOWN_GRACE_MS: '8000' });
    const [host, guest, outsider] = await Promise.all(['Harbor', 'Birch', 'Maple'].map(open));
    await host.create();
    await host.publish(group([host], 3));
    assert.equal(await guest.join(host.code), 2);
    await host.publish(group([host, guest], 3));
    await Promise.all([host.register(), guest.register()]);
    const waiting = request({ game: OTHER_GAME });
    assert.equal((await reservation(outsider, waiting)).state, S.WAITING);

    child.kill('SIGUSR2');
    await until(async () => {
        outsider.send(T.RESERVE, waiting);
        const reply = await outsider.receive(outsider.frames, (packet) => [T.ERROR, T.RESERVATION].includes(packet.type), 'drain response');
        if (reply.type === T.ERROR) assert.equal(reply.body[0], E.BUSY);
        return reply.type === T.ERROR;
    }, 'relay to stop accepting reservations');
    assert.equal((await cancel(outsider, waiting)).state, S.CLOSED);
    await outsider.join(host.code, { error: E.BUSY });
    outsider.send(1, u64(GAME), outsider.nickname(), Buffer.from([1]));
    assert.equal((await outsider.frame(T.ERROR))[0], E.BUSY);

    child.kill('SIGTERM');
    await delay(100);
    assert.equal(child.exitCode, null, 'shutdown must keep active members until they leave or the deadline passes');
    await host.sendGameData(guest.ip, 'existing match survives drain');
    await guest.gameData(host, 'existing match survives drain');
    host.send(T.LEAVE);
    await until(() => child.exitCode !== null, 'relay to shut down after the last game closes', 3000);
    assert.deepEqual(await exited, [0, null]);
    const traffic = JSON.parse(await fs.readFile(path.join(state, 'traffic.json'), 'utf8'));
    assert.ok(traffic.bytes > 0);
});
