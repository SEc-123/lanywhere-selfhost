'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { spawn } = require('node:child_process'), { once } = require('node:events');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), dgram = require('node:dgram');
const { setTimeout: delay } = require('node:timers/promises');
const { ConsolePeer, until } = require('./test-public-e2e');
const { create: reassembler } = require('./udp-fragments');

class Peer extends ConsolePeer {
    async open() {
        await super.open();
        this.proxy = dgram.createSocket('udp4'); this.dropped = 0; this.wireMax = 0;
        await new Promise(resolve => this.proxy.bind(0, '127.0.0.1', resolve));
        this.proxy.on('message', (bytes, source) => {
            this.wireMax = Math.max(this.wireMax, bytes.length);
            if (bytes.length > 1472) { this.dropped++; return; } // MTU1500 path that drops fragmented IPv4 datagrams.
            this.proxy.send(bytes, source.port === this.port ? this.udp.address().port : this.port, '127.0.0.1');
        });
    }
    async sendUdp(type, body = Buffer.alloc(0)) {
        const head = Buffer.alloc(9); head.writeUInt32LE(0x594e414c); head[4] = type; head.writeUInt32LE(this.token, 5);
        await new Promise((resolve, reject) => this.udp.send(Buffer.concat([head, body]), this.proxy.address().port,
            '127.0.0.1', error => error ? reject(error) : resolve()));
    }
    async registerV2() {
        const features = Buffer.alloc(4); features.writeUInt32LE(12);
        await this.sendUdp(4, features);
        const packet = await this.receive(this.datagrams, bytes => bytes[4] === 0x84, 'V2 registration');
        assert.equal(packet.length, 9); assert.equal(packet.readUInt32LE(5), 12);
    }
    async fragment(destination, id, total, offset, chunk, sourcePort = 1234, destinationPort = 2345) {
        const header = Buffer.alloc(16); header.writeUInt32LE(destination); header.writeUInt16LE(sourcePort, 4);
        header.writeUInt16LE(destinationPort, 6); header.writeUInt32LE(id, 8); header.writeUInt16LE(total, 12); header.writeUInt16LE(offset, 14);
        await this.sendUdp(5, Buffer.concat([header, chunk]));
    }
    async sendPayload(destination, id, payload, reverse = false) {
        const offsets = Array.from({ length: Math.ceil(payload.length / 1100) }, (_, i) => i * 1100);
        if (reverse) offsets.reverse();
        for (const offset of offsets) await this.fragment(destination, id, payload.length, offset, payload.subarray(offset, offset + 1100));
    }
    async payload(source, expected) {
        const assembler = reassembler(), owner = {};
        const value = await until(() => {
            while (this.datagrams.length) {
                const bytes = this.datagrams.shift();
                if (bytes[4] === 0x82) {
                    assert.equal(bytes.readUInt32LE(5), source.ip);
                    return bytes.subarray(13);
                }
                if (bytes[4] !== 0x85) continue;
                assert.equal(bytes.readUInt32LE(5), source.ip); assert.equal(bytes.readUInt16LE(9), 1234);
                assert.equal(bytes.readUInt16LE(11), 2345); assert(bytes.length <= 1121);
                const complete = assembler.push(owner, bytes.readUInt32LE(13), bytes.subarray(5, 13).toString('hex'),
                    bytes.readUInt16LE(17), bytes.readUInt16LE(19), bytes.subarray(21));
                if (complete) return complete;
            }
            return null;
        }, 'complete game datagram');
        assert.deepEqual(value, expected);
    }
    close() { super.close(); if (this.proxy) { this.proxy.close(); this.proxy = null; } }
}

async function launch(t) {
    const state = await fs.mkdtemp(path.join(os.tmpdir(), 'switch-udp-v2-'));
    const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', '0'], {
        env: { ...process.env, LANYWHERE_STATE_DIR: state, LANYWHERE_STATS_PORT: '0', LANYWHERE_PUBLIC_PORT: '0',
            LANYWHERE_OPS_PORT: '0', LANYWHERE_LANPLAY_PORT: '0', LANYWHERE_SHUTDOWN_GRACE_MS: '0' }, stdio: ['ignore','pipe','pipe'] });
    let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', data => output += data);
    const peers = [];
    t.after(async () => { for (const p of peers) p.close(); if (child.exitCode === null) { const exited = once(child,'exit'); child.kill(); await exited; }
        await fs.rm(state,{recursive:true,force:true}); });
    const port = await until(() => { if (child.exitCode !== null) throw Error(output); return Number(/datos UDP en (\d+)/.exec(output)?.[1]); }, 'V2 relay');
    return async name => { const p = new Peer(name, port); peers.push(p); await p.open(); return p; };
}

test('negotiated datagrams survive an MTU1500 proxy in both directions up to 65507 bytes, with nonce ACKs', async t => {
    const open = await launch(t), a = await open('Alpha'), b = await open('Bravo');
    a.send(11); assert.equal((await a.frame(0x89)).readUInt32LE() & 12, 12);
    await a.create(0n); await b.join(a.code, {game:0n}); await a.registerV2(); await b.registerV2();
    for (const [id, size] of [[1,1472],[2,4096],[3,65507]]) {
        const data = Buffer.alloc(size); for (let i=0;i<size;i++) data[i] = (i*37+id)&255;
        await a.sendPayload(b.ip,id,data,true); await b.payload(a,data);
        await b.sendPayload(a.ip,id,data); await a.payload(b,data);
    }
    const nonce = Buffer.from([3,1,4,1]); await a.sendUdp(6,nonce);
    const ack = await a.receive(a.datagrams,b => b[4]===0x86,'heartbeat ack');
    assert.equal(ack.length,9); assert.deepEqual(ack.subarray(5),nonce);
    assert.equal(a.dropped+b.dropped,0); assert(a.wireMax<=1125 && b.wireMax<=1125);
});

test('fragment owners and room destinations isolate data; re-registration, timeout and duplicates never deliver partial data', async t => {
    const open = await launch(t), a=await open('Alpha'), b=await open('Bravo'), outsider=await open('Outside');
    await a.create(0n); await b.join(a.code,{game:0n}); await outsider.create(0n);
    for(const p of [a,b,outsider]) await p.registerV2();
    const data=Buffer.alloc(1200,0x42);
    await a.fragment(b.ip,1,data.length,0,data.subarray(0,1100));
    await outsider.fragment(b.ip,1,data.length,1100,data.subarray(1100));
    await delay(60); assert.equal(b.datagrams.length,0);
    await a.registerV2(); await a.fragment(b.ip,1,data.length,1100,data.subarray(1100));
    await delay(60); assert.equal(b.datagrams.length,0);
    await delay(2050); await a.fragment(b.ip,1,data.length,0,data.subarray(0,1100));
    await delay(60); assert.equal(b.datagrams.length,0);
    await a.fragment(b.ip,1,data.length,1100,data.subarray(1100)); await b.payload(a,data);
    await a.sendPayload(b.ip,1,data); await delay(60); assert.equal(b.datagrams.length,0);
    await outsider.sendPayload(b.ip,2,data); await delay(60); assert.equal(b.datagrams.length,0);
});

test('mixed rooms deliver small legacy datagrams and report unsupported large legacy deliveries without truncation', async t => {
    const open=await launch(t), modern=await open('Modern'), legacy=await open('Legacy');
    await modern.create(0n); await legacy.join(modern.code,{game:0n}); await modern.registerV2(); await legacy.register();
    const small=Buffer.alloc(1000,0x32); await modern.sendPayload(legacy.ip,1,small); await legacy.payload(modern,small);
    await modern.sendPayload(legacy.ip,2,Buffer.alloc(3000,0x44));
    assert.equal((await modern.frame(0x85))[0],10); await delay(60); assert.equal(legacy.datagrams.length,0);
});
