'use strict';

const P = require('./tcp-stream-protocol');
const { OP, REASON } = P;

// No application bytes are retained here. Native endpoints own their bounded
// receive buffers; this router checks sequence/credit before forwarding over
// the existing reliable control connection.
function create({ send, now = Date.now, maxStreams = 128, maxPerMember = 8,
    maxPerRoom = 32, openTimeoutMs = 5000, event = () => {} } = {}) {
    if (typeof send !== 'function') throw new TypeError('Stream sender required');
    const flows = new Map(), ledgers = new WeakMap(), memberships = new WeakMap();
    const active = m => !!(m?.room && m.room.members[m.index] === m && m.socket &&
        !m.socket.destroyed && !m.socket.writableEnded);
    const members = m => memberships.get(m) || new Set();
    const admitted = m => active(m) && (!m.room.gameId ||
        (!!m.room.published && m.room.published.connected.has(m)));
    const key = (origin, receiver, h) => `${origin.token}:${receiver.token}:${h.nonce}:${h.id}`;
    function emit(receiver, peerIp, fields, payload) {
        if (!active(receiver)) return false;
        try { return send(receiver, P.encode(peerIp, fields, payload)) !== false; }
        catch { event('delivery-error', REASON.PROTOCOL); return false; }
    }
    function reset(receiver, peerIp, h, reason) {
        return emit(receiver, peerIp, { op: OP.RST, owner: 1 - h.owner,
            id: h.id, nonce: h.nonce, aux: reason });
    }
    function remove(f) {
        if (flows.get(f.key) !== f) return false;
        flows.delete(f.key);
        memberships.get(f.a)?.delete(f);
        memberships.get(f.b)?.delete(f);
        return true;
    }
    function end(f, reason, except = null) {
        if (!remove(f)) return; // Re-entrant adapters cannot observe a half-closed entry.
        if (f.a !== except) emit(f.a, f.b.ip, { op: OP.RST, owner: 1, id: f.id, nonce: f.nonce, aux: reason });
        if (f.b !== except) emit(f.b, f.a.ip, { op: OP.RST, owner: 0, id: f.id, nonce: f.nonce, aux: reason });
        event('closed', reason);
    }
    function sessionValid(f) {
        if (!admitted(f.a) || !admitted(f.b) || f.a.socket !== f.sockets[0] || f.b.socket !== f.sockets[1] ||
            f.a.room !== f.room || f.b.room !== f.room) return false;
        return !f.room.gameId || f.room.published.info.subarray(0, 32).equals(f.networkId);
    }
    function complete(f) {
        if (flows.get(f.key) === f && f.fin[0] && f.fin[1] && f.sent[0] === f.consumed[0] && f.sent[1] === f.consumed[1]) {
            remove(f); event('finished', 0);
        }
    }
    function handle(member, body) {
        const h = P.parse(body);
        if (!h || !active(member)) return { ok: false, reason: 'invalid' };
        const peer = member.room.members.find(m => m?.ip === h.peer);
        if (!peer || peer === member || !active(peer)) {
            reset(member, h.peer, h, REASON.CLOSED); return { ok: false, reason: 'peer' };
        }
        if (!(member.features & P.MEMBER_FEATURE) || !(peer.features & P.MEMBER_FEATURE)) {
            reset(member, peer.ip, h, REASON.UNSUPPORTED); return { ok: false, reason: 'unsupported' };
        }
        const origin = h.owner === 0 ? member : peer, receiver = h.owner === 0 ? peer : member;
        const id = key(origin, receiver, h);
        let f = flows.get(id);
        if (h.op === OP.OPEN) {
            if (!admitted(member) || !admitted(peer) || !h.payload.some(Boolean) ||
                (member.room.gameId && !member.room.published.info.subarray(0, 32).equals(h.payload))) {
                reset(member, peer.ip, h, REASON.SESSION); return { ok: false, reason: 'session' };
            }
            if (f) {
                // TCP does not need retransmission; an ID cannot be reopened.
                end(f, REASON.PROTOCOL); return { ok: false, reason: 'duplicate-open' };
            }
            let ledger = ledgers.get(member);
            if (ledger && ledger.socket !== member.socket) {
                if (members(member).size) {
                    reset(member, peer.ip, h, REASON.SESSION); return { ok: false, reason: 'nonce-active' };
                }
                ledger = null;
            }
            if (ledger && ledger.nonce !== h.nonce && members(member).size) {
                reset(member, peer.ip, h, REASON.SESSION); return { ok: false, reason: 'nonce-active' };
            }
            // A nonce identifies an LDN session, not permission to reuse IDs on
            // the same control socket. Keep its high-water across nonce changes.
            if (ledger && h.id <= ledger.lastId) {
                reset(member, peer.ip, h, REASON.PROTOCOL); return { ok: false, reason: 'reused-id' };
            }
            const roomCount = [...flows.values()].filter(x => x.room === member.room).length;
            if (flows.size >= maxStreams || roomCount >= maxPerRoom ||
                members(member).size >= maxPerMember || members(peer).size >= maxPerMember) {
                reset(member, peer.ip, h, REASON.CAPACITY); return { ok: false, reason: 'capacity' };
            }
            ledgers.set(member, { socket: member.socket, nonce: h.nonce, lastId: h.id });
            f = { key: id, a: member, b: peer, room: member.room, id: h.id, nonce: h.nonce,
                sockets: [member.socket, peer.socket], networkId: Buffer.from(h.payload),
                deadline: now() + openTimeoutMs, opened: false, legacy: !!(member.socket.legacyTcp || peer.socket.legacyTcp),
                sent: [0n, 0n], consumed: [0n, 0n], window: [0, h.aux], fin: [false, false] };
            flows.set(id, f);
            for (const m of [member, peer]) {
                if (!memberships.has(m)) memberships.set(m, new Set());
                memberships.get(m).add(f);
            }
            if (!emit(peer, member.ip, h, h.payload)) { end(f, REASON.BACKPRESSURE); return { ok: false, reason: 'send' }; }
            event('opened', 0); return { ok: true };
        }
        if (!f || f.a !== origin || f.b !== receiver) {
            // An unknown reset is terminal already; do not create reset loops.
            if (h.op !== OP.RST) reset(member, peer.ip, h, REASON.CLOSED);
            return { ok: false, reason: 'missing' };
        }
        if (!sessionValid(f)) { end(f, REASON.SESSION); return { ok: false, reason: 'session' }; }
        const direction = member === f.a ? 0 : 1;
        function invalid(reason = 'protocol') { end(f, REASON.PROTOCOL); return { ok: false, reason }; }
        if (h.op === OP.OPEN_OK || h.op === OP.LEGACY_READY) {
            if (f.opened || member !== f.b) return invalid('unexpected-ready');
            if (h.op === OP.LEGACY_READY && !(member.socket.virtual && member.socket.legacyTcp)) return invalid('false-legacy');
            if (h.op === OP.OPEN_OK && member.socket.legacyTcp) return invalid('false-reliable');
            f.opened = true; f.legacy ||= h.op === OP.LEGACY_READY; f.window[0] = h.aux;
        } else if (h.op === OP.RST) {
            remove(f); emit(peer, member.ip, h); event('reset', h.aux); return { ok: true };
        } else {
            if (!f.opened) return invalid('not-ready');
            if (h.op === OP.DATA) {
                const length = BigInt(h.payload.length);
                if (f.fin[direction] || h.seq !== f.sent[direction] ||
                    h.seq + length > 0xffffffffffffffffn ||
                    h.seq + length > f.consumed[direction] + BigInt(f.window[direction])) return invalid('sequence-or-credit');
                f.sent[direction] += length;
            } else if (h.op === OP.FIN) {
                if (f.fin[direction] || h.seq !== f.sent[direction]) return invalid('fin-offset');
                f.fin[direction] = true;
            } else if (h.op === OP.WINDOW) {
                const opposite = 1 - direction;
                if (h.seq < f.consumed[opposite] || h.seq > f.sent[opposite]) return invalid('window-offset');
                f.consumed[opposite] = h.seq; f.window[opposite] = h.aux;
            } else return invalid();
        }
        if (!emit(peer, member.ip, h, h.payload)) { end(f, REASON.BACKPRESSURE); return { ok: false, reason: 'send' }; }
        complete(f); return { ok: true };
    }
    function closeMember(member, reason = REASON.CLOSED) {
        // Budget failure can reset streams while keeping this socket alive.
        // Notify every still-connected endpoint and preserve its ID high-water;
        // WeakMap ownership handles retired members without retaining them.
        for (const f of [...members(member)]) end(f, reason);
    }
    function sweep() {
        for (const f of [...flows.values()]) {
            if (!sessionValid(f)) end(f, REASON.SESSION);
            else if (!f.opened && now() >= f.deadline) end(f, REASON.TIMEOUT);
        }
    }
    function shutdown() { for (const f of [...flows.values()]) end(f, REASON.CLOSED); }
    return { handle, closeMember, sweep, shutdown,
        snapshot: () => ({ streams: flows.size, opening: [...flows.values()].filter(f => !f.opened).length,
            legacy: [...flows.values()].filter(f => f.legacy).length }) };
}

module.exports = { create };
