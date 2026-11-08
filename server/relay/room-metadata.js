'use strict';

// Display-only host declarations. LCID and room admission never come from these fields.
const decoder = new TextDecoder('utf-8', { fatal: true });
const PAYLOAD_BYTES = 272, RECORD_BYTES = 336;
function title(bytes) {
    const end = bytes.indexOf(0);
    if (end < 0 || bytes.subarray(end).some(Boolean)) return null;
    try {
        const text = decoder.decode(bytes.subarray(0, end));
        if (!Buffer.from(text, 'utf8').equals(bytes.subarray(0, end)) || /[\p{Cc}\u061c\u200b\u200e\u200f\u2028-\u202e\u2066-\u206f\ufeff]/u.test(text)) return null;
        if (text.length && !text.replace(/^ +| +$/g, '').length) return null;
        return text;
    } catch { return null; }
}
function parse(body) {
    if (!Buffer.isBuffer(body) || body.length !== PAYLOAD_BYTES) return null;
    const en = title(body.subarray(16,144)), zh = title(body.subarray(144,272));
    if (en === null || zh === null) return null;
    return { programId: body.readBigUInt64LE(0), applicationId: body.readBigUInt64LE(8), en, zh };
}
function create({ now = Date.now } = {}) {
    const entries = new WeakMap(), limits = new WeakMap();
    function set(member, body) {
        const room = member?.room;
        if (!room || room.members[0] !== member || !member.socket || member.socket.destroyed || member.socket.writableEnded)
            return { error: 'owner' };
        const value = parse(body);
        if (!value) return { error: 'invalid' };
        const previous = entries.get(room);
        if (previous?.owner === member && previous.raw.equals(body)) return { ok: true };
        const minute = Math.floor(now() / 60000);
        let rate = limits.get(room);
        if (!rate || rate.minute !== minute) limits.set(room, rate = { minute, n: 0 });
        if (++rate.n > 4) return { error: 'rate' };
        entries.set(room, { ...value, raw: Buffer.from(body), owner: member });
        return { ok: true };
    }
    function summary(room) {
        const b = Buffer.alloc(RECORD_BYTES), host = room.members[0];
        b.write(room.code,0,6,'ascii'); b.writeBigUInt64LE(room.gameId,8);
        b[32] = room.published.info[0x67]; b[33] = room.published.info[0x66];
        b.write(host?.nick || '',40,39,'utf8');
        const value = entries.get(room);
        if (value && value.owner === host) {
            b.writeBigUInt64LE(value.applicationId,16); b.writeBigUInt64LE(value.programId,24);
            b[34] = 1; // Valid host declaration exists; never a trusted launch authorization.
            b.write(value.en,80,127,'utf8'); b.write(value.zh,208,127,'utf8');
        }
        return b;
    }
    function page(rooms, next) {
        if (!Array.isArray(rooms) || rooms.length > 6) throw Error('Invalid metadata page');
        const header = Buffer.alloc(5); header.writeUInt32LE(next); header[4] = rooms.length;
        return Buffer.concat([header,...rooms.map(summary)]);
    }
    return { set, summary, page };
}
module.exports = { create, parse, PAYLOAD_BYTES, RECORD_BYTES };
