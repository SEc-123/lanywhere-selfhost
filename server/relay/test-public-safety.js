'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const dgram = require('node:dgram');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: sleep } = require('node:timers/promises');

const serverPath = path.join(__dirname, 'server.js');
const localhost = '127.0.0.1';
const GAME = 0x0100000000abc000n, OTHER_GAME = 0x0100000000abc001n;
const T = { CREATE: 1, JOIN: 2, RELAY: 4, PING: 5, RESUME: 6, PUBLISH: 7, FIND: 8, RESERVE: 9, CANCEL: 10,
            ROOM: 0x81, RELAY_IN: 0x84, ERROR: 0x85, PONG: 0x86, GROUPS: 0x87, RESERVATION: 0x88 };
const LDN = { SCAN: 1, CONNECT: 3, SYNC: 4, MEMBER_LEFT: 0xff };
const U = { REGISTER: 1, DATA: 2, REGISTERED: 0x81, DATA_IN: 0x82 };
const MAGIC = 0x594e414c;
const testEnv = { ...process.env, LANYWHERE_STATS_PORT: '0', LANYWHERE_PUBLIC_PORT: '0', LANYWHERE_LANPLAY_PORT: '0',
    LANYWHERE_SHUTDOWN_GRACE_MS: '0' };

const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
function frame(type, body = Buffer.alloc(0)) {
    const head = Buffer.alloc(3);
    head.writeUInt16LE(body.length + 1);
    head[2] = type;
    return Buffer.concat([head, body]);
}

function node(ip, index = 0) {
    const info = Buffer.alloc(0x40);
    info.writeUInt32LE(ip);
    info[10] = index;
    info[11] = 1;
    return info;
}

function network(game, members, max = 4) {
    const info = Buffer.alloc(0x480);
    info.writeBigUInt64LE(game);
    info[0x66] = max;
    info[0x67] = members.length;
    members.forEach((m, i) => node(m.ip, i).copy(info, 0x68 + i * 0x40));
    return info;
}

async function waitFor(fn, label) {
    const until = Date.now() + 5000;
    do {
        const value = fn();
        if (value) return value;
        await sleep(5);
    } while (Date.now() < until);
    throw new Error(`timed out waiting for ${label}`);
}

async function launch(t, env = {}) {
    const state = fs.mkdtempSync(path.join(os.tmpdir(), 'lanywhere-safety-'));
    const child = spawn(process.execPath, [serverPath, '--port', '0'], {
        env: { ...testEnv, ...env, LANYWHERE_STATE_DIR: state }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    const exited = once(child, 'exit');
    t.after(async () => {
        child.kill();
        await exited;
        fs.rmSync(state, { recursive: true, force: true });
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    const ready = await waitFor(() => {
        if (child.exitCode !== null) throw new Error(output);
        return /datos UDP en (\d+)/.exec(output);
    }, 'server startup');
    return Number(ready[1]);
}

class Peer {
    constructor(t, port, localAddress = localhost) {
        this.port = port;
        this.frames = [];
        this.datagrams = [];
        this.socket = net.connect({ port, host: localhost, localAddress });
        this.socket.on('error', () => {});
        this.closed = new Promise((resolve) => this.socket.once('close', resolve));
        let pending = Buffer.alloc(0);
        this.socket.on('data', (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 3 && pending.length >= pending.readUInt16LE(0) + 2) {
                const end = pending.readUInt16LE(0) + 2;
                this.frames.push({ type: pending[2], body: pending.subarray(3, end) });
                pending = pending.subarray(end);
            }
        });
        t.after(() => this.socket.destroy());
    }
    async connect() { await once(this.socket, 'connect'); return this; }
    send(type, body) { this.socket.write(frame(type, body)); }
    async recv(type) {
        return waitFor(() => {
            const i = this.frames.findIndex((msg) => msg.type === type);
            return i < 0 ? null : this.frames.splice(i, 1)[0].body;
        }, `frame 0x${type.toString(16)}`);
    }
    async sync() { this.send(T.PING); await this.recv(T.PONG); }
    async readRoom() {
        const room = await this.recv(T.ROOM);
        this.code = room.subarray(0, 6);
        this.index = room[6];
        this.ip = room.readUInt32LE(7);
        this.token = room.readUInt32LE(11);
    }
    async create(game) {
        this.send(T.CREATE, Buffer.concat([u64(game), Buffer.alloc(32), Buffer.from([1])]));
        await this.readRoom();
    }
    async join(host, game) {
        this.send(T.JOIN, Buffer.concat([host.code, Buffer.alloc(32), u64(game), Buffer.from([1])]));
        await this.readRoom();
    }
    async udpSocket(t, localAddress = localhost) {
        const socket = dgram.createSocket('udp4');
        t.after(() => socket.close());
        socket.on('message', (msg) => this.datagrams.push(msg));
        await new Promise((resolve) => socket.bind(0, localAddress, resolve));
        return socket;
    }
    udpSend(socket, type, payload = Buffer.alloc(0)) {
        const head = Buffer.alloc(9);
        head.writeUInt32LE(MAGIC);
        head[4] = type;
        head.writeUInt32LE(this.token, 5);
        socket.send(Buffer.concat([head, payload]), this.port, localhost);
    }
    async register(t) {
        const socket = await this.udpSocket(t);
        this.udpSend(socket, U.REGISTER);
        await waitFor(() => this.datagrams.some((d) => d[4] === U.REGISTERED), 'UDP registration');
        return socket;
    }
    data(socket, target, size) {
        const body = Buffer.alloc(8 + size);
        body.writeUInt32LE(target.ip);
        body.writeUInt16LE(9000, 4);
        body.writeUInt16LE(9000, 6);
        this.udpSend(socket, U.DATA, body);
    }
}

test('invalid ports and invalid traffic settings fail at startup', () => {
    for (const [args, env, diagnostic] of [
        [['--port', '65536'], {}, '--port'],
        [[], { LANYWHERE_CAP_GB: 'bad' }, 'LANYWHERE_CAP_GB'],
        [[], { LANYWHERE_STATS_PORT: '11460' }, 'superponen'],
        [[], { LANYWHERE_CONTROL_FRAMES_PER_SEC: '0' }, 'LANYWHERE_CONTROL_FRAMES_PER_SEC'],
    ]) {
        const child = spawnSync(process.execPath, [serverPath, ...args], { env: { ...testEnv, ...env }, encoding: 'utf8', timeout: 2000 });
        assert.equal(child.status, 1, child.stderr);
        assert.ok(child.stderr.includes(diagnostic), child.stderr);
    }
});

test('the relay bounds accepted sockets, frame size, and control rate', async (t) => {
    const port = await launch(t, { LANYWHERE_MAX_CONNECTIONS: '2', LANYWHERE_CONTROL_FRAMES_PER_SEC: '2' });
    const a = await new Peer(t, port).connect();
    const b = await new Peer(t, port).connect();
    await a.sync();
    await b.sync();
    const extra = new Peer(t, port);
    await extra.closed;

    a.socket.write(Buffer.concat(Array.from({ length: 10 }, () => frame(T.PING))));
    await a.closed;
    const replacement = await new Peer(t, port).connect();
    await replacement.sync();
    replacement.socket.write(Buffer.from([0x01, 0x10])); // Declared length exceeds the control frame limit.
    await replacement.closed;
});

test('publication and LDN control reject forged ownership, game IDs, nodes, and origins', async (t) => {
    const port = await launch(t);
    const host = await new Peer(t, port).connect();
    const guest = await new Peer(t, port).connect();
    const finder = await new Peer(t, port).connect();
    await host.create(GAME);
    host.send(T.PUBLISH, network(OTHER_GAME, [host]));
    assert.equal((await host.recv(T.ERROR))[0], 4);
    host.send(T.PUBLISH, network(GAME, [host], 9));
    assert.equal((await host.recv(T.ERROR))[0], 4);
    const badCount = network(GAME, [host]);
    badCount[0x67] = 2;
    host.send(T.PUBLISH, badCount);
    assert.equal((await host.recv(T.ERROR))[0], 4);
    finder.send(T.FIND, u64(GAME));
    assert.equal((await finder.recv(T.GROUPS))[0], 0);

    host.send(T.PUBLISH, network(GAME, [host]));
    await host.sync();
    await guest.join(host, GAME);
    guest.send(T.PUBLISH, network(GAME, [guest]));
    assert.equal((await guest.recv(T.ERROR))[0], 4);
    guest.send(T.PUBLISH);
    assert.equal((await guest.recv(T.ERROR))[0], 4);
    finder.send(T.FIND, u64(GAME));
    assert.equal((await finder.recv(T.GROUPS))[0], 1);

    const to = (dest, type, body = Buffer.alloc(0)) => Buffer.concat([Buffer.from([dest.index, type]), body]);
    guest.send(T.RELAY, to(host, LDN.CONNECT, node(host.ip)));
    guest.send(T.RELAY, to(host, LDN.SYNC, network(GAME, [guest])));
    guest.send(T.RELAY, to(host, LDN.MEMBER_LEFT));
    guest.send(T.RELAY, to(host, LDN.CONNECT, node(guest.ip)));
    const relayed = await host.recv(T.RELAY_IN);
    assert.equal(relayed[0], guest.index);
    assert.equal(relayed[1], LDN.CONNECT);
    assert.equal(relayed.readUInt32LE(2), guest.ip);
    assert.equal(host.frames.some((msg) => msg.type === T.RELAY_IN), false);

    finder.send(T.RESUME, Buffer.concat([Buffer.alloc(4), host.code]));
    assert.equal((await finder.recv(T.ERROR))[0], 5);
    const token = Buffer.alloc(4);
    token.writeUInt32LE(host.token);
    finder.send(T.RESUME, Buffer.concat([token, host.code]));
    assert.equal((await finder.recv(T.ERROR))[0], 7);
    await host.sync();

    await host.register(t);
    const guestUdp = await guest.register(t);
    const locked = network(GAME, [host, guest]);
    locked[0x62] = 1; // LDN AlwaysReject: hide the room without disrupting members already playing.
    host.send(T.PUBLISH, locked);
    await host.sync();
    finder.send(T.FIND, u64(GAME));
    assert.equal((await finder.recv(T.GROUPS))[0], 0);
    finder.send(T.JOIN, Buffer.concat([host.code, Buffer.alloc(32), u64(GAME), Buffer.from([1])]));
    assert.equal((await finder.recv(T.ERROR))[0], 1);
    guest.data(guestUdp, host, 20);
    await waitFor(() => host.datagrams.some((d) => d[4] === U.DATA_IN), 'admitted member can still play');

    host.send(T.PUBLISH, network(GAME, [host, guest]));
    await host.sync();
    finder.send(T.FIND, u64(GAME));
    assert.equal((await finder.recv(T.GROUPS))[0], 1);
    await finder.join(host, GAME);
});

test('UDP requires registration, ignores malformed rebinding attempts, and limits data bytes', async (t) => {
    const port = await launch(t, { LANYWHERE_DATA_BYTES_PER_SEC: '280' });
    const a = await new Peer(t, port).connect();
    const b = await new Peer(t, port).connect();
    await a.create(0n);
    await b.join(a, 0n);
    const as = await a.register(t);
    const unregistered = await b.udpSocket(t);
    b.data(unregistered, a, 20);
    await sleep(50);
    assert.equal(a.datagrams.some((d) => d[4] === U.DATA_IN), false);

    const bs = await b.register(t);
    if (process.platform === 'linux') {
        const foreign = await a.udpSocket(t, '127.0.0.2');
        a.udpSend(foreign, U.REGISTER);
        a.data(foreign, b, 20);
        await sleep(50);
        assert.equal(a.datagrams.filter((d) => d[4] === U.REGISTERED).length, 1);
        assert.equal(b.datagrams.some((d) => d[4] === U.DATA_IN), false);
    }
    const unexpected = dgram.createSocket('udp4');
    t.after(() => unexpected.close());
    const unexpectedPackets = [];
    unexpected.on('message', (msg) => unexpectedPackets.push(msg));
    await new Promise((resolve) => unexpected.bind(0, localhost, resolve));
    b.udpSend(unexpected, 0x99);
    b.udpSend(unexpected, U.REGISTER, Buffer.from([0]));
    await sleep(50);

    await sleep(1020 - Date.now() % 1000);
    for (let i = 0; i < 5; i++) a.data(as, b, 80); // 125 bytes on the wire, so only two pass.
    const delivered = () => b.datagrams.filter((d) => d[4] === U.DATA_IN).length;
    await waitFor(() => delivered() === 2, 'two allowed datagrams');
    await sleep(50);
    assert.equal(delivered(), 2);
    assert.equal(unexpectedPackets.length, 0);

    b.data(bs, a, 20);
    await waitFor(() => a.datagrams.some((d) => d[4] === U.DATA_IN), 'other member retains its own budget');
});

function reservationRequest(ticket, code) {
    const request = Buffer.alloc(122);
    ticket.copy(request);
    request.writeBigUInt64LE(GAME, 16);
    request.writeUInt32LE(1, 108); // Exact LocalCommunicationId from ScanFilter.
    request[115] = 1; // NET13.
    if (code) code.copy(request, 116);
    return request;
}

function reservationJoin(ticket, code, version = 0) {
    const body = Buffer.alloc(65);
    code.copy(body);
    body.writeBigUInt64LE(GAME, 38);
    body[46] = 1;
    ticket.copy(body, 47);
    body.writeUInt16LE(version, 63);
    return body;
}

test('a captured reservation cannot be polled, canceled or claimed from another public IP',
    { skip: process.platform !== 'linux' }, async (t) => {
        const port = await launch(t);
        const host = await new Peer(t, port).connect();
        const anotherHost = await new Peer(t, port).connect();
        const owner = await new Peer(t, port).connect();
        const foreign = await new Peer(t, port, '127.0.0.2').connect();
        await host.create(GAME);
        await anotherHost.create(GAME);
        host.send(T.PUBLISH, network(GAME, [host]));
        anotherHost.send(T.PUBLISH, network(GAME, [anotherHost]));
        await host.sync();
        await anotherHost.sync();

        const ticket = randomBytes(16);
        const request = reservationRequest(ticket, host.code);
        owner.send(T.RESERVE, request);
        const assigned = await owner.recv(T.RESERVATION);
        assert.equal(assigned[0], 1);
        assert.deepEqual(assigned.subarray(5, 11), host.code);

        for (const [type, body] of [[T.RESERVE, request], [T.CANCEL, ticket], [T.JOIN, reservationJoin(ticket, host.code)]]) {
            foreign.send(type, body);
            assert.equal((await foreign.recv(T.ERROR))[0], 5);
        }

        owner.send(T.JOIN, reservationJoin(ticket, anotherHost.code));
        assert.equal((await owner.recv(T.ERROR))[0], 5);
        owner.send(T.RESERVE, request);
        assert.equal((await owner.recv(T.RESERVATION))[0], 1);
        owner.send(T.JOIN, reservationJoin(ticket, host.code));
        await owner.readRoom();
        assert.deepEqual(owner.code, host.code);

        foreign.send(T.JOIN, reservationJoin(ticket, host.code));
        assert.equal((await foreign.recv(T.ERROR))[0], 5);
        await owner.sync();
    });

test('a single source IP cannot exhaust global reservation storage by canceling unknown tickets',
    { skip: process.platform !== 'linux' }, async (t) => {
        const port = await launch(t);
        const a = await new Peer(t, port).connect();
        const b = await new Peer(t, port, '127.0.0.2').connect();
        for (let i = 0; i < 32; i++) {
            a.send(T.CANCEL, randomBytes(16));
            assert.equal((await a.recv(T.RESERVATION))[0], 2);
        }
        a.send(T.CANCEL, randomBytes(16));
        assert.equal((await a.recv(T.ERROR))[0], 7);
        a.send(T.RESERVE, reservationRequest(randomBytes(16)));
        assert.equal((await a.recv(T.ERROR))[0], 7);

        b.send(T.CANCEL, randomBytes(16));
        assert.equal((await b.recv(T.RESERVATION))[0], 2);
        b.send(T.RESERVE, reservationRequest(randomBytes(16)));
        assert.equal((await b.recv(T.RESERVATION))[0], 0);
    });

test('a public host rejection releases the relay seat even when the guest ignores it', async (t) => {
    const port = await launch(t);
    const host = await new Peer(t, port).connect();
    const guest = await new Peer(t, port).connect();
    const next = await new Peer(t, port).connect();
    await host.create(GAME);
    host.send(T.PUBLISH, network(GAME, [host], 2));
    await host.sync();
    await guest.join(host, GAME);
    host.send(T.RELAY, Buffer.from([guest.index, 5])); // LDN DISCONNECT, not relay LEAVE.
    assert.deepEqual(await guest.recv(T.RELAY_IN), Buffer.from([host.index, 5]));
    await host.recv(0x83);
    host.send(T.PUBLISH, network(GAME, [host], 2));
    await host.sync();
    await next.join(host, GAME);
    assert.equal(next.index, guest.index);
    await guest.closed;
});

test('public JOIN expires without host admission; a confirmed station retains its seat', async (t) => {
    const port = await launch(t, { LANYWHERE_JOIN_TIMEOUT_MS: '150' });
    const host = await new Peer(t, port).connect();
    const incomplete = await new Peer(t, port).connect();
    const confirmed = await new Peer(t, port).connect();
    await host.create(GAME);
    host.send(T.PUBLISH, network(GAME, [host], 2));
    await host.sync();
    await incomplete.join(host, GAME);
    await incomplete.sync(); // PING does not extend the LDN admission deadline.
    assert.equal((await incomplete.recv(T.ERROR))[0], 5);
    await incomplete.closed;
    await confirmed.join(host, GAME);
    host.send(T.PUBLISH, network(GAME, [host, confirmed], 2));
    await host.sync();
    await sleep(300);
    await confirmed.sync();
    assert.equal(confirmed.socket.destroyed, false);
});

test('UDP replies use the configured local interface', async (t) => {
    const port = await launch(t, { LANYWHERE_UDP_BIND_ADDRESS: localhost });
    const host = await new Peer(t, port).connect();
    await host.create(0n);
    const socket = await host.udpSocket(t);
    const packet = once(socket, 'message');
    host.udpSend(socket, U.REGISTER);
    const [body, sender] = await packet;
    assert.equal(body[4], U.REGISTERED);
    assert.equal(sender.address, localhost);
    assert.equal(sender.port, port);
});
