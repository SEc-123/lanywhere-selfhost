'use strict';

const { performance } = require('node:perf_hooks');
const { RECORD_BYTES } = require('./room-metadata');
const { PAGE_SIZE, END } = require('./group-page');

const HEADER_BYTES = 12, ROW_BYTES = RECORD_BYTES + 40;
const REFRESH_MS = 25_000, SOURCE_MAX_AGE_MS = 75_000, SNAPSHOT_MAX_AGE_MS = 30_000;
const MAX_SNAPSHOTS = 4, PARALLEL_QUERIES = 2, SAMPLE_INTERVAL_MS = 250;

function create({ providerIds, queryProvider, selfRows, now = () => performance.now() }) {
    const sources = new Map(), snapshots = new Map();
    let refreshing = false, nextRefresh = 0, lastSample = -Infinity, generation = 0, latest = null, closed = false;
    const total = 1 + providerIds.length;

    function refresh(time) {
        if (closed || refreshing || !providerIds.length || time < nextRefresh) return;
        refreshing = true;
        let cursor = 0;
        async function worker() {
            while (!closed && cursor < providerIds.length) {
                const provider = providerIds[cursor++];
                let rows;
                try { rows = await queryProvider(provider); } catch { rows = null; }
                if (closed) return;
                if (rows) sources.set(provider, { time: now(), rows: rows.map(row => pack(row, provider)) });
                else sources.delete(provider);
            }
        }
        void Promise.all(Array.from({ length: Math.min(PARALLEL_QUERIES, providerIds.length) }, worker))
            .finally(() => { refreshing = false; nextRefresh = now() + REFRESH_MS; });
    }

    function pack(summary, provider) {
        const row = Buffer.alloc(ROW_BYTES);
        summary.copy(row, 0);
        row.write(provider, RECORD_BYTES, 32, 'ascii');
        return row;
    }

    function generationAt(time) {
        if (latest && snapshots.has(latest.id) && time - lastSample < SAMPLE_INTERVAL_MS) return latest;
        lastSample = time;
        const own = selfRows().map(row => pack(row, 'self'));
        const rows = [...own];
        let available = 1;
        for (const provider of providerIds) {
            const source = sources.get(provider);
            if (!source || time - source.time > SOURCE_MAX_AGE_MS) continue;
            available++;
            rows.push(...source.rows);
        }
        rows.sort((a, b) => {
            const ga = a.readBigUInt64LE(8), gb = b.readBigUInt64LE(8);
            return (ga === gb ? 0 : ga < gb ? -1 : 1) ||
                b[32] - a[32] || Buffer.compare(a.subarray(RECORD_BYTES), b.subarray(RECORD_BYTES)) ||
                Buffer.compare(a.subarray(0, 6), b.subarray(0, 6));
        });
        const same = latest && snapshots.has(latest.id) && latest.available === available &&
            latest.rows.length === rows.length && latest.rows.every((row, i) => row.equals(rows[i]));
        if (same) return latest;
        do { generation = (generation + 1) >>> 0; } while (!generation || snapshots.has(generation));
        latest = { id: generation, time, available, rows };
        snapshots.set(generation, latest);
        if (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value);
        return latest;
    }

    function page(offset, id) {
        const time = now();
        for (const [key, snapshot] of snapshots)
            if (time - snapshot.time > SNAPSHOT_MAX_AGE_MS) snapshots.delete(key);
        refresh(time);
        const snapshot = id ? snapshots.get(id) : generationAt(time);
        const head = Buffer.alloc(HEADER_BYTES);
        head.writeUInt32LE(END, 4);
        head[10] = total;
        if (!snapshot || offset > snapshot.rows.length) {
            head[11] = 1;
            return head;
        }
        const rows = snapshot.rows.slice(offset, offset + PAGE_SIZE);
        head.writeUInt32LE(snapshot.id);
        if (offset + rows.length < snapshot.rows.length) head.writeUInt32LE(offset + rows.length, 4);
        head[8] = rows.length;
        head[9] = snapshot.available;
        return Buffer.concat([head, ...rows]);
    }

    return { page, shutdown: () => { closed = true; sources.clear(); snapshots.clear(); } };
}

module.exports = { create };
