'use strict';

// Exercise public game codes through the real relay and separate TCP clients.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { ConsolePeer, networkInfo, u64, until } = require('./test-public-e2e');

const GAME = 0x0100000000abc000n;
const GAME_CODE = 0x27, GAME_CODE_REPLY = 0xa7, CAPABILITY = 512 | 1024;
const GET = 1, SET = 2, HIDE = 3, AUTHORIZE = 4;
const STATUS = { OK: 0, UNAVAILABLE: 1, INVALID: 2, ROOM_UNAVAILABLE: 3, NOT_HOST: 4, BUSY: 5, HIDDEN: 6, WRONG: 7 };

async function launch(t, upstreamPort) {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'lanywhere-game-code-'));
    let entry = path.join(__dirname, 'server.js');
    if (upstreamPort) {
        const gateway = path.join(__dirname, 'upstream-gateway.js');
        const wrapper = path.join(state, 'fixture.cjs');
        await fs.writeFile(wrapper, `const gateway = require(${JSON.stringify(gateway)});
gateway.PUBLIC_PROVIDERS = [{id:'lanywhere-public',host:'127.0.0.1',port:${upstreamPort},
    maxConnections:8,capabilities:1536,adapterMetadata:true,localTransport:true}];
require(${JSON.stringify(entry)});`);
        entry = wrapper;
    }
    const server = spawn(process.execPath, [entry, '--port', '0'], {
        env: { ...process.env, LANYWHERE_STATE_DIR: state, LANYWHERE_STATS_PORT: '0', LANYWHERE_PUBLIC_PORT: '0',
            LANYWHERE_OPS_PORT: '0', LANYWHERE_LANPLAY_PORT: '0', LANYWHERE_SHUTDOWN_GRACE_MS: '0',
            LANYWHERE_ENABLE_PUBLIC_UPSTREAM: upstreamPort ? '1' : '0', LANYWHERE_ENABLE_LANPLAY_UPSTREAM: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [server.stdout, server.stderr]) stream.on('data', bytes => { output += bytes; });
    const peers = [];
    const exited = once(server, 'exit');
    async function stop() {
        if (server.exitCode === null && server.signalCode === null) {
            for (const peer of peers) peer.close();
            server.kill('SIGTERM');
        }
        await exited;
    }
    t.after(async () => {
        await stop();
        await fs.rm(state, { recursive: true, force: true });
    });
    const port = await until(() => {
        if (server.exitCode !== null) throw Error(output);
        return Number(/datos UDP en (\d+)/.exec(output)?.[1]) || null;
    }, 'game code relay ready');
    async function peer(name, options = {}) {
        const client = new ConsolePeer(name, port);
        peers.push(client);
        await client.open({ udp: false, ...options });
        return client;
    }
    return { peer, stop, state, output: () => output };
}

function request(op, room, { token = 0, game = GAME, passcode = '' } = {}) {
    const body = Buffer.alloc(48);
    const bytes = Buffer.from(passcode, 'latin1');
    body.write(room, 0, 6, 'latin1');
    body[6] = op;
    body[7] = bytes.length;
    body.writeUInt32LE(token, 8);
    body.writeBigUInt64LE(game, 16);
    bytes.copy(body, 24);
    return body;
}

async function exchange(peer, body) {
    peer.send(GAME_CODE, body);
    const reply = await peer.frame(GAME_CODE_REPLY);
    assert.equal(reply.length, 32);
    const status = reply.readUInt32LE();
    assert(status <= STATUS.WRONG);
    const length = reply[4];
    assert(length <= 24);
    assert.equal(reply[5] | reply[6] | reply[7], 0);
    assert(reply.subarray(8 + length).every(byte => byte === 0));
    if (body[6] === AUTHORIZE && status === STATUS.OK) {
        assert.equal(length, 16);
        const grant = reply.subarray(8, 24);
        assert(grant.some(Boolean));
        return { status, grant };
    }
    return { status, passcode: reply.toString('ascii', 8, 8 + length) };
}

const empty = status => ({ status, passcode: '' });
const present = passcode => ({ status: STATUS.OK, passcode });
const get = (peer, room, game) => exchange(peer, request(GET, room, { game }));
const share = (peer, host, passcode, token = host.token) => exchange(peer, request(SET, host.code, { token, passcode }));

function publication(host, session, capacity = 4, policy = 0) {
    const info = networkInfo([host], capacity, GAME);
    info.fill(session, 16, 32);
    info[0x62] = policy;
    return info;
}

test('host shares, edits and clears a public room code without changing legacy discovery or retaining a stale code', {timeout: 15000}, async t => {
    const { peer, stop, state, output } = await launch(t);
    const host = await peer('Host'), writer = await peer('Host settings'), guest = await peer('Guest');
    guest.send(0x0b);
    assert.equal((await guest.frame(0x89)).readUInt32LE() & CAPABILITY, CAPABILITY);
    await host.create();
    assert.deepEqual(await get(guest, host.code), empty(STATUS.ROOM_UNAVAILABLE));
    assert.deepEqual(await share(writer, host, '0009-Ab'), empty(STATUS.ROOM_UNAVAILABLE));

    await host.publish(publication(host, 1));
    const legacyBefore = await guest.find(GAME);
    assert.deepEqual(legacyBefore.map(room => room.code), [host.code]);
    assert.deepEqual(await get(guest, host.code), empty(STATUS.OK));
    assert.deepEqual(await share(writer, host, '0009-Ab'), empty(STATUS.OK), 'SET never echoes the code');
    assert.deepEqual(await get(guest, host.code), present('0009-Ab'));
    assert.deepEqual(await get(guest, host.code, GAME + 1n), empty(STATUS.ROOM_UNAVAILABLE));
    assert.deepEqual(await guest.find(GAME), legacyBefore, 'old listing and room metadata stay byte-identical');

    await guest.join(host.code);
    assert.deepEqual(await share(guest, host, 'guess', guest.token), empty(STATUS.NOT_HOST));
    assert.deepEqual(await share(guest, host, 'guess'), empty(STATUS.NOT_HOST), 'membership cannot impersonate the owner');
    const wrongPath = await peer('Other network', { controlHost: '::1', localAddress: '::1' });
    assert.deepEqual(await share(wrongPath, host, 'guess'), empty(STATUS.NOT_HOST), 'host token stays bound to the active owner network');
    const passcode = ' 00aB!z-9876543210_?234 ';
    assert.equal(Buffer.byteLength(passcode), 24);
    assert.deepEqual(await share(writer, host, passcode), empty(STATUS.OK));
    assert.deepEqual(await get(guest, host.code), present(passcode), 'refresh sees the exact new code immediately');
    await host.publish(publication(host, 1));
    assert.deepEqual(await get(guest, host.code), present(passcode), 'routine publication for the same LDN session keeps the code');
    assert.deepEqual(await share(writer, host, ''), empty(STATUS.OK));
    assert.deepEqual(await get(guest, host.code), empty(STATUS.OK));

    assert.deepEqual(await share(writer, host, 'session-private-873'), empty(STATUS.OK));
    await host.publish(publication(host, 1, 4, 1));
    assert.deepEqual(await get(guest, host.code), empty(STATUS.ROOM_UNAVAILABLE));
    await host.publish(publication(host, 1));
    assert.deepEqual(await get(guest, host.code), empty(STATUS.OK), 'a closed room does not resume sharing its old code');
    assert.deepEqual(await share(writer, host, 'session-private-873'), empty(STATUS.OK));
    await host.publish(publication(host, 2));
    assert.deepEqual(await get(guest, host.code), empty(STATUS.OK), 'a replacement LDN session does not inherit the code');
    assert.deepEqual(await share(writer, host, 'session-private-873'), empty(STATUS.OK));
    await host.publish();
    assert.deepEqual(await get(guest, host.code), empty(STATUS.ROOM_UNAVAILABLE));
    await host.publish(publication(host, 2));
    assert.deepEqual(await get(guest, host.code), empty(STATUS.OK), 'a republished session does not inherit an unpublished code');
    assert.deepEqual(await share(writer, host, 'session-private-873'), empty(STATUS.OK));
    host.send(3);
    await host.barrier();
    assert.deepEqual(await get(writer, host.code), empty(STATUS.ROOM_UNAVAILABLE));
    assert.deepEqual(await share(writer, host, 'guess'), empty(STATUS.ROOM_UNAVAILABLE));

    const privateHost = await peer('Relay private');
    await privateHost.create(0n);
    assert.deepEqual(await get(writer, privateHost.code), empty(STATUS.ROOM_UNAVAILABLE));
    assert.deepEqual(await share(writer, privateHost, 'guess'), empty(STATUS.ROOM_UNAVAILABLE));
    await stop();
    assert(!output().includes('session-private-873'));
    for (const file of await fs.readdir(state))
        assert(!(await fs.readFile(path.join(state, file))).includes(Buffer.from('session-private-873')));
});

test('last reserved seat and full rooms show the code in the extended lobby', {timeout: 15000}, async t => {
    const { peer } = await launch(t);
    const host = await peer('Host'), guest = await peer('Guest'), browser = await peer('Browser');
    await host.create();
    await host.publish(publication(host, 1, 2));
    assert.deepEqual(await share(host, host, '0123'), empty(STATUS.OK));

    const wanted = Buffer.alloc(122);
    wanted.fill(1, 0, 16);
    wanted.writeBigUInt64LE(GAME, 16);
    wanted.writeUInt32LE(1, 108); // match the game ID
    wanted[115] = 1; // NET13
    wanted.write(host.code, 116, 6, 'ascii');
    guest.send(9, wanted);
    const reservation = await guest.frame(0x88);
    assert.equal(reservation[0], 1);
    assert.equal(reservation.toString('ascii', 5, 11), host.code);
    assert.deepEqual(await browser.find(GAME), []);
    assert.deepEqual(await get(guest, host.code), present('0123'));

    guest.send(10, wanted.subarray(0, 16));
    await guest.frame(0x88);
    await guest.join(host.code);
    assert.deepEqual(await get(browser, host.code), present('0123'));
    assert.deepEqual(await lobby(browser, false), []);
    assert.deepEqual(await lobby(browser), [{ code: host.code, count: 2, max: 2, mode: 1 }]);
    assert.deepEqual(await share(host, host, '0042'), empty(STATUS.OK), 'the host can still edit a full room');
    guest.send(3);
    await guest.barrier();
    assert.deepEqual(await get(browser, host.code), present('0042'));
});

test('malformed credentials are rejected without changing the current code', {timeout: 15000}, async t => {
    const { peer } = await launch(t);
    const host = await peer('Host'), guest = await peer('Guest');
    await host.create();
    await host.publish(publication(host, 1));
    assert.deepEqual(await share(host, host, '0420'), empty(STATUS.OK));
    const set = passcode => request(SET, host.code, { token: host.token, passcode });
    const changed = (body, offset, value) => { body[offset] = value; return body; };
    for (const invalid of [
        Buffer.alloc(47), Buffer.alloc(49),
        request(99, host.code), request(GET, host.code, { token: host.token }),
        request(GET, host.code, { passcode: 'not empty' }), request(SET, host.code, { passcode: 'no token' }),
        request(GET, host.code, { game: 0n }), request(GET, host.code, { game: 0xffffffffffffffffn }),
        changed(set(''), 0, 0xc1), changed(set(''), 12, 1), changed(set(''), 24, 1),
        set('1234567890123456789012345'), set('abc\n'), set('abc\x7f'), set('abc\x80'), set('abc\x00'),
    ]) assert.deepEqual(await exchange(host, invalid), empty(STATUS.INVALID));
    assert.deepEqual(await get(guest, host.code), present('0420'));
});

test('external providers never receive a room code frame or advertise the self-only bit', {timeout: 15000}, async t => {
    const sockets = new Set();
    const observed = [];
    const upstream = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
        let pending = Buffer.alloc(0);
        socket.on('data', bytes => {
            pending = Buffer.concat([pending, bytes]);
            while (pending.length >= 3 && pending.length >= pending.readUInt16LE() + 2) {
                const length = pending.readUInt16LE(), type = pending[2];
                observed.push(type);
                pending = pending.subarray(length + 2);
                if (type === 0x0b) socket.write(Buffer.from([5, 0, 0x89, 0, 6, 0, 0]));
                if (type === 5) socket.write(Buffer.from([1, 0, 0x86]));
            }
        });
    });
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise(resolve => upstream.close(resolve));
    });
    const { peer } = await launch(t, upstream.address().port);
    const host = await peer('Host'), routed = await peer('External browser');
    await host.create();
    await host.publish(publication(host, 1));
    assert.deepEqual(await share(host, host, 'private-across-networks'), empty(STATUS.OK));
    routed.send(0x20, Buffer.from('lanywhere-public'));
    assert.equal((await routed.frame(0xa0)).readUInt32LE(), 64, 'SELECT cannot expose the self-only bit');
    routed.send(0x0b);
    assert.equal((await routed.frame(0x89)).readUInt32LE(), 64, 'CAPS cannot expose the self-only bit');
    assert.deepEqual(await get(routed, host.code), empty(STATUS.UNAVAILABLE));
    assert.deepEqual(await share(routed, host, 'external-update'), empty(STATUS.UNAVAILABLE));
    assert.deepEqual(await authorize(routed, host, 'private-across-networks'), empty(STATUS.UNAVAILABLE));
    routed.send(0x22, Buffer.concat([u64(GAME), Buffer.alloc(4), Buffer.from([1])]));
    assert.equal((await routed.frame(0x85))[0], 4);
    await reserveError(routed, reservation(5, host.code, Buffer.alloc(16, 0x31)), 4);
    await routed.barrier();
    for (const type of [GAME_CODE, 0x22, 9]) assert(!observed.includes(type));
    assert.deepEqual(await get(host, host.code), present('private-across-networks'));
});

async function lobby(peer, extended = true) {
    peer.send(0x22, u64(GAME), Buffer.alloc(4), extended ? Buffer.from([1]) : Buffer.alloc(0));
    const body = await peer.frame(0xa2);
    assert.equal(body.length, 5 + body[4] * 336);
    return Array.from({length: body[4]}, (_, i) => {
        const offset = 5 + i * 336;
        return { code: body.toString('ascii', offset, offset + 6),
            count: body[offset + 32], max: body[offset + 33], mode: body[offset + 35] };
    });
}

function reservation(ticket, target = '', grant, game = GAME) {
    const body = Buffer.alloc(grant ? 138 : 122);
    body.fill(ticket, 0, 16);
    body.writeBigUInt64LE(game, 16);
    body.writeUInt32LE(1, 108);
    body[115] = 1;
    body.write(target, 116, 6, 'ascii');
    if (grant) grant.copy(body, 122);
    return body;
}

async function reserve(peer, body, state) {
    peer.send(9, body);
    const reply = await peer.frame(0x88);
    assert.equal(reply[0], state);
    return reply;
}

async function reserveError(peer, body, status = 5) {
    peer.send(9, body);
    assert.equal((await peer.frame(0x85))[0], status);
}

async function claim(peer, host, ticket, version = 1) {
    const localVersion = Buffer.alloc(2);
    localVersion.writeUInt16LE(version);
    peer.send(2, Buffer.from(host.code), peer.nickname(), u64(GAME), Buffer.from([1]), ticket.subarray(0, 16), localVersion);
    return peer.receive(peer.frames, frame => frame.type === 0x81 || frame.type === 0x85, 'protected join result');
}

const hide = (peer, host, passcode, token = host.token) =>
    exchange(peer, request(HIDE, host.code, { token, passcode }));
const authorize = (peer, host, passcode) => exchange(peer, request(AUTHORIZE, host.code, { passcode }));

test('hidden rooms require password grants for an exact seat and stay out of every legacy discovery path', {timeout: 15000}, async t => {
    const { peer } = await launch(t);
    const host = await peer('Host'), guest = await peer('Guest'), browser = await peer('Browser');
    const otherIp = await peer('Other source', { controlHost: '::1', localAddress: '::1' });
    await host.create();
    await host.publish(publication(host, 1, 4));
    assert.deepEqual(await lobby(browser), [{ code: host.code, count: 1, max: 4, mode: 0 }]);
    const ordinary = reservation(1, host.code);
    await reserve(guest, ordinary, 1);

    assert.deepEqual(await hide(host, host, ''), empty(STATUS.INVALID));
    assert.deepEqual(await hide(guest, host, 'spoof', host.token + 1 >>> 0), empty(STATUS.NOT_HOST));
    assert.deepEqual(await hide(host, host, '0042-Az'), empty(STATUS.OK));
    assert.deepEqual(await get(browser, host.code), empty(STATUS.HIDDEN));
    assert.deepEqual(await lobby(browser), [{ code: host.code, count: 1, max: 4, mode: 2 }]);
    assert.deepEqual(await lobby(browser, false), []);
    assert.deepEqual(await browser.find(GAME, host.code), []);
    browser.send(0x0c, u64(GAME), Buffer.alloc(4));
    assert.equal((await browser.frame(0x8a))[4], 0);
    const scan = Buffer.alloc(101);
    scan.writeBigUInt64LE(GAME);
    scan.writeUInt32LE(1, 92);
    scan[96] = 1;
    browser.send(0x0d, scan);
    assert.equal((await browser.frame(0x8a))[4], 0);

    await reserve(guest, ordinary, 2); // changing to hidden revoked a held open ticket
    assert.equal((await claim(guest, host, ordinary)).body[0], 5);
    await reserve(guest, reservation(2), 0); // quick excludes protected
    await reserve(guest, reservation(3, host.code), 0);
    for (const suffix of [[], [u64(GAME)], [u64(GAME), Buffer.from([1])]]) {
        guest.send(2, Buffer.from(host.code), guest.nickname(), ...suffix);
        assert.equal((await guest.frame(0x85))[0], 5);
    }

    assert.deepEqual(await authorize(guest, host, ''), empty(STATUS.INVALID));
    assert.deepEqual(await authorize(guest, host, '0042-az'), empty(STATUS.WRONG));
    const {grant} = await authorize(guest, host, '0042-Az');
    await reserveError(otherIp, reservation(4, host.code, grant));
    await reserveError(guest, reservation(4, 'ZZZZZZ', grant));
    await reserveError(guest, reservation(4, host.code, grant, GAME + 1n));
    await reserveError(guest, reservation(4, '', grant), 4);
    await reserveError(guest, reservation(4, host.code, Buffer.alloc(16)), 4);
    await reserve(guest, reservation(4, host.code, grant), 1);
    await reserveError(guest, reservation(5, host.code, grant));
    guest.send(10, Buffer.alloc(16, 4));
    assert.equal((await guest.frame(0x88))[0], 2);

    const exact = reservation(5, host.code, grant);
    await reserve(guest, exact, 1); // cancelled ticket can release its grant
    await host.publish(publication(host, 1, 4)); // no policy/session change
    await reserve(guest, exact, 1);
    const joined = await claim(guest, host, exact);
    assert.equal(joined.type, 0x81);
    assert.equal(joined.body[6], 1);
    await reserveError(browser, reservation(6, host.code, grant)); // spent by the joined ticket

    const stale = (await authorize(browser, host, '0042-Az')).grant;
    const held = reservation(7, host.code, stale);
    await reserve(browser, held, 1);
    assert.deepEqual(await hide(host, host, '0007-zz'), empty(STATUS.OK));
    await reserve(browser, held, 2);
    await reserveError(browser, reservation(8, host.code, stale));
    assert.equal((await claim(browser, host, held)).body[0], 5);
    assert.equal((await claim(guest, host, exact)).type, 0x81, 'already joined seat still replays after password edit');

    assert.deepEqual(await share(host, host, ''), empty(STATUS.OK));
    assert.deepEqual(await get(browser, host.code), empty(STATUS.OK));
    await reserve(browser, reservation(2), 1); // reopen triggers a waiting quick reservation
});

test('game policy changes and replacement sessions invalidate grants without leaking a hidden password', {timeout: 15000}, async t => {
    const { peer, stop, state, output } = await launch(t);
    const host = await peer('Host'), browser = await peer('Browser');
    await host.create();
    await host.publish(publication(host, 1, 4));
    const secret = '0098-Typo!';
    assert.deepEqual(await hide(host, host, secret), empty(STATUS.OK));
    const first = (await authorize(browser, host, secret)).grant;
    const before = reservation(1, host.code, first);
    await reserve(browser, before, 1);
    await host.publish(publication(host, 1, 4, 1));
    await host.publish(publication(host, 1, 4));
    assert.deepEqual(await get(browser, host.code), empty(STATUS.HIDDEN), 'the same protected session stays protected');
    await reserve(browser, before, 2);
    await reserveError(browser, reservation(2, host.code, first));

    const second = (await authorize(browser, host, secret)).grant;
    await host.publish(publication(host, 2, 4));
    assert.deepEqual(await get(browser, host.code), empty(STATUS.OK), 'a new publication never inherits a password');
    await reserveError(browser, reservation(2, host.code, second));
    assert.deepEqual(await hide(host, host, secret), empty(STATUS.OK));
    const third = (await authorize(browser, host, secret)).grant;
    await host.publish();
    assert.deepEqual(await get(browser, host.code), empty(STATUS.ROOM_UNAVAILABLE));
    await reserveError(browser, reservation(3, host.code, third));
    await stop();
    assert(!output().includes(secret));
    for (const file of await fs.readdir(state))
        assert(!(await fs.readFile(path.join(state, file))).includes(Buffer.from(secret)));
});
