'use strict';

const { performance } = require('node:perf_hooks');

const TICKET_BYTES = 16;
const REQUEST_BYTES = 122;
const STATUS = { WAITING: 0, ASSIGNED: 1, CLOSED: 2, JOINED: 3 };
const FLAG = { GAME: 0x01, SESSION: 0x02, TYPE: 0x04, SSID: 0x10, SCENE: 0x20 };
const SCAN_FLAGS = 0x37;
const NET13 = 1;

function scanCriteria(filter, features) {
    if (filter.length !== 96 || (features & ~NET13)) return null;
    const flags = filter.readUInt32LE(92);
    const gameId = filter.readBigUInt64LE(0);
    const networkType = filter.readUInt32LE(32);
    const ssidLength = filter[42];
    if ((flags & ~SCAN_FLAGS) || !(flags & FLAG.GAME) || !gameId ||
        ((flags & FLAG.TYPE) && networkType > 255) || ((flags & FLAG.SSID) && ssidLength > 32)) return null;
    return { gameId, features, target: '', version: null,
        scene: flags & FLAG.SCENE ? filter.readUInt16LE(10) : null,
        session: flags & FLAG.SESSION ? Buffer.from(filter.subarray(16, 32)) : null,
        type: flags & FLAG.TYPE ? networkType : null,
        ssid: flags & FLAG.SSID ? Buffer.from(filter.subarray(43, 43 + ssidLength)) : null };
}

function discoveryRequest(body) {
    if (body.length !== 101) return null;
    const criteria = scanCriteria(body.subarray(0, 96), body[96]);
    return criteria && { criteria, offset: body.readUInt32LE(97) };
}

// ScanFilter is 96 bytes. NetworkInfo uses the same NetworkId but a different
// CommonNetworkInfo layout. The version is in the host's NodeInfo, not in ScanFilter.
function request(body) {
    if (body.length !== REQUEST_BYTES) return null;
    const ticket = key(body.subarray(0, TICKET_BYTES));
    const filter = body.subarray(TICKET_BYTES, 112);
    const hasVersion = body[112];
    const features = body[115];
    const criteria = scanCriteria(filter, features);
    const rawTarget = body.subarray(116);
    const target = rawTarget.some(Boolean) ? rawTarget.toString('latin1') : '';
    if (!ticket || !criteria || hasVersion > 1 || (target && !/^[A-HJ-NP-Z2-9]{6}$/.test(target))) return null;
    const { gameId, scene, session, type, ssid } = criteria;
    const version = hasVersion ? body.readUInt16LE(113) : null;
    const signature = JSON.stringify([String(gameId), target, features, version, scene, session?.toString('hex'), type, ssid?.toString('hex')]);
    return { ticket, signature, gameId, target, features, version, scene, session, type, ssid };
}

function key(ticket) {
    return ticket.length === TICKET_BYTES && ticket.some(Boolean) ? ticket.toString('hex') : null;
}

const hostVersion = (info) => info.readUInt16LE(0x68 + 46);

function matches(room, criteria) {
    const info = room.published?.info;
    return info && room.gameId === criteria.gameId && (!room.net13 || (criteria.features & NET13)) &&
        (!criteria.target || criteria.target === room.code) &&
        (criteria.version === null || hostVersion(info) === criteria.version) &&
        (criteria.scene === null || info.readUInt16LE(10) === criteria.scene) &&
        (!criteria.session || info.subarray(16, 32).equals(criteria.session)) &&
        (criteria.type === null || info[0x4b] === criteria.type) &&
        (!criteria.ssid || (info[0x26] === criteria.ssid.length && info.subarray(0x27, 0x27 + info[0x26]).equals(criteria.ssid)));
}

function groupIdentity(info) {
    // A newer publication can update occupancy and names. It must not swap out the group offered to the game.
    return Buffer.concat([info.subarray(0, 8), info.subarray(10, 12), info.subarray(16, 38),
        info.subarray(0x26, 0x27 + Math.min(info[0x26], 32)), info.subarray(0x4b, 0x4c), info.subarray(0x96, 0x98)]);
}

function create({ rooms, capacity, waitMs, holdMs, joinedMs, maxTickets = 4096, perIpLimit = 8, recentPerIp = 32,
                  maxWaitingPerGame = 256 }) {
    const tickets = new Map();
    const queueByGame = new Map();
    const holdsByRoom = new Map();
    const activeByIp = new Map();
    const retainedByIp = new Map();
    const joinedByMember = new Map();
    const roomAvailability = new WeakMap();
    const tombstoneMs = Math.max(waitMs, holdMs, joinedMs);
    const count = (room) => holdsByRoom.get(room)?.size ?? 0;

    function changeCount(map, ip, delta) {
        const next = (map.get(ip) ?? 0) + delta;
        if (next > 0) map.set(ip, next);
        else map.delete(ip);
    }

    function canRetain(ip) {
        return tickets.size < maxTickets && (retainedByIp.get(ip) ?? 0) < recentPerIp;
    }

    function retain(ticket) {
        tickets.set(ticket.key, ticket);
        changeCount(retainedByIp, ticket.ownerIp, 1);
    }

    function removeFromQueue(ticket) {
        const queue = queueByGame.get(ticket.criteria.gameId);
        queue?.delete(ticket);
        if (queue?.size === 0) queueByGame.delete(ticket.criteria.gameId);
    }

    function releaseHold(ticket) {
        const held = holdsByRoom.get(ticket.room);
        held?.delete(ticket);
        if (held?.size === 0) holdsByRoom.delete(ticket.room);
        ticket.room = null;
        ticket.identity = null;
    }

    function deactivate(ticket) {
        if (ticket.state === STATUS.WAITING) removeFromQueue(ticket);
        else releaseHold(ticket);
        changeCount(activeByIp, ticket.ownerIp, -1);
    }

    function close(ticket, now) {
        if (ticket.state === STATUS.WAITING || ticket.state === STATUS.ASSIGNED) deactivate(ticket);
        if (ticket.member) joinedByMember.delete(ticket.member);
        ticket.member = null;
        ticket.state = STATUS.CLOSED;
        ticket.until = now + tombstoneMs;
    }

    function allocate(gameId, now) {
        const queue = queueByGame.get(gameId);
        if (!queue?.size) return;
        const available = [];
        for (const room of rooms()) {
            if (room.gameId !== gameId) continue;
            const remaining = capacity(room) - count(room);
            if (remaining > 0) available.push({ room, remaining, size: room.published.info[0x66] - remaining });
        }
        for (const ticket of queue) {
            if (ticket.until <= now) {
                close(ticket, now);
                continue;
            }
            let best;
            for (const candidate of available) {
                if (candidate.remaining <= 0 || !matches(candidate.room, ticket.criteria)) continue;
                if (!best || candidate.size > best.size || (candidate.size === best.size && candidate.room.code < best.room.code))
                    best = candidate;
            }
            if (!best) continue;
            best.remaining--;
            best.size++;
            const { room } = best;
            removeFromQueue(ticket);
            if (!holdsByRoom.has(room)) holdsByRoom.set(room, new Set());
            holdsByRoom.get(room).add(ticket);
            ticket.room = room;
            ticket.identity = groupIdentity(room.published.info);
            ticket.state = STATUS.ASSIGNED;
            ticket.until = now + holdMs;
        }
    }

    function expire(ticket, now) {
        if (ticket.until > now) return false;
        if (ticket.state === STATUS.CLOSED) {
            tickets.delete(ticket.key);
            changeCount(retainedByIp, ticket.ownerIp, -1);
        } else {
            close(ticket, now);
        }
        return true;
    }

    function sweep() {
        const now = performance.now();
        const affected = new Set();
        for (const ticket of tickets.values()) {
            const held = ticket.state === STATUS.ASSIGNED;
            if (expire(ticket, now) && held) affected.add(ticket.criteria.gameId);
        }
        for (const gameId of affected) allocate(gameId, now);
    }

    function result(ticket, now) {
        return { state: ticket.state, ttl: Math.max(0, Math.ceil(ticket.until - now)), room: ticket.room };
    }

    function poll(body, ip) {
        const criteria = request(body);
        if (!criteria) return { error: 'invalid' };
        const now = performance.now();
        let ticket = tickets.get(criteria.ticket);
        if (ticket) {
            if (ticket.ownerIp !== ip) return { error: 'missing' };
            const held = ticket.state === STATUS.ASSIGNED;
            if (expire(ticket, now) && held) allocate(ticket.criteria.gameId, now);
            if (ticket.criteria && ticket.criteria.signature !== criteria.signature) return { error: 'invalid' };
            return result(ticket, now);
        }
        if (!canRetain(ip) || (activeByIp.get(ip) ?? 0) >= perIpLimit ||
            (queueByGame.get(criteria.gameId)?.size ?? 0) >= maxWaitingPerGame) return { error: 'busy' };
        ticket = { key: criteria.ticket, criteria, ownerIp: ip, state: STATUS.WAITING, until: now + waitMs, room: null };
        retain(ticket);
        changeCount(activeByIp, ip, 1);
        if (!queueByGame.has(criteria.gameId)) queueByGame.set(criteria.gameId, new Set());
        queueByGame.get(criteria.gameId).add(ticket);
        allocate(criteria.gameId, now);
        return result(ticket, now);
    }

    function cancel(body, ip) {
        const id = key(body);
        if (!id) return { error: 'invalid' };
        const now = performance.now();
        let ticket = tickets.get(id);
        if (ticket && ticket.ownerIp !== ip) return { error: 'missing' };
        if (!ticket) {
            if (!canRetain(ip)) return { error: 'busy' };
            // A cancellation may overtake the reserve request on a second TCP connection.
            ticket = { key: id, ownerIp: ip, state: STATUS.CLOSED, until: now + tombstoneMs, room: null };
            retain(ticket);
        } else if (ticket.state === STATUS.ASSIGNED || ticket.state === STATUS.WAITING) {
            close(ticket, now);
            allocate(ticket.criteria.gameId, now);
        }
        return result(ticket, now);
    }

    function claim(body, room, version, features, ip) {
        const ticket = tickets.get(key(body));
        const now = performance.now();
        if (!ticket || ticket.ownerIp !== ip) return { error: 'missing' };
        const held = ticket.state === STATUS.ASSIGNED;
        if (expire(ticket, now)) {
            if (held) allocate(ticket.criteria.gameId, now);
            return { error: 'missing' };
        }
        // Transport capabilities negotiated after RESERVE do not change the
        // network the game requested. Only NET13 belongs to match identity.
        const networkFeatures = features & NET13;
        if (ticket.state === STATUS.JOINED && ticket.member.room === room && ticket.claimVersion === version &&
            ticket.criteria.features === networkFeatures) return { member: ticket.member };
        if (!held || ticket.room !== room || ticket.criteria.features !== networkFeatures) return { error: 'missing' };
        if (capacity(room) <= 0 || !matches(room, ticket.criteria) || !ticket.identity.equals(groupIdentity(room.published.info))) {
            close(ticket, now);
            allocate(ticket.criteria.gameId, now);
            return { error: 'missing' };
        }
        if (hostVersion(room.published.info) !== version) {
            close(ticket, now);
            allocate(ticket.criteria.gameId, now);
            return { error: 'version' };
        }
        return { ticket };
    }

    function commit(ticket, member, version) {
        deactivate(ticket);
        ticket.state = STATUS.JOINED;
        ticket.until = performance.now() + joinedMs;
        ticket.member = member;
        ticket.claimVersion = version;
        joinedByMember.set(member, ticket);
    }

    function roomChanged(room) {
        const now = performance.now();
        let remaining = capacity(room);
        const identity = remaining > 0 ? groupIdentity(room.published.info) : null;
        const previous = roomAvailability.get(room);
        const changed = !previous || previous.capacity !== remaining ||
            (identity ? !previous.identity?.equals(identity) : !!previous.identity);
        roomAvailability.set(room, { capacity: remaining, identity });
        let released = false;
        for (const ticket of holdsByRoom.get(room) ?? []) {
            if (ticket.until <= now || remaining === 0 || !matches(room, ticket.criteria) || !ticket.identity.equals(identity)) {
                close(ticket, now);
                released = true;
            } else {
                remaining--;
            }
        }
        if (changed || released) allocate(room.gameId, now);
    }

    function memberLeft(member) {
        const ticket = joinedByMember.get(member);
        if (ticket) close(ticket, performance.now());
    }

    function drain() {
        const now = performance.now();
        for (const ticket of tickets.values()) {
            if (ticket.state === STATUS.WAITING || ticket.state === STATUS.ASSIGNED) close(ticket, now);
        }
    }

    return { poll, cancel, claim, commit, count, sweep, roomChanged, memberLeft, drain };
}

module.exports = { create, STATUS, discoveryRequest, matches };
