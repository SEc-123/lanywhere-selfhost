'use strict';

// Bounded reassembly for the negotiated relay UDP extension. The caller authenticates
// the member/session and charges the wire rate budget before calling push().
const MAX_PAYLOAD = 65507;
const MAX_CHUNK = 1100;
const MAX_FRAGMENTS = 128;
function create({ maxTotal = 8 * 1024 * 1024, perMember = 2, ttlMs = 2000,
                  maxRecentPerMember = 2048, maxRecentTotal = 65536, now = Date.now } = {}) {
    for (const [name, value] of Object.entries({ maxTotal, perMember, ttlMs, maxRecentPerMember, maxRecentTotal })) {
        if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
    }
    if (typeof now !== 'function') throw new TypeError('now must be a clock function');
    const owners = new Map();
    let allocated = 0, pendingMessages = 0, recentIds = 0;

    function drop(state, id) {
        const message = state.pending.get(id);
        if (message) { allocated -= message.total; pendingMessages--; }
        state.pending.delete(id);
    }
    function expire(owner, state, time) {
        for (const [id, message] of state.pending) if (message.expires <= time) drop(state, id);
        for (const [id, expires] of state.recent) if (expires <= time) { state.recent.delete(id); recentIds--; }
        if (!state.pending.size && !state.recent.size) owners.delete(owner);
    }
    function sweep() {
        const time = now();
        for (const [owner, state] of owners) expire(owner, state, time);
    }
    function clear(owner) {
        const state = owners.get(owner);
        if (!state) return;
        for (const id of state.pending.keys()) drop(state, id);
        recentIds -= state.recent.size;
        owners.delete(owner);
    }
    function invalidate(state, id, time) {
        if (!state.pending.has(id)) return null;
        drop(state, id);
        // Invalidated IDs are also quarantined so later pieces cannot start a
        // different message under the same ID during the assembly window.
        state.recent.set(id, time + ttlMs);
        recentIds++;
        return null;
    }
    function push(owner, id, meta, total, offset, chunk) {
        if (!owner || (typeof owner !== 'object' && typeof owner !== 'function') ||
            !Number.isInteger(id) || id < 0 || id > 0xffffffff) return null;
        const time = now();
        let state = owners.get(owner);
        if (state) { expire(owner, state, time); state = owners.get(owner); }
        if (state?.recent.has(id)) return null;
        const valid = typeof meta === 'string' && meta.length <= 256 &&
            Number.isInteger(total) && total >= 1 && total <= MAX_PAYLOAD &&
            Number.isInteger(offset) && offset >= 0 && Buffer.isBuffer(chunk) &&
            chunk.length >= 1 && chunk.length <= MAX_CHUNK && offset + chunk.length <= total;
        if (!valid) return state ? invalidate(state, id, time) : null;
        let message = state?.pending.get(id);
        if (message && (message.meta !== meta || message.total !== total)) return invalidate(state, id, time);
        if (!message) {
            // Reserve one recent-ID slot for each pending message. Do not evict a
            // still-live replay marker to admit another message.
            if (state && (state.pending.size >= perMember || state.recent.size + state.pending.size >= maxRecentPerMember)) return null;
            if (allocated + total > maxTotal || pendingMessages + recentIds >= maxRecentTotal) sweep();
            if (allocated + total > maxTotal || pendingMessages + recentIds >= maxRecentTotal) return null;
            // sweep may have removed this owner's now-empty state.
            state = owners.get(owner);
            if (!state) { state = { pending: new Map(), recent: new Map() }; owners.set(owner, state); }
            message = { meta, total, buffer: Buffer.alloc(total), ranges: new Map(), covered: 0, expires: time + ttlMs };
            state.pending.set(id, message);
            allocated += total;
            pendingMessages++;
        }
        const end = offset + chunk.length;
        for (const [start, length] of message.ranges) {
            if (start === offset && length === chunk.length && message.buffer.subarray(start, start + length).equals(chunk)) return null;
            if (offset < start + length && end > start) return invalidate(state, id, time);
        }
        if (message.ranges.size >= MAX_FRAGMENTS) return invalidate(state, id, time);
        chunk.copy(message.buffer, offset);
        message.ranges.set(offset, chunk.length);
        message.covered += chunk.length;
        if (message.covered !== total) return null;
        // All ranges are in bounds and disjoint; equality therefore proves full
        // coverage, including offset 0 and the last byte, without filling holes.
        drop(state, id);
        state.recent.set(id, time + ttlMs);
        recentIds++;
        return message.buffer;
    }
    return { push, clear, sweep, get bytes() { return allocated; } };
}

module.exports = { create };
