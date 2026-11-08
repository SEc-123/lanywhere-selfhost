'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const P = require('./tcp-stream-protocol'), { create } = require('./tcp-streams');
const { OP, REASON } = P;

function fixture(options = {}) {
    let clock = 0;
    const delivered = [], events = [], room = { gameId: 11n, members: [] };
    const network = Buffer.alloc(32); network.writeBigUInt64LE(11n); network[16] = 19;
    const info = Buffer.alloc(0x480); network.copy(info);
    for (let i = 0; i < 3; i++) room.members.push({ index: i, ip: 0x0a0d1101 + i,
        token: 100 + i, features: 3, socket: { destroyed: false, writableEnded: false }, room });
    const [a, b, c] = room.members;
    room.published = { info, connected: new Set([a, b, c]) };
    const router = create({ now: () => clock,
        send: (member, body) => delivered.push({ to: member, body, frame: P.parse(body) }),
        event: (...args) => events.push(args), ...options });
    function tx(from, to, op, extra = {}, payload = Buffer.alloc(0)) {
        const fields = { op, owner: from === a ? 0 : 1, id: 1, nonce: 71n, ...extra };
        if (op === OP.OPEN) Object.assign(fields, { owner: 0, srcPort: 50001, dstPort: 3200, aux: 8 }, extra);
        return router.handle(from, P.encode(to.ip, fields, op === OP.OPEN ? network : payload));
    }
    return { a, b, c, room, network, router, tx, delivered, events, advance: ms => { clock += ms; } };
}

test('stream codec rejects malformed envelopes and preserves exact bounded fields', () => {
    const x = fixture();
    const valid = P.encode(x.b.ip, { op: OP.OPEN, owner: 0, id: 99, nonce: 0x123456789abcdefn,
        srcPort: 49999, dstPort: 3200, aux: 8192 }, x.network);
    const decoded = P.parse(valid); assert.equal(decoded.nonce, 0x123456789abcdefn); assert(decoded.payload.equals(x.network));
    for (const [offset, byte] of [[4, 2], [7, 1], [6, 2], [5, 255]]) {
        const bad = Buffer.from(valid); bad[offset] = byte; assert.equal(P.parse(bad), null);
    }
    assert.equal(P.parse(valid.subarray(0, valid.length - 1)), null);
    assert.equal(P.parse(Buffer.concat([valid, Buffer.from([0])])), null);
    assert.throws(() => P.encode(x.b.ip, { op: OP.DATA, owner: 0, id: 1, nonce: 1n }, Buffer.alloc(1025)));
});

test('bidirectional streams preserve bytes, consumed credit and two-sided FIN', () => {
    const x = fixture(), { a, b, tx, router } = x;
    assert(tx(a, b, OP.OPEN).ok); assert.equal(router.snapshot().opening, 1);
    assert.equal(x.delivered[0].frame.peer, a.ip);
    assert(tx(b, a, OP.OPEN_OK, { aux: 8 }).ok);
    assert(tx(a, b, OP.DATA, { seq: 0n }, Buffer.from('ab')).ok);
    assert(tx(b, a, OP.WINDOW, { seq: 2n, aux: 4 }).ok);
    assert(tx(a, b, OP.DATA, { seq: 2n }, Buffer.from('cdef')).ok);
    assert(tx(a, b, OP.FIN, { seq: 6n }).ok);
    assert(tx(b, a, OP.DATA, { seq: 0n }, Buffer.from('xyz')).ok);
    assert(tx(b, a, OP.FIN, { seq: 3n }).ok);
    assert.equal(router.snapshot().streams, 1);
    assert(tx(a, b, OP.WINDOW, { seq: 3n, aux: 8 }).ok);
    assert(tx(b, a, OP.WINDOW, { seq: 6n, aux: 8 }).ok);
    assert.equal(router.snapshot().streams, 0);
    assert.deepEqual(x.delivered.filter(r => r.to === b && r.frame.op === OP.DATA).map(r => r.frame.payload.toString()), ['ab', 'cdef']);
    assert.equal(x.events.filter(e => e[0] === 'finished').length, 1);
});

test('DATA before OPEN_OK, duplicate offsets and exceeded credit reset rather than drop bytes', () => {
    for (const mode of ['before-ready', 'duplicate-offset', 'credit']) {
        const x = fixture(), { a, b, tx } = x; tx(a, b, OP.OPEN);
        if (mode !== 'before-ready') tx(b, a, OP.OPEN_OK, { aux: 2 });
        if (mode === 'duplicate-offset') tx(a, b, OP.DATA, { seq: 0n }, Buffer.from('ab'));
        assert.equal(tx(a, b, OP.DATA, { seq: 0n }, Buffer.from('abc')).ok, false);
        assert.equal(x.router.snapshot().streams, 0);
        assert(x.delivered.some(r => r.to === a && r.frame.op === OP.RST));
    }
});

test('unadmitted, different-session and unsupported peers cannot open streams', () => {
    for (const mode of ['admission', 'session', 'feature', 'other-room']) {
        const x = fixture();
        if (mode === 'admission') x.room.published.connected.delete(x.b);
        if (mode === 'session') x.network[16] ^= 1;
        if (mode === 'feature') x.b.features = 1;
        if (mode === 'other-room') x.b.room = { members: [] };
        assert.equal(x.tx(x.a, x.b, OP.OPEN).ok, false);
        assert.equal(x.router.snapshot().streams, 0);
        assert(!x.delivered.some(r => r.to === x.b && r.frame.op === OP.OPEN));
    }
});

test('capacity rejects new flows without evicting an active stream', () => {
    const x = fixture({ maxPerMember: 1 });
    assert(x.tx(x.a, x.b, OP.OPEN).ok);
    assert.equal(x.tx(x.a, x.c, OP.OPEN, { id: 2 }).ok, false);
    assert.equal(x.router.snapshot().streams, 1);
    assert.equal(x.delivered.at(-1).frame.aux, REASON.CAPACITY);
});

test('closed stream IDs cannot be replayed; active nonces cannot change', () => {
    const x = fixture(); x.tx(x.a, x.b, OP.OPEN);
    assert.equal(x.tx(x.a, x.c, OP.OPEN, { id: 2, nonce: 72n }).reason, 'nonce-active');
    x.tx(x.b, x.a, OP.RST, { aux: REASON.REFUSED });
    assert.equal(x.tx(x.a, x.b, OP.OPEN).reason, 'reused-id');
    assert.equal(x.tx(x.a, x.b, OP.OPEN, { nonce: 72n }).reason, 'reused-id');
    assert(x.tx(x.a, x.b, OP.OPEN, { nonce: 72n, id: 2 }).ok);
    x.tx(x.b, x.a, OP.RST, { nonce: 72n, id: 2, aux: REASON.REFUSED });
    assert.equal(x.tx(x.a, x.b, OP.OPEN).reason, 'reused-id');
    assert(x.tx(x.a, x.b, OP.OPEN, { id: 3 }).ok);
    x.router.closeMember(x.a, REASON.BACKPRESSURE);
    assert.equal(x.router.snapshot().streams, 0);
    assert.equal(x.tx(x.a, x.b, OP.OPEN, { id: 3 }).reason, 'reused-id');
    assert(x.delivered.some(r => r.to === x.a && r.frame.op === OP.RST && r.frame.aux === REASON.BACKPRESSURE));
});

test('socket generations and room session changes invalidate existing streams', () => {
    for (const mode of ['socket', 'network', 'left']) {
        const x = fixture(); x.tx(x.a, x.b, OP.OPEN); x.tx(x.b, x.a, OP.OPEN_OK, { aux: 8 });
        if (mode === 'socket') x.b.socket = {};
        if (mode === 'network') x.room.published.info[16] ^= 1;
        if (mode === 'left') x.room.members[1] = null;
        x.router.sweep(); assert.equal(x.router.snapshot().streams, 0);
        assert(x.delivered.some(r => r.to === x.a && r.frame.op === OP.RST));
    }
});

test('legacy readiness is explicit and only accepted from marked virtual peers', () => {
    for (const mode of ['legacy', 'unmarked', 'false-reliable', 'legacy-origin']) {
        const x = fixture();
        if (mode !== 'unmarked') { const m = mode === 'legacy-origin' ? x.a : x.b; m.socket.virtual = m.socket.legacyTcp = true; }
        x.tx(x.a, x.b, OP.OPEN);
        const result = x.tx(x.b, x.a, mode === 'false-reliable' || mode === 'legacy-origin' ? OP.OPEN_OK : OP.LEGACY_READY, { aux: 8 });
        assert.equal(result.ok, mode === 'legacy' || mode === 'legacy-origin');
        assert.equal(x.router.snapshot().legacy, result.ok ? 1 : 0);
    }
});

test('open deadlines and explicit shutdown release all state; live idle streams remain', () => {
    const x = fixture(); x.tx(x.a, x.b, OP.OPEN); x.advance(5001); x.router.sweep();
    assert.equal(x.router.snapshot().streams, 0);
    assert(x.tx(x.a, x.b, OP.OPEN, { id: 2 }).ok); x.tx(x.b, x.a, OP.OPEN_OK, { id: 2, aux: 8 });
    x.advance(86400000); x.router.sweep(); assert.equal(x.router.snapshot().streams, 1);
    x.router.shutdown(); assert.equal(x.router.snapshot().streams, 0);
});

test('receiver over-ack and invalid FIN offset fail closed', () => {
    for (const op of [OP.WINDOW, OP.FIN]) {
        const x = fixture(); x.tx(x.a, x.b, OP.OPEN); x.tx(x.b, x.a, OP.OPEN_OK, { aux: 8 });
        assert.equal(x.tx(x.b, x.a, op, { seq: 1n, ...(op === OP.WINDOW ? { aux: 8 } : {}) }).ok, false);
        assert.equal(x.router.snapshot().streams, 0);
    }
});
