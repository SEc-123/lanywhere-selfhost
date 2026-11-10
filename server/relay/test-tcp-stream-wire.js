'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { Peer } = require('../../deploy/smoke-relay.cjs');
const P = require('./tcp-stream-protocol');

test('actual TCP relay: flow-controlled byte stream, room isolation and detach reset', { timeout: 15000 }, async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stream-wire-'));
    const peers = [];
    const server = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', '0'], {
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LANYWHERE_STATE_DIR: dir,
            LANYWHERE_STATS_PORT: '0', LANYWHERE_PUBLIC_PORT: '0', LANYWHERE_OPS_PORT: '0',
            LANYWHERE_LANPLAY_PORT: '0', LANYWHERE_ENABLE_LANPLAY_UPSTREAM: '0',
            LANYWHERE_ENABLE_PUBLIC_UPSTREAM: '0', LANYWHERE_SHUTDOWN_GRACE_MS: '0' },
    });
    let logs = ''; server.stdout.on('data', b => logs += b); server.stderr.on('data', b => logs += b);
    t.after(async () => {
        for (const p of peers) p.close();
        if (server.exitCode === null) { const done = once(server, 'exit'); server.kill('SIGTERM'); await Promise.race([done, delay(2500)]); }
        if (server.exitCode === null) server.kill('SIGKILL');
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const deadline = Date.now() + 4000;
    while (!logs.includes('datos UDP') && Date.now() < deadline && server.exitCode === null) await delay(20);
    assert(logs.includes('datos UDP'), logs);
    const port = Number(/control TCP en (\d+)/.exec(logs)[1]);
    async function enter(name, code, features = 3) {
        const p = new Peer(name, '127.0.0.1', port); peers.push(p); await p.connect();
        p.send(0x0b); assert.equal((await p.frame(0x89)).readUInt32LE(), 255 | 512 | 1024 | 2048 | 4096);
        const nick = Buffer.alloc(32); nick.write(name);
        p.send(code ? 2 : 1, Buffer.concat(code ? [code, nick, Buffer.alloc(8), Buffer.from([features])] :
            [Buffer.alloc(8), nick, Buffer.from([features])]));
        const body = await p.frame(0x81); p.code = body.subarray(0, 6); p.ip = body.readUInt32LE(7); p.token = body.readUInt32LE(11);
        return p;
    }
    const a = await enter('OwnStreamA'), b = await enter('OwnStreamB', a.code);
    const stranger = await enter('OwnOtherRoom'), old = await enter('OwnLegacy', a.code, 1);
    const network = Buffer.alloc(32); network.writeBigUInt64LE(11n); network[16] = 19;
    function tx(from, to, op, owner, id, extra = {}, data = Buffer.alloc(0)) {
        from.send(P.COMMAND, P.encode(to.ip, { op, owner, id, nonce: 77n, ...extra }, data));
    }
    const open = (peer, id) => tx(a, peer, P.OP.OPEN, 0, id, { srcPort: 50001, dstPort: 3200, aux: 32768 }, network);
    open(stranger, 1); assert.equal(P.parse(await a.frame(P.RESPONSE)).op, P.OP.RST);
    open(old, 2); assert.equal(P.parse(await a.frame(P.RESPONSE)).aux, P.REASON.UNSUPPORTED);
    assert(!stranger.frames.some(f => f[0] === P.RESPONSE));
    open(b, 3); let h = P.parse(await b.frame(P.RESPONSE)); assert.equal(h.op, P.OP.OPEN); assert(h.payload.equals(network));
    tx(b, a, P.OP.OPEN_OK, 1, 3, { aux: 32768 }); assert.equal(P.parse(await a.frame(P.RESPONSE)).op, P.OP.OPEN_OK);
    // More than the ordinary 100 control frames/sec, while respecting the game
    // byte/packet budget and receiver credit. This must not drop or close TCP.
    let position = 0n;
    for (let batch = 0; batch < 10; batch++) {
        const expected = [];
        for (let i = 0; i < 16; i++) {
            const data = Buffer.alloc(1024, batch * 16 + i); expected.push(data);
            tx(a, b, P.OP.DATA, 0, 3, { seq: position }, data); position += 1024n;
        }
        let offset = position - 16384n;
        for (const data of expected) { h = P.parse(await b.frame(P.RESPONSE)); assert.equal(h.op, P.OP.DATA); assert.equal(h.seq, offset); assert(h.payload.equals(data)); offset += 1024n; }
        tx(b, a, P.OP.WINDOW, 1, 3, { seq: position, aux: 32768 });
        h = P.parse(await a.frame(P.RESPONSE)); assert.equal(h.op, P.OP.WINDOW); assert.equal(h.seq, position);
    }
    tx(b, a, P.OP.DATA, 1, 3, { seq: 0n }, Buffer.from('reverse'));
    h = P.parse(await a.frame(P.RESPONSE)); assert.equal(h.payload.toString(), 'reverse');
    tx(a, b, P.OP.WINDOW, 0, 3, { seq: 7n, aux: 32768 }); await b.frame(P.RESPONSE);
    b.close(); h = P.parse(await a.frame(P.RESPONSE)); assert.equal(h.op, P.OP.RST); assert.equal(h.aux, P.REASON.CLOSED);
    let busy = false;
    for (let attempt = 0; attempt < 2 && !busy; attempt++) {
        const bucket = Math.floor(Date.now() / 60000);
        for (let i = 0; i <= 120; i++) {
            if (i === 60) await delay(1100); // Respect the separate per-second control limit.
            a.send(8);
            const until = Date.now() + 3000;
            let index = -1;
            while ((index = a.frames.findIndex(f => f[0] === 0x87 || f[0] === 0x85)) < 0 && Date.now() < until) await delay(10);
            assert(index >= 0, 'FIND response is required');
            const response = a.frames.splice(index, 1)[0];
            if (response[0] === 0x85) { assert.equal(response[1], 7); busy = true; break; }
            assert.equal(response[1], 0);
        }
        // A real minute-boundary reset is allowed by the quota contract. Only
        // that observed event permits one bounded continuation in the new bucket.
        if (!busy) assert.notEqual(Math.floor(Date.now() / 60000), bucket, 'quota rejection cannot be an empty success');
    }
    assert(busy, 'legacy search quota must return BUSY, never an empty success');
    assert.equal(server.exitCode, null);
});
