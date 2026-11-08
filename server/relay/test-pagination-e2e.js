'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ConsolePeer, networkInfo, u64, until } = require('./test-public-e2e');

const GAME = 0x0100000000abc000n;
const OTHER = 0x0100000000def000n;

test('wire lobby browses thirteen live rooms across games and never wraps a stale page cursor', { timeout: 20000 }, async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'switch-pages-'));
    const clients = [];
    const server = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', '0'], {
        env: { ...process.env, LANYWHERE_STATE_DIR: state, LANYWHERE_STATS_PORT: '0', LANYWHERE_PUBLIC_PORT: '0',
            LANYWHERE_LANPLAY_PORT: '0', LANYWHERE_OPS_PORT: '0', LANYWHERE_SHUTDOWN_GRACE_MS: '0',
            LANYWHERE_MAX_CONNECTIONS_PER_IP: '32' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    server.stdout.on('data', bytes => { log += bytes; });
    server.stderr.on('data', bytes => { log += bytes; });
    try {
        const port = await until(() => {
            if (server.exitCode !== null) throw new Error(log);
            return Number(/datos UDP en (\d+)/.exec(log)?.[1]) || null;
        }, 'relay ready');
        // The relay limits room creation per source IP. Use both loopback address
        // families, supported on Linux and macOS without installing IPv4 aliases.
        for (let i = 0; i < 13; i++) {
            const peer = new ConsolePeer(`Page host ${i}`, port);
            clients.push(peer);
            const address = i < 8 ? '127.0.0.1' : '::1';
            await peer.open({ controlHost: address, localAddress: address, udp: false });
            await peer.create(i < 8 ? GAME : OTHER);
            await peer.publish(networkInfo([peer], 8, i < 8 ? GAME : OTHER));
        }
        const finder = new ConsolePeer('Page browser', port);
        clients.push(finder);
        await finder.open();
        finder.send(0x0b);
        assert.equal((await finder.frame(0x89)).readUInt32LE(0) & 2, 2);
        async function page(offset, game = 0n) {
            const cursor = Buffer.alloc(4); cursor.writeUInt32LE(offset);
            finder.send(0x0c, u64(game), cursor);
            const body = await finder.frame(0x8a);
            const count = body[4];
            assert(count <= 6);
            assert.equal(body.length, 5 + count * (6 + 0x480));
            return { next: body.readUInt32LE(0), rooms: Array.from({ length: count }, (_, i) => {
                const at = 5 + i * (6 + 0x480);
                return { code: body.toString('ascii', at, at + 6), game: body.readBigUInt64LE(at + 6) };
            }) };
        }
        const seen = [], sizes = [];
        for (let offset = 0; offset !== 0xffffffff;) {
            const current = await page(offset);
            sizes.push(current.rooms.length);
            seen.push(...current.rooms.map(room => room.code));
            offset = current.next;
        }
        assert.deepEqual(sizes, [6, 6, 1]);
        assert.equal(new Set(seen).size, 13);
        assert.deepEqual(new Set(seen), new Set(clients.slice(0, 13).map(peer => peer.code)));
        const filtered = await page(0, OTHER);
        assert.equal(filtered.rooms.length, 5);
        assert(filtered.rooms.every(room => room.game === OTHER));
        assert.equal(filtered.next, 0xffffffff);
        assert.deepEqual(await page(100), { next: 0xffffffff, rooms: [] });
        await clients[0].publish();
        const codes = [...(await page(0)).rooms, ...(await page(6)).rooms].map(room => room.code);
        assert.equal(codes.length, 12);
        assert(!codes.includes(clients[0].code));
        finder.send(0x0c, Buffer.alloc(11));
        assert.equal((await finder.frame(0x85))[0], 4);
    } catch (error) {
        console.error(log);
        throw error;
    } finally {
        for (const peer of clients) peer.close();
        if (server.exitCode === null && server.signalCode === null) {
            const exited = once(server, 'exit'); server.kill(); await exited;
        }
        await fs.rm(state, { recursive: true, force: true });
    }
});

test('full ScanFilter finds a compatible room beyond 96 unrelated rooms before pagination', { timeout: 30000 }, async () => {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'switch-filter-'));
    const clients = [];
    const server = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', '0'], {
        env: { ...process.env, LANYWHERE_STATE_DIR: state, LANYWHERE_STATS_PORT: '0', LANYWHERE_PUBLIC_PORT: '0',
            LANYWHERE_LANPLAY_PORT: '0', LANYWHERE_OPS_PORT: '0', LANYWHERE_SHUTDOWN_GRACE_MS: '0',
            LANYWHERE_MAX_CONNECTIONS_PER_IP: '128', LANYWHERE_CREATE_PER_MIN: '200' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    for (const stream of [server.stdout, server.stderr]) stream.on('data', bytes => { log += bytes; });
    try {
        const port = await until(() => {
            if (server.exitCode !== null) throw new Error(log);
            return Number(/datos UDP en (\d+)/.exec(log)?.[1]) || null;
        }, 'filter relay ready');
        for (let i = 0; i < 101; i++) {
            const host = new ConsolePeer(`Filter ${i}`, port); clients.push(host);
            await host.open({ udp: false }); await host.create(GAME);
        }
        const ordered = [...clients].sort((a, b) => a.code.localeCompare(b.code));
        const target = ordered.at(-1);
        const session = Buffer.alloc(16, 0x42);
        for (const host of clients) {
            const info = networkInfo([host], 8, GAME);
            info.writeUInt16LE(host === target ? 7 : 6, 10);
            session.copy(info, 16); info[0x4b] = 2; info[0x26] = 4; info.write('same', 0x27);
            await host.publish(info);
        }
        const finder = new ConsolePeer('Filter browser', port); clients.push(finder); await finder.open({ udp: false });
        finder.send(0x0b); assert.equal((await finder.frame(0x89)).readUInt32LE() & 16, 16);
        const body = Buffer.alloc(101);
        body.writeBigUInt64LE(GAME); body.writeUInt16LE(7, 10); session.copy(body, 16);
        body.writeUInt32LE(2, 32); body[42] = 4; body.write('same', 43); body.writeUInt32LE(0x37, 92); body[96] = 1;
        finder.send(0x0d, body);
        const reply = await finder.frame(0x8a);
        assert.equal(reply[4], 1); assert.equal(reply.readUInt32LE(), 0xffffffff);
        assert.equal(reply.toString('ascii', 5, 11), target.code);
        // Every full filter participates before truncation; no unrelated room is substituted.
        for (const at of [10, 16, 32, 43]) {
            const mismatch = Buffer.from(body); mismatch[at] ^= 1;
            finder.send(0x0d, mismatch); const empty = await finder.frame(0x8a);
            if (at === 10) assert.equal(empty[4], 6); // scene 6 has 100 genuine matches.
            else assert.equal(empty[4], 0);
        }
        const invalid = Buffer.from(body); invalid[42] = 33;
        finder.send(0x0d, invalid); assert.equal((await finder.frame(0x85))[0], 4);
    } finally {
        for (const client of clients) client.close();
        if (server.exitCode === null && server.signalCode === null) { const ended = once(server, 'exit'); server.kill(); await ended; }
        await fs.rm(state, { recursive: true, force: true });
    }
});
