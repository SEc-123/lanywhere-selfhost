'use strict';

// Framing is shared by the reliable relay and the explicitly unconfirmed
// legacy adapter. A stream ID is scoped to its initiator nonce and room peers.
const COMMAND = 0x24, RESPONSE = 0xa4, HEADER_BYTES = 32, PREFIX_BYTES = 4;
const CAPABILITY = 128, LEGACY_CAPABILITY = 256, MEMBER_FEATURE = 2;
const MAX_CHUNK = 1024, MAX_WINDOW = 32768;
const OP = Object.freeze({ OPEN: 1, OPEN_OK: 2, DATA: 3, FIN: 4, RST: 5, WINDOW: 6, LEGACY_READY: 7 });
const REASON = Object.freeze({ PROTOCOL: 1, UNSUPPORTED: 2, CAPACITY: 3, REFUSED: 4,
    TIMEOUT: 5, CLOSED: 6, SESSION: 7, BACKPRESSURE: 8 });

function parse(body) {
    if (!Buffer.isBuffer(body) || body.length < PREFIX_BYTES + HEADER_BYTES ||
        body.length > PREFIX_BYTES + HEADER_BYTES + MAX_CHUNK) return null;
    const h = body.subarray(PREFIX_BYTES), length = h.readUInt16LE(28);
    const frame = { peer: body.readUInt32LE(0), op: h[1], owner: h[2], id: h.readUInt32LE(4),
        nonce: h.readBigUInt64LE(8), seq: h.readBigUInt64LE(16), srcPort: h.readUInt16LE(24),
        dstPort: h.readUInt16LE(26), aux: h.readUInt16LE(30), payload: h.subarray(HEADER_BYTES) };
    if (!frame.peer || h[0] !== 1 || h[3] !== 0 || frame.owner > 1 || !frame.id || !frame.nonce ||
        body.length !== PREFIX_BYTES + HEADER_BYTES + length) return null;
    const noPorts = !frame.srcPort && !frame.dstPort;
    switch (frame.op) {
        case OP.OPEN:
            if (frame.owner !== 0 || frame.seq !== 0n || !frame.srcPort || !frame.dstPort ||
                length !== 32 || frame.aux < 1 || frame.aux > MAX_WINDOW) return null;
            break;
        case OP.OPEN_OK:
        case OP.LEGACY_READY:
            if (frame.owner !== 1 || frame.seq !== 0n || !noPorts || length ||
                frame.aux < 1 || frame.aux > MAX_WINDOW) return null;
            break;
        case OP.DATA:
            if (!noPorts || frame.aux || length < 1 || length > MAX_CHUNK) return null;
            break;
        case OP.FIN:
            if (!noPorts || frame.aux || length) return null;
            break;
        case OP.WINDOW:
            if (!noPorts || length || frame.aux > MAX_WINDOW) return null;
            break;
        case OP.RST:
            if (!noPorts || frame.seq !== 0n || length || !Object.values(REASON).includes(frame.aux)) return null;
            break;
        default: return null;
    }
    return frame;
}

function encode(peer, fields, payload = Buffer.alloc(0)) {
    if (!Number.isInteger(peer) || peer < 1 || peer > 0xffffffff || !Buffer.isBuffer(payload) || payload.length > MAX_CHUNK)
        throw new TypeError('Invalid stream encoding');
    const out = Buffer.alloc(PREFIX_BYTES + HEADER_BYTES + payload.length), h = out.subarray(PREFIX_BYTES);
    out.writeUInt32LE(peer); h[0] = 1; h[1] = fields.op; h[2] = fields.owner;
    h.writeUInt32LE(fields.id, 4); h.writeBigUInt64LE(fields.nonce, 8);
    h.writeBigUInt64LE(fields.seq ?? 0n, 16); h.writeUInt16LE(fields.srcPort ?? 0, 24);
    h.writeUInt16LE(fields.dstPort ?? 0, 26); h.writeUInt16LE(payload.length, 28);
    h.writeUInt16LE(fields.aux ?? 0, 30); payload.copy(h, HEADER_BYTES);
    if (!parse(out)) throw new TypeError('Invalid stream fields');
    return out;
}

module.exports = { COMMAND, RESPONSE, HEADER_BYTES, PREFIX_BYTES, CAPABILITY, LEGACY_CAPABILITY,
    MEMBER_FEATURE, MAX_CHUNK, MAX_WINDOW, OP, REASON, parse, encode };
