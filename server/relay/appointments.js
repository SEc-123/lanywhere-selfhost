'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PAGE = 6, REQUEST_BYTES = 56, RESPONSE_BYTES = 264;
const MAX_EVENTS = 2048, MAX_PER_EVENT = 512, MAX_READY = 20000, MAX_PENDING = 64;
const MAX_STATE_BYTES = 2 * 1024 * 1024, MAX_AHEAD = 7 * 24 * 60 * 60, GRACE = 2 * 60 * 60;
const READY_BEFORE = 30 * 60, READY_LEASE = 5 * 60;
const U64_MAX = (1n << 64n) - 1n;
const STATUS = { OK: 0, UNAVAILABLE: 1, INVALID: 2, LIMIT: 3, NOT_FOUND: 4, STORAGE: 5 };

function parse(body) {
    if (!Buffer.isBuffer(body) || body.length !== REQUEST_BYTES || body[1] || body[2] || body[3]) return null;
    const op = body[0], offset = body.readUInt32LE(4), rawIdentity = body.subarray(8, 24);
    const id = body.readBigUInt64LE(24), starts = body.readBigUInt64LE(32), game = body.readBigUInt64LE(40), app = body.readBigUInt64LE(48);
    if (op < 1 || op > 4 || rawIdentity.every(x => x === 0)) return null;
    // A hash is held in memory only, for the life of a five-minute readiness lease.
    const identity = crypto.createHash('sha256').update('lanywhere-ready-v2\0').update(rawIdentity).digest('hex').slice(0,32);
    if (op === 1 && (id || starts || game || app)) return null;
    if (op === 2 && (offset || id || !starts || !game || game === U64_MAX)) return null;
    if (op >= 3 && (offset || !id || starts || game || app)) return null;
    return { op, offset, identity, id, starts, game, app };
}
function response(status, now, rows = [], next = 0xffffffff) {
    const b = Buffer.alloc(RESPONSE_BYTES);
    b.writeUInt32LE(status, 0); b.writeUInt32LE(rows.length, 4); b.writeUInt32LE(next, 8);
    b.writeBigUInt64LE(BigInt(now), 16);
    rows.forEach((r, i) => { const p = 24 + i * 40;
        b.writeBigUInt64LE(BigInt(r.id), p); b.writeBigUInt64LE(BigInt(r.starts), p + 8);
        b.writeBigUInt64LE(BigInt(r.game), p + 16); b.writeBigUInt64LE(BigInt(r.app), p + 24);
        b.writeUInt32LE(r.interested, p + 32); b[p + 36] = r.ready ? 1 : 0;
    });
    return b;
}
function validate(input) {
    if (!input || ![1,2].includes(input.version) || !Array.isArray(input.events) || input.events.length > MAX_EVENTS) throw Error('invalid appointments state');
    const events = [], ids = new Set(), combinations = new Set();
    for (const x of input.events) {
        if (!x || typeof x.id !== 'string' || typeof x.starts !== 'string' || typeof x.game !== 'string' || typeof x.app !== 'string' ||
            !/^[1-9][0-9]*$/.test(x.id) || !/^[1-9][0-9]*$/.test(x.starts) ||
            !/^[1-9][0-9]*$/.test(x.game) || !/^(?:0|[1-9][0-9]*)$/.test(x.app) ||
            (input.version === 1 && !Array.isArray(x.followers)) ||
            (input.version === 2 && Object.keys(x).some(k => !['id','starts','game','app'].includes(k)))) throw Error('invalid appointment');
        const id = BigInt(x.id), starts = BigInt(x.starts), game = BigInt(x.game), app = BigInt(x.app);
        const combination = `${x.starts}:${x.game}:${x.app}`;
        if (id > U64_MAX || starts > BigInt(Number.MAX_SAFE_INTEGER) || game >= U64_MAX || app > U64_MAX || ids.has(x.id) || combinations.has(combination)) throw Error('invalid appointment identity');
        ids.add(x.id); combinations.add(combination);
        // Ignore all legacy follower data; even hashed IDs must not survive migration.
        events.push({ id:x.id, starts:x.starts, game:x.game, app:x.app });
    }
    return events;
}
function load(filename) {
    let fd;
    try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (e) { if (e.code === 'ENOENT' && fs.statSync(path.dirname(filename)).isDirectory()) return {events:[], migrate:false}; throw e; }
    try {
        const st = fs.fstatSync(fd); if (!st.isFile() || st.size > MAX_STATE_BYTES) throw Error('invalid appointments file');
        const bytes = Buffer.alloc(st.size + 1); const n = fs.readSync(fd, bytes, 0, bytes.length, 0);
        if (n !== st.size) throw Error('appointments changed while reading');
        const state = JSON.parse(bytes.subarray(0,n).toString('utf8'));
        return {events:validate(state), migrate:state.version === 1};
    } finally { fs.closeSync(fd); }
}
async function save(filename, events, connected) {
    const content = Buffer.from(JSON.stringify({version:2,events}) + '\n');
    if (content.length > MAX_STATE_BYTES) throw Error('appointments storage budget exceeded');
    const dir = path.dirname(filename), tmp = path.join(dir, `.${path.basename(filename)}.${crypto.randomBytes(8).toString('hex')}.tmp`); let made = false;
    try {
        if (!connected()) return false;
        const fd = await fs.promises.open(tmp, 'wx', 0o600); made = true;
        try { await fd.writeFile(content); await fd.sync(); } finally { await fd.close(); }
        if (!connected()) return false;
        await fs.promises.rename(tmp, filename); made = false;
        const d = await fs.promises.open(dir, 'r'); try { await d.sync(); } finally { await d.close(); }
        return true;
    } finally { if (made) await fs.promises.rm(tmp, {force:true}); }
}
function create({ filename, now = () => Math.floor(Date.now() / 1000) }) {
    let events = [], healthy = true, pending = 0, needsMigration = false;
    const ready = new Map(); // hash -> {id, expires}; never persisted, one event per device
    let readyTimer;
    try { const loaded = load(filename); events = loaded.events; needsMigration = loaded.migrate; } catch { healthy = false; }
    const startup = needsMigration ? save(filename,events,()=>true).catch(() => { healthy = false; }) : Promise.resolve();
    let tail = startup;
    function sweep(current) { for (const [key, value] of ready) if (value.expires <= current) ready.delete(key); }
    function scheduleSweep(current) {
        clearTimeout(readyTimer); readyTimer = undefined;
        let earliest = Infinity;
        for (const value of ready.values()) earliest = Math.min(earliest,value.expires);
        if (earliest !== Infinity) {
            readyTimer = setTimeout(() => { const time = now(); sweep(time); scheduleSweep(time); }, Math.max(1,earliest-current)*1000);
            readyTimer.unref();
        }
    }
    function listing(req, current) {
        sweep(current);
        const counts = new Map(); for (const r of ready.values()) counts.set(r.id, (counts.get(r.id) || 0) + 1);
        const own = ready.get(req.identity)?.id;
        const sorted = events.filter(e => Number(e.starts) + GRACE > current).sort((a,b) =>
            Number(b.id === own) - Number(a.id === own) ||
            Number(BigInt(a.starts)-BigInt(b.starts)) || (BigInt(a.id)<BigInt(b.id)?-1:1));
        const offset = req.op === 1 ? req.offset : 0;
        const page = sorted.slice(offset,offset+PAGE).map(e => ({...e, interested:counts.get(e.id) || 0, ready:e.id === own}));
        return response(STATUS.OK,current,page,offset+page.length < sorted.length ? offset+page.length : 0xffffffff);
    }
    async function mutate(req, connected) {
        if (!connected()) return null;
        const current = now();
        if (!Number.isSafeInteger(current) || current < 0) return response(STATUS.STORAGE, 0);
        if (!healthy) return response(STATUS.STORAGE, current);
        sweep(current);
        const live = events.filter(e => Number(e.starts) + GRACE > current);
        if (req.op === 2) {
            const event = live.find(e => e.starts === req.starts.toString() && e.game === req.game.toString() && e.app === req.app.toString());
            if (!event) {
                if (req.starts < BigInt(current) || req.starts > BigInt(current + MAX_AHEAD)) return response(STATUS.INVALID,current);
                if (live.length >= MAX_EVENTS) return response(STATUS.LIMIT,current);
                let id; do { id = crypto.randomBytes(8).readBigUInt64LE().toString(); } while (id === '0' || live.some(e => e.id === id));
                live.push({id, starts:req.starts.toString(), game:req.game.toString(), app:req.app.toString()});
                try { if (!await save(filename,live,connected)) return null; events = live; }
                catch { healthy = false; return response(STATUS.STORAGE,current); }
            }
        } else {
            const event = live.find(e => e.id === req.id.toString());
            if (!event) return response(STATUS.NOT_FOUND,current);
            if (req.op === 3) {
                const starts = Number(event.starts);
                if (current < starts - READY_BEFORE) return response(STATUS.INVALID,current);
                const previous = ready.get(req.identity);
                const count = [...ready.values()].filter(r => r.id === event.id).length;
                if ((!previous && ready.size >= MAX_READY) || (previous?.id !== event.id && count >= MAX_PER_EVENT)) return response(STATUS.LIMIT,current);
                ready.set(req.identity, {id:event.id, expires:Math.min(current + READY_LEASE, starts + GRACE)});
                scheduleSweep(current);
            } else if (ready.get(req.identity)?.id === event.id) { ready.delete(req.identity); scheduleSweep(current); }
        }
        return listing(req,current);
    }
    function handle(body, available = true, connected = () => true) {
        const current = now();
        if (!Number.isSafeInteger(current) || current < 0) return Promise.resolve(response(STATUS.STORAGE, 0));
        if (!available) return Promise.resolve(response(STATUS.UNAVAILABLE, current));
        const req = parse(body); if (!req) return Promise.resolve(response(STATUS.INVALID, current));
        if (req.op === 1) return startup.then(() => healthy ? listing(req,now()) : response(STATUS.STORAGE,current));
        if (pending >= MAX_PENDING) return Promise.resolve(response(STATUS.LIMIT,current));
        pending++;
        const operation = tail.then(() => mutate(req,connected));
        tail = operation.catch(() => { healthy = false; return null; }).finally(() => { pending--; });
        return operation.catch(() => response(STATUS.STORAGE, current));
    }
    return { handle };
}
module.exports = { create, parse, response, validateState: validate, STATUS };
