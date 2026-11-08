'use strict';
// In-memory socket boundary tests: execute the actual gateway without public ports or live traffic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, 'lanplay.js'), 'utf8');
function fixture(options = {}) {
    let socket, paused = false, now = 100000;
    const sent = [], data = [], intervals = [], rooms = new Map(), native = new Map();
    const dgram = { createSocket() {
        socket = new EventEmitter(); socket.bind = (_, fn) => fn?.(); socket.close = () => {};
        socket.getSendQueueSize = () => 0;
        socket.send = (buf, port, address, cb) => { sent.push({ buf: Buffer.from(buf), port, address }); cb?.(); };
        return socket;
    } };
    const context = { Buffer, console, require: (n) => n === 'dgram' ? dgram : require(n), module: { exports: {} },
        Date: class extends Date { static now() { return now; } },
        setInterval: (fn, ms) => { const t = { fn, ms, unref() {} }; intervals.push(t); return t; },
        clearInterval() {}, setTimeout: () => ({ unref() {} }), clearTimeout() {} };
    vm.runInNewContext(source, context, { filename: 'lanplay.js' });
    const L = context.module.exports;
    const frame = (vs, type) => {
        if (type === 1) {
            const room = { code: 'ABCDEF', gameId: 1n, members: [] };
            const member = { ip: vs.ip13, socket: vs, room, index: 0 };
            vs.member = member; room.members.push(member); rooms.set(room.code, room);
        } else if (type === 3) { vs.member = null; }
    };
    const gateway = L.create({ port: 1, log() {}, count() {}, paused: () => paused, rooms, frame,
        forwardData: (...args) => data.push(args), memberAt: (ip) => native.get(ip), isOpen: () => false, ...options });
    const endpoint = (n) => ({ address: '127.0.0.1', port: 50000 + n });
    const emit = (c, type, payload = Buffer.alloc(0)) => socket.emit('message', Buffer.concat([Buffer.from([type]), payload]), c);
    const learn = (c, ip) => emit(c, L.P.IPV4, L.udpPacket(ip, 1, L.GATEWAY_IP, 2, Buffer.alloc(0)));
    const host = (c, ip) => {
        const info = Buffer.alloc(0x480); info[0x66] = 8; info[0x67] = 1;
        info.writeBigUInt64LE(1n); info.writeUInt32LE(ip, 0x68); info[0x73] = 1;
        emit(c, L.P.IPV4, L.udpPacket(ip, 11452, L.GATEWAY_IP, 11452, L.ldnFrame(L.LT.SCAN_RESP, info)));
    };
    return { L, gateway, sent, data, rooms, native, endpoint, emit, learn, host,
        pause: () => { paused = true; }, advance: (ms) => { now += ms; },
        sweep: () => intervals.find((t) => t.ms === 3000).fn() };
}
function ipFragment(L, whole, off, end, more, id) {
    const h = Buffer.from(whole.subarray(0, 20));
    h.writeUInt16BE(20 + end - off, 2); h.writeUInt16BE(id, 4);
    h.writeUInt16BE((more ? 0x2000 : 0) | (off / 8), 6);
    return Buffer.concat([h, whole.subarray(20 + off, 20 + end)]);
}
function relayFragment(src, dst, id, part, total, pmtu, bytes) {
    const h = Buffer.alloc(16); h.writeUInt32BE(src); h.writeUInt32BE(dst, 4); h.writeUInt16LE(id, 8);
    h[10] = part; h[11] = total; h.writeUInt16LE(bytes.length, 12); h.writeUInt16LE(pmtu, 14);
    return Buffer.concat([h, bytes]);
}
{
    const f = fixture(), { L } = f, victim = 0x0a0d0101, receiver = 0x0a0d0202, owner = 0x0a0d0303;
    f.native.set(victim, { socket: { virtual: false } });
    f.learn(f.endpoint(2), receiver); f.learn(f.endpoint(3), owner); f.sent.length = 0;
    f.emit(f.endpoint(1), L.P.IPV4, L.udpPacket(victim, 1, receiver, 2, Buffer.from('spoof')));
    assert.equal(f.sent.length, 0); assert.equal(f.gateway.taken(victim), false);
    const packet = L.udpPacket(owner, 1, receiver, 2, Buffer.from('fragment'));
    f.emit(f.endpoint(1), L.P.IPV4_FRAG, relayFragment(owner, receiver, 1, 0, 1, packet.length, packet));
    assert.equal(f.sent.length, 0, 'fragment source must belong to actual endpoint');
    f.emit(f.endpoint(3), L.P.IPV4_FRAG, relayFragment(owner, receiver, 1, 0, 1, packet.length, packet));
    assert.equal(f.sent.length, 1, 'owned valid fragments still relay');
    f.pause(); f.sent.length = 0;
    f.emit(f.endpoint(3), L.P.IPV4, L.udpPacket(owner, 1, receiver, 2, Buffer.from('paused')));
    f.emit(f.endpoint(3), L.P.PING, Buffer.from('paused'));
    assert.equal(f.sent.length, 0, 'monthly pause suppresses game forwarding and ping'); f.gateway.close();
}
{
    const f = fixture({ dataPackets: 2 }), { L } = f, receiver = 0x0a0d0202, sender = 0x0a0d0303;
    const otherIp = { address: '127.0.0.2', port: 50002 };
    f.learn(otherIp, receiver); f.learn(f.endpoint(1), sender); f.sent.length = 0;
    for (let i = 0; i < 3; i++) f.emit(f.endpoint(1), L.P.IPV4, L.udpPacket(sender, 1, receiver, 2, Buffer.from('burst')));
    assert.equal(f.sent.length, 1, 'source IP budget includes learning packet and is enforced');
    f.advance(1000);
    f.emit(f.endpoint(1), L.P.IPV4, L.udpPacket(sender, 1, receiver, 2, Buffer.from('next second')));
    assert.equal(f.sent.length, 2); f.gateway.close();
}
{
    const f = fixture(), { L } = f, sender = 0x0a0d0303, receiver = 0x0a0d0101, c = f.endpoint(1);
    f.host(c, sender); const room = f.rooms.get('ABCDEF');
    f.native.set(receiver, { socket: { virtual: false }, room });
    const packet = L.udpPacket(sender, 1234, receiver, 2345, Buffer.alloc(40, 0x41)); // 48-byte IP body
    for (const [start, end, more] of [[0,24,true],[16,32,true],[40,48,false]])
        f.emit(c, L.P.IPV4, ipFragment(L, packet, start, end, more, 1));
    assert.equal(f.data.length, 0, 'overlap and hole never fabricate a completed datagram');
    const last = ipFragment(L, packet, 24, 48, false, 2);
    f.emit(c, L.P.IPV4, last); f.emit(c, L.P.IPV4, last); // identical duplicate is harmless
    f.emit(c, L.P.IPV4, ipFragment(L, packet, 0, 24, true, 2));
    assert.equal(f.data.length, 1, 'complete out-of-order packet delivers once');
    assert.deepEqual(f.data[0][2].subarray(4), Buffer.alloc(40, 0x41));
    // Changing the relay fragment stride cannot create a buffer with holes.
    f.data.length = 0;
    f.emit(c, L.P.IPV4_FRAG, relayFragment(sender, receiver, 3, 0, 2, 40, packet.subarray(0,40)));
    f.emit(c, L.P.IPV4_FRAG, relayFragment(sender, receiver, 3, 1, 2, 41, packet.subarray(40)));
    assert.equal(f.data.length, 0);
    f.emit(c, L.P.IPV4_FRAG, relayFragment(sender, receiver, 4, 1, 2, 40, packet.subarray(40)));
    f.emit(c, L.P.IPV4_FRAG, relayFragment(sender, receiver, 4, 0, 2, 40, packet.subarray(0,40)));
    assert.equal(f.data.length, 1);
    f.advance(41000); f.sweep();
    assert.equal(f.gateway.taken(sender), false);
    f.learn(f.endpoint(2), sender); f.data.length = 0;
    f.emit(f.endpoint(2), L.P.IPV4, L.udpPacket(sender, 1, receiver, 2, Buffer.from('stale identity')));
    assert.equal(f.data.length, 0, 'reclaimed IP must not inherit old bridge membership');
    f.gateway.close();
}
{
    const f = fixture();
    for (let i = 0; i < 1030; i++) f.emit({ address: `198.51.${i >> 8}.${i & 255}`, port: 40000 }, f.L.P.KEEPALIVE);
    assert.equal(f.gateway.stats().clients, 1024, 'global endpoint table is bounded'); f.gateway.close();
}
console.log('LAN Play safety: source identity, fragments, quotas, reassembly, endpoint expiry and limits passed');
