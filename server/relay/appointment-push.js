'use strict';

const crypto = require('node:crypto');
const { RECORD_BYTES } = require('./room-metadata');

const CAPABILITY = 4096, SUBSCRIBE = 0x29, PUSH = 0xa9;
const MAX_APPOINTMENTS = 25, REQUEST_BYTES = 8 + MAX_APPOINTMENTS * 8;
const REPLY_BYTES = 24 + RECORD_BYTES;
const MAX_SUBSCRIBERS = 256, MAX_PER_IP = 4, PUSH_QUEUE_LIMIT = 32 * 1024;
const SESSION_START = 16, SESSION_END = 32;
const U64_MAX = (1n << 64n) - 1n;

function parse(body) {
    if (body.length !== REQUEST_BYTES || body.readUInt32LE(4)) return null;
    const count = body.readUInt32LE(0);
    if (count > MAX_APPOINTMENTS || body.subarray(8 + count * 8).some(Boolean)) return null;
    const ids = new Set();
    for (let i = 0; i < count; i++) {
        const id = body.readBigUInt64LE(8 + i * 8);
        if (!id || ids.has(id)) return null;
        ids.add(id);
    }
    return ids;
}

function packet(time, eventId = 0n, deliveryId = 0n, row) {
    const body = Buffer.alloc(REPLY_BYTES);
    body.writeBigUInt64LE(BigInt(time), 0);
    body.writeBigUInt64LE(eventId, 8);
    body.writeBigUInt64LE(deliveryId, 16);
    if (row) row.copy(body, 24);
    return body;
}

function create({ rooms, isEligible, applicationId, summarize, activeAppointment, send,
                  now = () => Math.floor(Date.now() / 1000) }) {
    const subscribers = new Map(), perIp = new Map();
    const available = new Map(), byGame = new Map();
    let nextDelivery = crypto.randomBytes(8).readBigUInt64LE();
    let pending = null;
    let stopped = false;

    function close(socket) {
        const subscriber = subscribers.get(socket);
        if (!subscriber) return;
        subscribers.delete(socket);
        const remaining = perIp.get(subscriber.ip) - 1;
        if (remaining) perIp.set(subscriber.ip, remaining);
        else perIp.delete(subscriber.ip);
    }

    function write(socket, body) {
        if (send(socket, PUSH, body)) return true;
        close(socket);
        return false;
    }

    function removeRoom(room) {
        if (!available.delete(room)) return;
        const gameRooms = byGame.get(room.gameId);
        gameRooms.delete(room);
        if (!gameRooms.size) byGame.delete(room.gameId);
    }

    function dispatch(socket, subscriber, time) {
        for (const [room, delivery] of subscriber.delivered) {
            if (available.get(room)?.delivery !== delivery) subscriber.delivered.delete(room);
        }
        // Resolve IDs on the server and group once per game, even if the player
        // joined several overlapping appointments for that game.
        const events = new Map(), games = new Map();
        for (const id of subscriber.ids) {
            const event = activeAppointment(id, time);
            if (!event) continue;
            events.set(id, event);
            if (!games.has(event.game)) games.set(event.game, { first: id, byApp: new Map() });
            const group = games.get(event.game);
            if (!group.byApp.has(event.app)) group.byApp.set(event.app, id);
        }
        for (const [game, group] of games) {
            for (const room of byGame.get(game) || []) {
                if (subscriber.delivered.has(room)) continue;
                const { delivery, app, bound } = available.get(room);
                let id;
                if (bound) {
                    const exact = events.get(bound);
                    if (exact?.game === game && (!app || !exact.app || app === exact.app)) id = bound;
                } else if (!app) {
                    id = group.first;
                } else {
                    id = group.byApp.get(app) ?? group.byApp.get(0n);
                }
                if (!id || !isEligible(room)) continue;
                // The next shared sweep can resume a large snapshot after
                // the socket drains. Never accumulate an unbounded queue.
                if (socket.writableLength >= PUSH_QUEUE_LIMIT) return;
                if (!write(socket, packet(time, id, delivery, summarize(room)))) return;
                subscriber.delivered.set(room, delivery);
            }
        }
    }

    function queueDispatch() {
        if (stopped || pending || !subscribers.size) return;
        pending = setImmediate(() => {
            pending = null;
            const time = now();
            for (const [socket, subscriber] of subscribers) dispatch(socket, subscriber, time);
        });
        pending.unref();
    }

    function roomChanged(room, notify = true) {
        if (stopped) return;
        const previous = available.get(room);
        if (!isEligible(room)) {
            if (previous) {
                removeRoom(room);
                if (notify) queueDispatch();
            }
            return;
        }
        const session = room.published.info.subarray(SESSION_START, SESSION_END);
        const app = applicationId(room), bound = room.published.appointmentId || 0n;
        if (previous?.session.equals(session)) {
            if (previous.app !== app || previous.bound !== bound) {
                previous.app = app;
                previous.bound = bound;
                if (notify) queueDispatch();
            }
            return;
        }
        nextDelivery = (nextDelivery + 1n) & U64_MAX || 1n;
        available.set(room, { delivery: nextDelivery, session: Buffer.from(session), app, bound });
        if (!byGame.has(room.gameId)) byGame.set(room.gameId, new Set());
        byGame.get(room.gameId).add(room);
        if (notify) queueDispatch();
    }

    function repair() {
        for (const room of available.keys()) {
            if (!isEligible(room)) removeRoom(room);
        }
        for (const room of rooms()) roomChanged(room, false);
    }

    function subscribe(socket, ip, ids) {
        if (stopped) return false;
        let subscriber = subscribers.get(socket);
        if (!subscriber) {
            if (subscribers.size >= MAX_SUBSCRIBERS || (perIp.get(ip) || 0) >= MAX_PER_IP) return false;
            subscriber = { ip, ids, delivered: new Map() };
            subscribers.set(socket, subscriber);
            perIp.set(ip, (perIp.get(ip) || 0) + 1);
        }
        subscriber.ids = ids;
        const time = now();
        if (write(socket, packet(time))) {
            repair();
            dispatch(socket, subscriber, time);
        }
        return true;
    }

    // Direct mutation hooks handle room changes. This shared sweep opens
    // appointment time windows and repairs edge transitions once per second.
    function rescan() {
        if (stopped) return;
        repair();
        queueDispatch();
    }
    const timer = setInterval(() => {
        if (subscribers.size) rescan();
    }, 1000).unref();

    function shutdown() {
        stopped = true;
        clearInterval(timer);
        if (pending) clearImmediate(pending);
        for (const socket of subscribers.keys()) socket.end();
        subscribers.clear();
        perIp.clear();
        available.clear();
        byGame.clear();
    }

    return { subscribe, roomChanged, rescan, close, shutdown, has: socket => subscribers.has(socket) };
}

module.exports = { create, parse, CAPABILITY, SUBSCRIBE, PUSH, REQUEST_BYTES };
