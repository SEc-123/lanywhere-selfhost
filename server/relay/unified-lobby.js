'use strict';

const { performance } = require('node:perf_hooks');
const { RECORD_BYTES } = require('./room-metadata');
const { PAGE_SIZE, END } = require('./group-page');
const { COMMUNITY_MATCH } = require('./regional-directory');

const HEADER_BYTES = 12, ROW_BYTES = RECORD_BYTES + 40;
const REFRESH_MS = 25_000, SOURCE_MAX_AGE_MS = 75_000, SNAPSHOT_MAX_AGE_MS = 30_000;
const MAX_SNAPSHOTS = 4, PARALLEL_QUERIES = 2, SAMPLE_INTERVAL_MS = 250;

function create({ providerIds, queryProvider, selfRows, regional, community, now = () => performance.now() }) {
    const sources = new Map();
    const views = Array.from({ length: 4 }, () => ({ snapshots: new Map(), latest: null, lastSample: -Infinity }));
    let refreshing = false, nextRefresh = 0, generation = 0, closed = false;
    let nextCommunityRefresh = 0, refreshingCommunity = false;
    let regionalSource = null, nextRegionalRefresh = 0, refreshingRegional = false;
    const otherProviders = providerIds.filter(id => id !== community?.source);
    const total = 1 + providerIds.length;

    async function refreshProvider(provider) {
        let rows;
        try { rows = await queryProvider(provider); } catch { rows = null; }
        if (closed) return;
        if (!rows) {
            sources.delete(provider);
            return;
        }
        const source = { time: now(), rows: rows.map(row => pack(row, provider)) };
        if (community?.source === provider) {
            // The direct client requires a resolved LCID. Keep legacy sentinel
            // rooms reachable through their existing compatibility route.
            source.directRows = rows.map((row, i) => row.readBigUInt64LE(8) === 0xffffffffffffffffn ?
                source.rows[i] : pack(row, community.provider, community.endpoint.wire));
        }
        sources.set(provider, source);
    }

    function refresh(time) {
        if (closed || refreshing || !otherProviders.length || time < nextRefresh) return;
        refreshing = true;
        let cursor = 0;
        async function worker() {
            while (!closed && cursor < otherProviders.length) await refreshProvider(otherProviders[cursor++]);
        }
        void Promise.all(Array.from({ length: Math.min(PARALLEL_QUERIES, otherProviders.length) }, worker))
            .finally(() => { refreshing = false; nextRefresh = now() + REFRESH_MS; });
    }

    function refreshCommunity(time) {
        if (!community || closed || refreshingCommunity || time < nextCommunityRefresh) return;
        refreshingCommunity = true;
        void refreshProvider(community.source)
            .finally(() => { refreshingCommunity = false; nextCommunityRefresh = now() + REFRESH_MS; });
    }

    function refreshRegional(time) {
        if (!regional || closed || refreshingRegional || time < nextRegionalRefresh) return;
        refreshingRegional = true;
        void regional.query().then(rows => {
            if (closed) return;
            regionalSource = rows ? { time: now(), rows: rows.map(row => pack(row, regional.provider, regional.endpoint.wire)) } : null;
        }, () => { regionalSource = null; })
            .finally(() => { refreshingRegional = false; nextRegionalRefresh = now() + REFRESH_MS; });
    }

    function pack(summary, provider, endpoint) {
        const row = Buffer.alloc(ROW_BYTES);
        summary.copy(row, 0);
        row.write(provider, RECORD_BYTES, 32, 'ascii');
        if (endpoint) endpoint.copy(row, RECORD_BYTES + 33);
        return row;
    }

    function generationAt(time, view, includeRegion, includeCommunity) {
        const { latest, snapshots } = view;
        if (latest && snapshots.has(latest.id) && time - view.lastSample < SAMPLE_INTERVAL_MS) return latest;
        view.lastSample = time;
        const own = selfRows().map(row => pack(row, 'self'));
        const rows = [...own];
        let available = 1, communityReady = false;
        for (const provider of providerIds) {
            const source = sources.get(provider);
            if (!source || time - source.time > SOURCE_MAX_AGE_MS) continue;
            available++;
            const direct = includeCommunity && source.directRows;
            if (direct) communityReady = true;
            rows.push(...(direct || source.rows));
        }
        if (includeRegion && regionalSource && time - regionalSource.time <= SOURCE_MAX_AGE_MS) {
            available++;
            rows.push(...regionalSource.rows);
        }
        rows.sort((a, b) => {
            const ga = a.readBigUInt64LE(8), gb = b.readBigUInt64LE(8);
            return (ga === gb ? 0 : ga < gb ? -1 : 1) ||
                b[32] - a[32] || Buffer.compare(a.subarray(RECORD_BYTES), b.subarray(RECORD_BYTES)) ||
                Buffer.compare(a.subarray(0, 6), b.subarray(0, 6));
        });
        const same = latest && snapshots.has(latest.id) && latest.available === available && latest.communityReady === communityReady &&
            latest.rows.length === rows.length && latest.rows.every((row, i) => row.equals(rows[i]));
        if (same) return latest;
        do { generation = (generation + 1) >>> 0; }
        while (!generation || views.some(view => view.snapshots.has(generation)));
        view.latest = { id: generation, time, available, communityReady, rows };
        snapshots.set(generation, view.latest);
        if (snapshots.size > MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value);
        return view.latest;
    }

    function page(offset, id, { includeRegion = false, includeCommunity = false, flags = 0 } = {}) {
        const time = now();
        const view = views[(includeRegion ? 1 : 0) | (includeCommunity ? 2 : 0)];
        const { snapshots } = view;
        for (const [key, snapshot] of snapshots)
            if (time - snapshot.time > SNAPSHOT_MAX_AGE_MS) snapshots.delete(key);
        refresh(time);
        refreshCommunity(time);
        if (includeRegion) refreshRegional(time);
        const snapshot = id ? snapshots.get(id) : generationAt(time, view, includeRegion, includeCommunity);
        const head = Buffer.alloc(HEADER_BYTES);
        head.writeUInt32LE(END, 4);
        head[10] = total + (includeRegion && regional ? 1 : 0);
        head[11] = flags | (snapshot?.communityReady ? COMMUNITY_MATCH : 0);
        if (!snapshot || offset > snapshot.rows.length) {
            head[11] |= 1;
            return head;
        }
        const rows = snapshot.rows.slice(offset, offset + PAGE_SIZE);
        head.writeUInt32LE(snapshot.id);
        if (offset + rows.length < snapshot.rows.length) head.writeUInt32LE(offset + rows.length, 4);
        head[8] = rows.length;
        head[9] = snapshot.available;
        return Buffer.concat([head, ...rows]);
    }

    return { page, shutdown: () => {
        closed = true;
        regional?.shutdown();
        regionalSource = null;
        sources.clear();
        for (const view of views) view.snapshots.clear();
    } };
}

module.exports = { create };
