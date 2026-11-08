'use strict';

// Run with node test-public-e2e.js [--report path]. These clients implement the
// documented wire protocol on loopback. They do not run Switch firmware or games.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const dgram = require('node:dgram');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

const LOOPBACK = '127.0.0.1';
const GRACE_MS = 2500;
const WAIT_MS = 5000;
const GAME = 0x0100000000abc000n;
const OTHER_GAME = 0x0100000000def000n;
const NET13 = Buffer.from([1]);
const BROADCAST = 0x0a0dffff;
const MAGIC = 0x594e414c;
const NETWORK_INFO_SIZE = 0x480;
const NODE_OFFSET = 0x68;
const NODE_SIZE = 0x40;
const T = { CREATE: 1, JOIN: 2, LEAVE: 3, RELAY: 4, PING: 5, RESUME: 6, PUBLISH: 7, FIND: 8,
    ROOM: 0x81, MEMBER_LEFT: 0x83, RELAY_IN: 0x84, ERROR: 0x85, PONG: 0x86, GROUPS: 0x87 };
const U = { REGISTER: 1, DATA: 2, REGISTERED: 0x81, DATA_IN: 0x82 };
const E = { NO_ROOM: 1, FULL: 2, OTHER_GAME: 3, NO_SEAT: 5 };
const LDN = { SCAN: 1, SCAN_RESP: 2, CONNECT: 3, SYNC: 4 };

async function until(check, label, timeout = WAIT_MS) {
    const deadline = Date.now() + timeout;
    do {
        const result = await check();
        if (result) return result;
        await delay(20);
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}`);
}

function u64(value) {
    const buffer = Buffer.alloc(8);
    buffer.writeBigUInt64LE(value);
    return buffer;
}

function stringAt(buffer, offset, size) {
    const end = buffer.indexOf(0, offset);
    return buffer.toString('utf8', offset, end < 0 || end >= offset + size ? offset + size : end);
}

function nodeInfo(peer, slot = 0) {
    const node = Buffer.alloc(NODE_SIZE);
    node.writeUInt32LE(peer.ip, 0);
    node[4] = 2; // locally administered MAC, as in the console client
    node.writeUInt32LE(peer.ip, 6);
    node[10] = slot;
    node[11] = 1;
    node.write('Raw console name', 12);
    node.writeUInt16LE(1, 46); // localCommunicationVersion
    return node;
}

function networkInfo(peers, capacity, game = GAME) {
    const info = Buffer.alloc(NETWORK_INFO_SIZE);
    info.writeBigUInt64LE(game);
    info[0x20] = 2;
    info.writeUInt32LE(peers[0].ip, 0x22);
    info[0x66] = capacity;
    info[0x67] = peers.length;
    peers.forEach((peer, slot) => nodeInfo(peer, slot).copy(info, NODE_OFFSET + slot * NODE_SIZE));
    return info;
}

function assertNetworkInfo(info, peers, capacity, game = GAME) {
    assert.equal(info.length, NETWORK_INFO_SIZE);
    assert.equal(info.readBigUInt64LE(0), game);
    assert.equal(info[0x66], capacity);
    assert.equal(info[0x67], peers.length);
    for (const [slot, peer] of peers.entries()) {
        const offset = NODE_OFFSET + slot * NODE_SIZE;
        assert.equal(info.readUInt32LE(offset), peer.ip);
        assert.equal(info[offset + 10], slot);
        assert.equal(info[offset + 11], 1);
        assert.equal(stringAt(info, offset + 12, 33), peer.name);
    }
}

class ConsolePeer {
    constructor(name, port) {
        this.name = name;
        this.port = port;
        this.frames = [];
        this.datagrams = [];
        this.pending = Buffer.alloc(0);
    }

    async open({ localAddress = LOOPBACK, controlHost = LOOPBACK, udp = true } = {}) {
        this.tcp = net.createConnection({ host: controlHost, port: this.port, localAddress });
        this.tcp.setNoDelay(true);
        this.tcp.on('error', (error) => { this.socketError = error; });
        this.tcp.on('data', (chunk) => this.readFrames(chunk));
        await once(this.tcp, 'connect');
        if (!udp) return;
        this.udp = dgram.createSocket('udp4');
        this.udp.on('error', (error) => { this.socketError = error; });
        this.udp.on('message', (message) => this.datagrams.push(message));
        this.udp.bind(0, localAddress);
        await once(this.udp, 'listening');
    }

    readFrames(chunk) {
        this.pending = Buffer.concat([this.pending, chunk]);
        while (this.pending.length >= 3) {
            const frameSize = this.pending.readUInt16LE(0) + 2;
            if (this.pending.length < frameSize) return;
            this.frames.push({ type: this.pending[2], body: this.pending.subarray(3, frameSize) });
            this.pending = this.pending.subarray(frameSize);
        }
    }

    close() {
        this.tcp?.destroy();
        this.udp?.close();
        this.udp = null;
    }

    send(type, ...parts) {
        const header = Buffer.alloc(3);
        header.writeUInt16LE(1 + parts.reduce((size, part) => size + part.length, 0));
        header[2] = type;
        this.tcp.write(Buffer.concat([header, ...parts]));
    }

    receive(queue, predicate, label) {
        return until(() => {
            if (this.socketError) throw this.socketError;
            const index = queue.findIndex(predicate);
            return index === -1 ? null : queue.splice(index, 1)[0];
        }, `${this.name}: ${label}`);
    }

    async frame(type, predicate = () => true) {
        const packet = await this.receive(this.frames, (f) => f.type === type && predicate(f.body), `TCP 0x${type.toString(16)}`);
        return packet.body;
    }

    async barrier() {
        this.send(T.PING);
        await this.frame(T.PONG);
    }

    nickname() {
        const data = Buffer.alloc(32);
        data.write(this.name);
        return data;
    }

    async room(game = GAME) {
        const body = await this.frame(T.ROOM);
        this.code = body.toString('ascii', 0, 6);
        this.index = body[6];
        this.ip = body.readUInt32LE(7);
        this.token = body.readUInt32LE(11);
        assert.match(this.code, /^[A-HJ-NP-Z2-9]{6}$/);
        assert.equal(this.ip >>> 16, 0x0a0d);
        assert.notEqual(this.token, 0);
        assert.equal(body.readBigUInt64LE(15), game);
        assert.equal(body.length, 24 + 37 * body[23]);
        return body[23];
    }

    async create(game = GAME) {
        this.send(T.CREATE, u64(game), this.nickname(), NET13);
        assert.equal(await this.room(game), 1);
    }

    async join(code, { game = GAME, error } = {}) {
        this.send(T.JOIN, Buffer.from(code, 'ascii'), this.nickname(), u64(game), NET13);
        if (error !== undefined) {
            assert.equal((await this.frame(T.ERROR))[0], error);
            return;
        }
        return this.room(game);
    }

    async resume(oldPeer, error) {
        const token = Buffer.alloc(4);
        token.writeUInt32LE(oldPeer.token);
        this.send(T.RESUME, token, Buffer.from(oldPeer.code, 'ascii'));
        if (error !== undefined) {
            assert.equal((await this.frame(T.ERROR))[0], error);
            return;
        }
        const count = await this.room();
        for (const field of ['code', 'index', 'ip', 'token']) assert.equal(this[field], oldPeer[field]);
        return count;
    }

    async publish(info = Buffer.alloc(0)) {
        this.send(T.PUBLISH, info);
        await this.barrier();
    }

    async find(game, preferred) {
        const filter = preferred ? [u64(game), Buffer.from(preferred, 'ascii'), Buffer.from([0])] : [u64(game)];
        this.send(T.FIND, ...filter);
        const body = await this.frame(T.GROUPS);
        const groupSize = 6 + NETWORK_INFO_SIZE;
        assert.equal(body.length, 1 + body[0] * groupSize);
        return Array.from({ length: body[0] }, (_, i) => {
            const offset = 1 + i * groupSize;
            return { code: body.toString('ascii', offset, offset + 6), info: body.subarray(offset + 6, offset + groupSize) };
        });
    }

    relay(destination, message, data = Buffer.alloc(0)) {
        this.send(T.RELAY, Buffer.from([destination, message]), data);
    }

    async ldn(sender, message) {
        const body = await this.frame(T.RELAY_IN, (packet) => packet[0] === sender.index && packet[1] === message);
        return body.subarray(2);
    }

    async sendUdp(type, body = Buffer.alloc(0)) {
        const header = Buffer.alloc(9);
        header.writeUInt32LE(MAGIC, 0);
        header[4] = type;
        header.writeUInt32LE(this.token, 5);
        await new Promise((resolve, reject) => this.udp.send(Buffer.concat([header, body]), this.port, LOOPBACK,
            (error) => error ? reject(error) : resolve()));
    }

    async register() {
        await this.sendUdp(U.REGISTER);
        const reply = await this.receive(this.datagrams, (packet) => packet[4] === U.REGISTERED, 'UDP registration');
        assert.equal(reply.readUInt32LE(0), MAGIC);
        assert.equal(reply.length, 5);
    }

    async sendGameData(destination, data) {
        const body = Buffer.alloc(8 + data.length);
        body.writeUInt32LE(destination, 0);
        body.writeUInt16LE(51000, 4);
        body.writeUInt16LE(51001, 6);
        body.write(data, 8);
        await this.sendUdp(U.DATA, body);
    }

    async gameData(sender, data) {
        const packet = await this.receive(this.datagrams, (message) => message[4] === U.DATA_IN, `UDP payload ${data}`);
        assert.equal(packet.readUInt32LE(0), MAGIC);
        assert.equal(packet.readUInt32LE(5), sender.ip);
        assert.equal(packet.readUInt16LE(9), 51000);
        assert.equal(packet.readUInt16LE(11), 51001);
        assert.equal(packet.toString('utf8', 13), data);
    }

    assertNoGameData() {
        assert.equal(this.datagrams.filter((message) => message[4] === U.DATA_IN).length, 0, `${this.name}: unexpected UDP payload`);
    }
}

async function run(step) {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lanywhere-public-e2e-'));
    const clients = [];
    let maximumConcurrentClients = 0;
    let maximumRoomMembers = 0;
    let server;
    let logs = '';
    try {
        server = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', '0'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, LANYWHERE_STATE_DIR: stateDir, LANYWHERE_STATS_PORT: '0',
                LANYWHERE_PUBLIC_PORT: '0', LANYWHERE_LANPLAY_PORT: '0', LANYWHERE_GRACE_MS: String(GRACE_MS),
                LANYWHERE_SHUTDOWN_GRACE_MS: '0', LANYWHERE_CAP_GB: '1' },
        });
        server.on('error', (error) => { logs += `\n${error.stack}`; });
        for (const stream of [server.stdout, server.stderr]) stream.on('data', (data) => { logs += data.toString(); });
        const port = await until(() => {
            if (server.exitCode !== null) throw new Error(`Relay exited with code ${server.exitCode}`);
            const tcp = Number(logs.match(/control TCP en (\d+)/)?.[1]);
            const udp = Number(logs.match(/datos UDP en (\d+)/)?.[1]);
            if (!tcp || !udp) return null;
            assert.equal(tcp, udp, 'TCP and UDP must use the same port');
            return tcp;
        }, 'relay TCP and UDP to listen');

        async function open(name) {
            const peer = new ConsolePeer(name, port);
            clients.push(peer);
            await peer.open();
            const connected = clients.filter((client) => client.udp && !client.tcp.destroyed).length;
            maximumConcurrentClients = Math.max(maximumConcurrentClients, connected);
            return peer;
        }

        const [host, guest1, guest2, guest3, otherHost, otherGuest, finder] = await Promise.all(
            ['Harbor', 'Robin', 'Maple', 'Willow', 'Summit', 'Aspen', 'Juniper'].map(open));
        await step('discover-strangers-by-game', async () => {
            const otherGameHost = await open('Brook');
            await Promise.all([host.create(), otherHost.create(), otherGameHost.create(OTHER_GAME)]);
            await Promise.all([host.publish(networkInfo([host], 8)), otherHost.publish(networkInfo([otherHost], 2)),
                otherGameHost.publish(networkInfo([otherGameHost], 4, OTHER_GAME))]);
            assert.notEqual(host.code, otherHost.code);
            const groups = await finder.find(GAME);
            assert.deepEqual(new Set(groups.map((group) => group.code)), new Set([host.code, otherHost.code]));
            assertNetworkInfo(groups.find((group) => group.code === host.code).info, [host], 8);
            assert.equal((await finder.find(GAME, groups[1].code))[0].code, groups[1].code);
            const otherGameGroups = await finder.find(OTHER_GAME);
            assert.deepEqual(otherGameGroups.map((room) => room.code), [otherGameHost.code]);
            assertNetworkInfo(otherGameGroups[0].info, [otherGameHost], 4, OTHER_GAME);
            assert.deepEqual((await finder.find(OTHER_GAME, host.code)).map((room) => room.code), [otherGameHost.code]);
            await finder.join(host.code, { game: OTHER_GAME, error: E.OTHER_GAME });
            await finder.join(otherGameHost.code, { error: E.OTHER_GAME });
            otherGameHost.send(T.LEAVE);
            await otherGameHost.barrier();
            otherGameHost.close();
            assert.deepEqual(await finder.find(OTHER_GAME), []);
        });

        await step('four-peer-ldn-connect-and-sync', async () => {
            for (const [i, guest] of [guest1, guest2, guest3].entries()) {
                const groups = await guest.find(GAME);
                assert.equal(await guest.join(groups.find((group) => group.code === host.code).code), i + 2);
            }
            assert.equal(await otherGuest.join(otherHost.code), 2);
            // The game can assign station slots in a different order than TCP JOIN.
            const group = [host, guest3, guest1, guest2];
            for (const guest of group.slice(1)) {
                guest.relay(host.index, LDN.CONNECT, nodeInfo(guest));
                assert.equal((await host.ldn(guest, LDN.CONNECT)).readUInt32LE(0), guest.ip);
            }
            const info = networkInfo(group, 8);
            await host.publish(info);
            for (const guest of group.slice(1)) {
                host.relay(guest.index, LDN.SYNC, info);
                assertNetworkInfo(await guest.ldn(host, LDN.SYNC), group, 8);
            }
            guest2.relay(0xff, LDN.SCAN);
            assert.equal((await host.ldn(guest2, LDN.SCAN)).length, 0);
            host.relay(guest2.index, LDN.SCAN_RESP, info);
            assertNetworkInfo(await guest2.ldn(host, LDN.SCAN_RESP), group, 8);
            otherGuest.relay(otherHost.index, LDN.CONNECT, nodeInfo(otherGuest));
            assert.equal((await otherHost.ldn(otherGuest, LDN.CONNECT)).readUInt32LE(0), otherGuest.ip);
            const secondInfo = networkInfo([otherHost, otherGuest], 2);
            await otherHost.publish(secondInfo);
            otherHost.relay(otherGuest.index, LDN.SYNC, secondInfo);
            assertNetworkInfo(await otherGuest.ldn(otherHost, LDN.SYNC), [otherHost, otherGuest], 2);
        });

        await step('udp-unicast-broadcast-and-room-isolation', async () => {
            await Promise.all([host, guest1, guest2, guest3, otherHost, otherGuest].map((peer) => peer.register()));
            await guest1.sendGameData(guest3.ip, 'first room unicast');
            await guest3.gameData(guest1, 'first room unicast');
            await guest2.sendGameData(BROADCAST, 'first room broadcast');
            await Promise.all([host, guest1, guest3].map((peer) => peer.gameData(guest2, 'first room broadcast')));
            await otherHost.sendGameData(BROADCAST, 'second room broadcast');
            await otherGuest.gameData(otherHost, 'second room broadcast');
            await host.sendGameData(otherGuest.ip, 'cross-room destination must not receive this');
            await delay(125);
            for (const peer of [host, guest1, guest2, guest3, otherHost, otherGuest]) peer.assertNoGameData();
            for (const peer of [otherHost, otherGuest]) {
                assert.equal(peer.frames.some(({ type, body }) => type === T.RELAY_IN && body[1] === LDN.SCAN), false);
            }
        });

        let group;
        await step('negotiated-and-eight-member-capacity', async () => {
            await finder.join(otherHost.code, { error: E.FULL });
            assert.deepEqual((await finder.find(GAME)).map((room) => room.code), [host.code]);
            const extra = await Promise.all(['Hazel', 'Olive', 'Clover', 'Rowan'].map(open));
            group = [host, guest3, guest1, guest2];
            for (const peer of extra) {
                assert.equal(await peer.join(host.code), group.length + 1);
                peer.relay(host.index, LDN.CONNECT, nodeInfo(peer));
                assert.equal((await host.ldn(peer, LDN.CONNECT)).readUInt32LE(0), peer.ip);
                group.push(peer);
                await peer.register();
            }
            // All eight relay seats are taken even before the game's next PUBLISH.
            await finder.join(host.code, { error: E.FULL });
            assert.deepEqual(await finder.find(GAME), []);
            maximumRoomMembers = group.length;
            const info = networkInfo(group, 8);
            await host.publish(info);
            host.relay(group.at(-1).index, LDN.SYNC, info);
            assertNetworkInfo(await group.at(-1).ldn(host, LDN.SYNC), group, 8);
            await host.sendGameData(BROADCAST, 'eight seats occupied');
            await Promise.all(group.slice(1).map((peer) => peer.gameData(host, 'eight seats occupied')));
        });

        await step('leave-opens-seat-and-stranger-can-rejoin', async () => {
            const old = group.at(-1);
            old.send(T.LEAVE);
            await host.frame(T.MEMBER_LEFT, (body) => body[0] === old.index);
            await old.resume(old, E.NO_SEAT);
            old.close();
            group.pop();
            await host.publish(networkInfo(group, 8));
            assert.deepEqual((await finder.find(GAME)).map((room) => room.code), [host.code]);
            assert.equal(await finder.join(host.code), 8);
            assert.equal(finder.index, old.index);
            await finder.register();
            finder.relay(host.index, LDN.CONNECT, nodeInfo(finder));
            assert.equal((await host.ldn(finder, LDN.CONNECT)).readUInt32LE(0), finder.ip);
            const info = networkInfo([...group, finder], 8);
            await host.publish(info);
            host.relay(finder.index, LDN.SYNC, info);
            assertNetworkInfo(await finder.ldn(host, LDN.SYNC), [...group, finder], 8);
            await host.sendGameData(finder.ip, 'replacement seat active');
            await finder.gameData(host, 'replacement seat active');
            finder.send(T.LEAVE);
            await host.frame(T.MEMBER_LEFT, (body) => body[0] === finder.index);
            await host.publish(networkInfo(group, 8));
        });

        let reconnectedHost;
        await step('host-disconnect-hides-room-and-resume-restores-it', async () => {
            host.close();
            await until(async () => (await finder.find(GAME)).length === 0, 'public room to disappear on disconnect', 1000);
            await finder.join(host.code, { error: E.NO_ROOM });
            reconnectedHost = await open(host.name);
            assert.equal(await reconnectedHost.resume(host), group.length);
            await reconnectedHost.register();
            const restored = await finder.find(GAME);
            assert.deepEqual(restored.map((room) => room.code), [host.code]);
            await guest1.sendGameData(reconnectedHost.ip, 'host recovered');
            await reconnectedHost.gameData(guest1, 'host recovered');
        });

        await step('expired-host-seat-and-publication-cleanup', async () => {
            reconnectedHost.close();
            await until(async () => (await finder.find(GAME)).length === 0, 'restored room to disappear on disconnect', 1000);
            await guest1.frame(T.MEMBER_LEFT, (body) => body[0] === host.index);
            await finder.resume(host, E.NO_SEAT);
            await finder.resume(guest1, E.NO_SEAT);
            await finder.join(host.code, { error: E.NO_ROOM });
            assert.deepEqual(await finder.find(GAME), []);
            await otherGuest.sendGameData(otherHost.ip, 'independent room survived');
            await otherHost.gameData(otherGuest, 'independent room survived');
        });
        assert.equal(maximumConcurrentClients, 11);
        assert.equal(maximumRoomMembers, 8);
        return { maximumConcurrentClients, maximumRoomMembers, distinctSyntheticGameIds: 2 };
    } catch (error) {
        if (logs) console.error(logs.trimEnd());
        throw error;
    } finally {
        for (const client of clients) client.close();
        if (server?.pid && server.exitCode === null && server.signalCode === null) {
            const exited = once(server, 'exit');
            server.kill();
            await exited;
        }
        await fs.rm(stateDir, { recursive: true, force: true });
    }
}

async function main() {
    const args = process.argv.slice(2);
    assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--report'),
        'Usage: node test-public-e2e.js [--report path]');
    const report = { scope: 'Simulated console wire clients over real TCP and UDP loopback sockets',
        hardwareTested: false, gameExecuted: false,
        checks: [], nodeVersion: process.version };
    try {
        report.observed = await run(async (name, check) => {
            const start = Date.now();
            try {
                await check();
                report.checks.push({ name, status: 'passed', durationMs: Date.now() - start });
                console.log(`PASS ${name}`);
            } catch (error) {
                report.checks.push({ name, status: 'failed', durationMs: Date.now() - start, error: error.message });
                throw error;
            }
        });
        report.status = 'passed';
    } catch (error) {
        report.status = 'failed';
        report.error = error.message;
        throw error;
    } finally {
        if (args[1]) {
            await fs.mkdir(path.dirname(args[1]), { recursive: true });
            await fs.writeFile(args[1], `${JSON.stringify(report, null, 2)}\n`);
        }
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exitCode = 1;
    });
}

module.exports = { ConsolePeer, networkInfo, u64, until };
