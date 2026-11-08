'use strict';

// Explicit, allowlisted LANywhere legacy upstreams. This is not a generic proxy.
const net = require('node:net');
const dgram = require('node:dgram');
const crypto = require('node:crypto');
const { parse: parseMetadata, RECORD_BYTES } = require('./room-metadata');
const streamProtocol = require('./tcp-stream-protocol');
const MAGIC = 0x594e414c;
const SELECT = 0x20, SELECTED = 0xa0, CAPS = 0x0b;
const PUBLIC_PROVIDERS = Object.freeze([{ id: 'lanywhere-public', host: '129.38.114.182', port: 11460, maxConnections: 8, connectTimeoutMs: 8000, adapterMetadata: true }]);
const codeValid = b => b.length === 6 && /^[A-HJ-NP-Z2-9]{6}$/.test(b.toString('latin1'));
const publicIp = socket => (socket.remoteAddress || '').replace(/^::ffff:/, '');
const virtualIp = ip => ((ip >>> 16) === 0x0a0d && (ip & 0xffff) !== 0 && (ip & 0xffff) !== 0xffff) ||
    ((ip >>> 8) === 0x0a7200 && (ip & 255) >= 1 && (ip & 255) <= 8);

function createDiagnostics({ providerIds = [], emit = () => {}, count = () => {}, now = Date.now, logIntervalMs = 10000 } = {}) {
    if (!Array.isArray(providerIds) || providerIds.length > 128 || providerIds.some(id => !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)))
        throw Error('Invalid diagnostic provider set');
    const ids = new Set(providerIds), reasons = new Set(['capacity','busy','rate_limited','backpressure','timeout',
        'startup_timeout','upstream_unavailable','disabled','paused','protocol_error','request_rejected',
        'transport_limit','unexpected_exit','process_error','query_cache_recycled']);
    const counters = new Map();
    function record(event = {}) {
        const provider = ids.has(event.provider) ? event.provider : 'unknown';
        const reason = reasons.has(event.reason) ? event.reason : 'other_error';
        const code = Number.isInteger(event.code) && event.code >= 0 && event.code <= 255 ? event.code : 0;
        const key = provider + ':' + reason, time = now();
        let value = counters.get(key);
        if (!value) counters.set(key, value = {provider, reason, events: 0, lastAt: time, lastCode: code, lastLogAt: null});
        value.events = Math.min(Number.MAX_SAFE_INTEGER, value.events + 1); value.lastAt = time; value.lastCode = code;
        count(reason);
        if (value.lastLogAt === null || time - value.lastLogAt >= logIntervalMs) {
            value.lastLogAt = time;
            // Deliberately omit upstream messages, player IPs, tokens and room identifiers.
            emit({provider, reason, code, events: value.events});
        }
    }
    return { record, snapshot: () => [...counters.values()].map(({lastLogAt, ...value}) => value) };
}

function create({ providers = [], send, sendUdp, isLocalToken = () => false, count = () => {}, onEvent = () => {},
    selfCapabilities = () => 63, paused = () => false, draining = () => false, bindAddress = '0.0.0.0',
    connectTimeoutMs = 3000, queryTimeoutMs = 2500, graceMs = 55000, maxTokens = 512, dataBytes = 512 * 1024, dataPackets = 1000 }) {
    if (!net.isIPv4(bindAddress) || !Number.isInteger(graceMs) || graceMs < 1 || graceMs > 60000) throw Error('Invalid upstream gateway limits');
    const registry = new Map();
    for (const p of providers) {
        if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(p.id) || p.id === 'self' || registry.has(p.id) ||
            (typeof p.acquire !== 'function' && (!net.isIPv4(p.host) || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) ||
            !Number.isInteger(p.maxConnections) || p.maxConnections < 1 || p.maxConnections > 8) throw Error('Invalid allowlisted upstream');
        registry.set(p.id, { ...p, active: 0, rates: new Map() });
    }
    const capabilities = p => (p.capabilities || p.udpCaps || 0) | (p.adapterMetadata ? 64 : 0);
    const routes = new Map(), localLocked = new WeakSet(), tokens = new Map();
    let closing = false;
    const error = (front, code, text, reason, providerId) => {
        const provider = providerId || routes.get(front)?.provider?.id || 'unknown';
        const category = reason || (code === 13 ? 'timeout' : code === 11 ? 'upstream_unavailable' :
            code === 7 ? (/rate/.test(text) ? 'rate_limited' : /capacity|limit/.test(text) ? 'capacity' : 'busy') :
            code === 6 ? 'paused' : code === 10 ? 'transport_limit' : code === 4 ? 'protocol_error' : 'request_rejected');
        onEvent({ provider, reason: category, code });
        send(front, 0x85, Buffer.concat([Buffer.from([code]), Buffer.from(text)]));
    };
    const selected = (front, id, caps) => { const b = Buffer.alloc(5); b.writeUInt32LE(caps); b[4] = id.length; send(front, SELECTED, Buffer.concat([b, Buffer.from(id)])); };
    const active = r => r && r.ready && !r.closed && !r.front.destroyed && !r.front.writableEnded;
    function unsupported(record, text) {
        const now = Date.now();
        if (!record.warnedAt || now - record.warnedAt >= 1000) {
            record.warnedAt = now; error(record.route.front, 10, text);
        }
    }
    function quota(p, kind) {
        const minute = Math.floor(Date.now() / 60000), limits = { create: 10, join: 30, find: 120 };
        let b = p.rates.get(kind);
        if (!b || b.minute !== minute) p.rates.set(kind, b = { minute, count: 0 });
        return ++b.count <= limits[kind];
    }
    function rate(record, bytes, direction) {
        const second = Math.floor(Date.now() / 1000), key = direction + 'Rate';
        let r = record[key];
        if (!r || r.second !== second) record[key] = r = { second, bytes: 0, packets: 0 };
        r.bytes += bytes + 28; r.packets++;
        return r.bytes <= dataBytes && r.packets <= dataPackets;
    }
    function forget(record) {
        clearTimeout(record.expiry);
        tokens.delete(record.token);
        if (record.route?.record === record) record.route.record = null;
        record.route = null;
        record.claim = null;
        record.metadata = null;
        record.retainedLease?.release?.();
        record.retainedLease = null;
    }
    function close(route, preserve = true) {
        if (route.closed) return;
        route.closed = true; clearTimeout(route.timer); clearInterval(route.liveness); clearTimeout(route.query?.timer); route.query = null;
        route.provider.active--;
        route.tcp?.destroy();
        try { route.udp?.close(); } catch {}
        if (route.pendingRoom?.resume?.claim === route) route.pendingRoom.resume.claim = null;
        if (route.record) {
            const record = route.record; route.record = null; record.route = null; record.frontUdp = null;
            if (preserve && !closing) {
                // A retained room token protects the same realm through resume.
                record.retainedLease?.release?.();
                record.retainedLease = route.lease; route.lease = null;
                record.expiry = setTimeout(() => forget(record), graceMs).unref();
            } else forget(record);
        }
        route.lease?.release?.(); route.lease = null;
    }
    function fail(route, code = 11, text = 'upstream connection unavailable') {
        if (route.closed) return;
        error(route.front, code, text); close(route); route.front.end();
    }
    function upstreamWrite(route, type, body) {
        if (route.closed || !route.tcp || route.tcp.destroyed || route.tcp.writableLength + body.length + 3 > 128 * 1024) {
            fail(route, 7, 'upstream control queue is full'); return false;
        }
        const h = Buffer.alloc(3); h.writeUInt16LE(body.length + 1); h[2] = type;
        route.tcp.write(Buffer.concat([h, body])); if (!route.provider.localTransport) count(body.length + 55); return true;
    }
    function allocateToken() {
        for (let i = 0; i < 100; i++) {
            const token = crypto.randomBytes(4).readUInt32LE();
            if (token && !tokens.has(token) && !isLocalToken(token)) return token;
        }
        return 0;
    }
    function parseRoom(body) {
        if (body.length < 24 || !codeValid(body.subarray(0, 6)) || body[6] > 7 || !body.readUInt32LE(11) ||
            body[23] < 1 || body[23] > 8 || body.length !== 24 + body[23] * 37) return null;
        const members = new Map(), ips = new Set();
        for (let i = 0; i < body[23]; i++) {
            const at = 24 + i * 37, index = body[at], ip = body.readUInt32LE(at + 1);
            if (index > 7 || members.has(index) || !virtualIp(ip) || ips.has(ip)) return null;
            members.set(index, ip); ips.add(ip);
        }
        if (members.get(body[6]) !== body.readUInt32LE(7)) return null;
        return { code: body.subarray(0,6).toString('ascii'), index: body[6], ip: body.readUInt32LE(7),
            remoteToken: body.readUInt32LE(11), gameId: body.readBigUInt64LE(15), members };
    }
    function upstreamFrame(route, type, body) {
        const second = Math.floor(Date.now() / 1000);
        if (route.frameSecond !== second) { route.frameSecond = second; route.frameCount = 0; route.frameBytes = 0; route.streamFrames = 0; route.streamBytes = 0; }
        if (type === streamProtocol.RESPONSE) {
            route.streamFrames++; route.streamBytes += body.length + 55;
            if (route.streamFrames > dataPackets || route.streamBytes > dataBytes) return fail(route, 7, 'upstream game stream rate exceeded');
        } else {
            route.frameCount++; route.frameBytes += body.length + 3;
            if (route.frameCount > 100 || route.frameBytes > 256 * 1024) return fail(route, 7, 'upstream control rate exceeded');
        }
        route.lastFrameAt = Date.now();
        if (!route.ready) {
            if (type === 0x85 && body.length >= 1 && body[0] !== 4)
                return fail(route, [6,7,8,11,13].includes(body[0]) ? body[0] : 4, 'upstream control unavailable');
            if (!((type === 0x85 && body[0] === 4) || (type === 0x89 && body.length === 4)))
                return fail(route, 4, 'upstream did not speak supported LANywhere control');
            if (route.provider.udpCaps && (type !== 0x89 || (body.readUInt32LE() & (route.provider.capabilities || route.provider.udpCaps)) !== (route.provider.capabilities || route.provider.udpCaps)))
                return fail(route,8,'LAN Play realm lacks required UDP transport');
            route.ready = true; clearTimeout(route.timer); selected(route.front, route.provider.id, capabilities(route.provider)); return;
        }
        if (type === streamProtocol.RESPONSE) {
            if (paused()) return fail(route, 6, 'relay paused');
            const record = route.record, h = streamProtocol.parse(body);
            if (!(capabilities(route.provider) & streamProtocol.CAPABILITY) || !record || !h || h.peer === record.ip ||
                ![...record.members.values()].includes(h.peer) ||
                (h.op === streamProtocol.OP.LEGACY_READY && !(capabilities(route.provider) & streamProtocol.LEGACY_CAPABILITY)))
                return fail(route, 4, 'invalid upstream game stream');
            if (!rate(record, body.length + 27, 'down')) return fail(route, 7, 'upstream game stream budget exceeded');
            if (send(route.front, type, body) === false) close(route);
            return;
        }
        if (type === 0x81) {
            const identity = parseRoom(body), request = route.pendingRoom;
            if (!identity || !request || (request.code && request.code !== identity.code) ||
                (request.gameId && request.gameId !== identity.gameId)) return fail(route, 4, 'invalid upstream room identity');
            let record = request.resume;
            if (record) {
                if (tokens.get(record.token) !== record || record.claim !== route ||
                    record.providerId !== route.provider.id || record.code !== identity.code || record.route ||
                    record.index !== identity.index || record.ip !== identity.ip || record.gameId !== identity.gameId || record.remoteToken !== identity.remoteToken)
                    return fail(route, 5, 'upstream resume ownership changed');
                clearTimeout(record.expiry);
                record.retainedLease?.release?.(); record.retainedLease = null;
                record.claim = null;
            } else {
                if (route.record || tokens.size >= maxTokens) return fail(route, 7, 'upstream member capacity reached');
                const token = allocateToken(); if (!token) return fail(route);
                record = { token, providerId: route.provider.id }; tokens.set(token, record);
            }
            Object.assign(record, identity, { route, publicIp: publicIp(route.front), frontUdp: null, expiry: null });
            route.record = record; route.pendingRoom = null; route.discardRoomEvents = false;
            const rewritten = Buffer.from(body); rewritten.writeUInt32LE(record.token, 11); send(route.front, type, rewritten); return;
        }
        if (type === 0x85) {
            if (body.length < 1) return fail(route,4,'invalid upstream error');
            onEvent({provider: route.provider.id, code: body[0], reason:
                body[0] === 7 ? 'busy' : body[0] === 6 ? 'paused' : body[0] === 13 ? 'timeout' :
                body[0] === 11 ? 'upstream_unavailable' : body[0] === 4 ? 'protocol_error' : 'request_rejected'});
            clearTimeout(route.query?.timer); route.query = null;
            if (route.pendingRoom?.resume && body[0] === 5) forget(route.pendingRoom.resume);
            else if (route.pendingRoom?.resume?.claim === route) route.pendingRoom.resume.claim = null;
            route.pendingRoom = null;
        } else if (type === 0x82) {
            if (body.length !== 37 || body[0] > 7 || !virtualIp(body.readUInt32LE(1))) return fail(route, 4, 'invalid upstream member');
            if (!route.record) { if (route.discardRoomEvents) return; return fail(route,4,'upstream member without room'); }
            if ([...route.record.members].some(([index, ip]) => index !== body[0] && ip === body.readUInt32LE(1)))
                return fail(route,4,'duplicate upstream member address');
            route.record.members.set(body[0], body.readUInt32LE(1));
        } else if (type === 0x83) {
            if (body.length !== 1 || body[0] > 7) return fail(route, 4, 'invalid upstream departure');
            if (!route.record) { if (route.discardRoomEvents) return; return fail(route,4,'upstream departure without room'); }
            route.record.members.delete(body[0]);
            if (body[0] === route.record.index) route.record.metadata = null;
        } else if (type === 0x84) {
            if (!route.record || body.length < 2 || !route.record.members.has(body[0])) return;
        } else if (type === 0x87) {
            if (body.length < 1 || body[0] > 6 || body.length !== 1 + body[0] * (6 + 0x480)) return fail(route, 4, 'invalid upstream group list');
            if (route.provider.adapterMetadata) {
                const query = route.query;
                if (!query) return fail(route,4,'unsolicited upstream group list');
                clearTimeout(query.timer); route.query = null;
                if (query.metadata) {
                    const page = metadataPage(route, body, query.gameId);
                    if (!page) return fail(route,4,'invalid upstream group identity');
                    if (!paused()) send(route.front,0xa2,page);
                    return;
                }
            }
        } else if (type === 0x8a || type === 0xa2) {
            if (!(route.provider.capabilities & (type === 0x8a ? 2 : 64)) || body.length < 5 || body[4] > 6 ||
                body.length !== 5 + body[4] * (type === 0x8a ? 6 + 0x480 : 336)) return fail(route,4,'invalid upstream page');
        } else if (type !== 0x86 || body.length !== 0) return fail(route, 4, 'unsupported upstream response');
        if (paused() && type !== 0x85 && type !== 0x86) return;
        send(route.front, type, body);
    }
    // Local adapter declarations are attached only to a currently active proxy
    // host whose actual upstream identity matches this discovered group.
    function metadataPage(route, groups, filter) {
        const header = Buffer.alloc(5); header.writeUInt32LE(0xffffffff); header[4] = groups[0];
        const records = [];
        for (let i = 0; i < groups[0]; i++) {
            const at = 1 + i * (6 + 0x480), codeBytes = groups.subarray(at,at+6), info = groups.subarray(at+6,at+6+0x480);
            const code = codeBytes.toString('ascii'), gameId = info.readBigUInt64LE(), hostIp = info.readUInt32LE(0x68);
            if (!codeValid(codeBytes) || !gameId || (filter && filter !== gameId) || !virtualIp(hostIp) ||
                !info[0x73] || info[0x66] < 1 || info[0x66] > 8 || info[0x67] < 1 || info[0x67] > info[0x66]) return null;
            const row = Buffer.alloc(RECORD_BYTES); codeBytes.copy(row); row.writeBigUInt64LE(gameId,8);
            row[32] = info[0x67]; row[33] = info[0x66]; info.copy(row,40,0x74,0x74+32);
            const owner = [...tokens.values()].find(r => r.providerId === route.provider.id && r.code === code &&
                r.gameId === gameId && r.index === 0 && r.ip === hostIp && r.members.get(0) === hostIp && active(r.route) && r.metadata);
            if (owner) {
                const m = owner.metadata;
                row.writeBigUInt64LE(m.value.applicationId,16); row.writeBigUInt64LE(m.value.programId,24); row[34] = 1;
                row.write(m.value.en,80,127,'utf8'); row.write(m.value.zh,208,127,'utf8');
            }
            records.push(row);
        }
        return Buffer.concat([header,...records]); // Upstream exposes its first six only. Never invent another page.
    }
    function setAdapterMetadata(route, body) {
        const r = route.record, value = parseMetadata(body);
        if (!r || r.index !== 0 || r.members.get(0) !== r.ip) { error(route.front,4,'metadata requires the actual upstream room owner'); return; }
        if (!value) { error(route.front,4,'invalid room metadata'); return; }
        if (r.metadata?.raw.equals(body)) return;
        const minute = Math.floor(Date.now()/60000);
        if (!r.metadataRate || r.metadataRate.minute !== minute) r.metadataRate = {minute,n:0};
        if (++r.metadataRate.n > 4) { error(route.front,7,'room metadata rate exceeded'); return; }
        r.metadata = {value,raw:Buffer.from(body)};
    }
    function startQuery(route, metadata, gameId) {
        route.query = {metadata,gameId,timer:setTimeout(()=>fail(route,13,'upstream discovery timed out'),queryTimeoutMs).unref()};
    }
    async function begin(front, provider) {
        if (provider.active >= provider.maxConnections || closing) { error(front, 7, 'upstream shared connection limit reached', 'capacity', provider.id); return; }
        provider.active++;
        const route = { front, provider, ready: false, closed: false, record: null, pendingRoom: null };
        routes.set(front, route);
        route.timer = setTimeout(() => fail(route, 13, 'upstream handshake timed out'), provider.connectTimeoutMs || connectTimeoutMs).unref();
        let endpoint;
        try { endpoint = provider.acquire ? await provider.acquire() : provider; }
        catch (error) { return fail(route, error.code === 'REALM_CAPACITY' ? 7 : error.code === 'UPSTREAM_TIMEOUT' ? 13 : 11,
            error.code === 'REALM_CAPACITY' ? 'LAN Play community capacity reached' : error.code === 'UPSTREAM_TIMEOUT' ? 'LAN Play upstream startup timed out' : 'LAN Play upstream not reachable'); }
        if (route.closed) { endpoint.release?.(); return; }
        route.lease = endpoint;
        const tcp = route.tcp = net.createConnection({ host: endpoint.host, port: endpoint.port,
            ...(provider.localTransport || bindAddress === '0.0.0.0' ? {} : { localAddress: bindAddress }) });
        const udp = route.udp = dgram.createSocket('udp4');
        route.lastFrameAt = Date.now();
        route.liveness = setInterval(() => {
            if (route.ready && Date.now() - route.lastFrameAt > 20000) fail(route, 13, 'upstream stopped responding');
        }, 1000).unref();
        tcp.setNoDelay(true); tcp.setTimeout(20000);
        let pending = Buffer.alloc(0);
        tcp.on('connect', () => upstreamWrite(route, CAPS, Buffer.alloc(0)));
        tcp.on('data', chunk => {
            if (route.closed) return;
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 2) {
                const size = pending.readUInt16LE();
                if (!size || size > 8192) return fail(route, 4, 'upstream frame too large');
                if (pending.length < size + 2) break;
                const message = pending.subarray(2, size + 2); pending = pending.subarray(size + 2);
                upstreamFrame(route, message[0], message.subarray(1));
                if (route.closed) return;
            }
        });
        tcp.on('error', () => fail(route)); tcp.on('timeout', () => fail(route, 13, 'upstream control timed out'));
        tcp.on('close', () => { if (!route.closed) fail(route, 11, 'upstream control closed'); });
        udp.on('error', () => fail(route, 11, 'upstream UDP unavailable'));
        udp.on('message', (bytes, sender) => {
            const record = route.record;
            if (!active(route) || !record?.frontUdp || paused() || sender.address !== endpoint.host || sender.port !== endpoint.port ||
                bytes.length < 5 || bytes.readUInt32LE() !== MAGIC || !rate(record, bytes.length, 'in')) return;
            if (bytes[4] === 0x81) { if (bytes.length !== 5) return; }
            else if (bytes[4] === 0x82) {
                if (bytes.length < 13 || ![...record.members.values()].includes(bytes.readUInt32LE(5))) return;
                if (bytes.length > 13 + 1459) { unsupported(record, 'upstream datagram exceeds legacy path support'); return; }
            } else if (route.provider.udpCaps && bytes[4] === 0x84) {
                if (bytes.length !== 9 || bytes.readUInt32LE(5) !== record.udpFeatures) return;
            } else if ((record.udpFeatures & 8) && bytes[4] === 0x86) { if (bytes.length !== 9) return; }
            else if ((record.udpFeatures & 4) && bytes[4] === 0x85) {
                if (bytes.length <= 21 || bytes.length > 1121 || ![...record.members.values()].includes(bytes.readUInt32LE(5)) ||
                    !bytes.readUInt16LE(17) || bytes.readUInt16LE(17) > 65507 || bytes.readUInt16LE(19) + bytes.length - 21 > bytes.readUInt16LE(17)) return;
            } else return;
            sendUdp(bytes, record.frontUdp.port, record.frontUdp.address);
        });
        udp.bind(0, provider.localTransport ? '127.0.0.1' : bindAddress, () => {
            // A frontend can disappear while UDP bind is still pending. Closing
            // an unbound socket may fail; finish that cleanup after listening.
            if (route.closed) { try { udp.close(); } catch {} return; }
            udp.connect(endpoint.port, endpoint.host, () => {
                if (route.closed) { try { udp.close(); } catch {} return; }
                route.udpReady = true;
            });
        });
    }
    function handleFrame(front, type, body) {
        if (front.virtual) return false;
        let route = routes.get(front);
        if (type === SELECT) {
            const id = body.toString('latin1');
            if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id) || front.member || localLocked.has(front) ||
                (route && route.provider?.id !== id && route.id !== id)) { error(front, 4, 'provider selection must precede room or list commands'); return true; }
            if (route) {
                if (route.id === 'self') selected(front, 'self', selfCapabilities());
                else if (active(route)) selected(front, route.provider.id, capabilities(route.provider));
                else error(front, 7, 'upstream selection still pending or closed');
                return true;
            }
            if (id === 'self') { routes.set(front, { id: 'self' }); selected(front, id, selfCapabilities()); return true; }
            const provider = registry.get(id);
            if (!provider || paused()) { error(front, provider ? 6 : 11, provider ? 'relay paused' : 'provider unavailable', provider ? 'paused' : 'disabled', id); return true; }
            begin(front, provider); return true;
        }
        if (!route || route.id === 'self') { if (type !== CAPS) localLocked.add(front); return false; }
        if (!active(route)) { error(front, 7, 'upstream not ready'); return true; }
        if (type === CAPS) { if (body.length) error(front,4,'invalid CAPS'); else { const cap=Buffer.alloc(4);cap.writeUInt32LE(capabilities(route.provider));send(front,0x89,cap); } return true; }
        if (paused() && ![3,5].includes(type)) {
            if (type === streamProtocol.COMMAND) fail(route, 6, 'relay paused');
            else error(front, 6, 'relay paused');
            return true;
        }
        if (draining() && [1,2].includes(type)) { error(front, 7, 'relay draining'); return true; }
        if (type === streamProtocol.COMMAND) {
            const record = route.record, h = streamProtocol.parse(body);
            if (!(capabilities(route.provider) & streamProtocol.CAPABILITY)) {
                error(front, 10, 'selected network does not support game TCP streams'); return true;
            }
            if (!record || !h || h.peer === record.ip || ![...record.members.values()].includes(h.peer) ||
                h.op === streamProtocol.OP.LEGACY_READY) {
                error(front, 4, 'invalid game stream destination'); return true;
            }
            if (!rate(record, body.length + 27, 'up')) { fail(route, 7, 'game stream traffic limit reached'); return true; }
            upstreamWrite(route, type, body); return true;
        }
        if (route.provider.adapterMetadata) {
            if (type === 0x21) { setAdapterMetadata(route,body); return true; }
            if (route.query && ![3,5].includes(type)) { error(front,7,'upstream discovery already pending'); return true; }
            if (type === 0x22) {
                if (body.length !== 12 || body.readUInt32LE(8) !== 0) { error(front,4,'legacy upstream exposes only its first group result'); return true; }
                if (route.pendingRoom) { error(front,7,'room admission still pending'); return true; }
                if (!quota(route.provider,'find')) { error(front,7,'upstream shared discovery rate reached'); return true; }
                const request = Buffer.alloc(15); body.copy(request,0,0,8); request[14] = 1;
                startQuery(route,true,body.readBigUInt64LE()); upstreamWrite(route,8,request); return true;
            }
        }
        const extra = ((route.provider.capabilities & 2) && type === 0x0c) || ((route.provider.capabilities & 64) && [0x21,0x22].includes(type));
        if (!extra && ![1,2,3,4,5,6,7,8].includes(type)) { error(front, 4, 'provider does not support this extension'); return true; }
        const record = route.record;
        let forwarded = body;
        if (type === 1 || type === 2 || type === 6) {
            if (record || route.pendingRoom) { error(front, 4, 'already joining or in a room'); return true; }
            if (type !== 6 && tokens.size >= maxTokens) { error(front,7,'upstream member capacity reached');return true; }
            if (!quota(route.provider, type === 1 ? 'create' : 'join')) { error(front, 7, 'upstream shared admission rate reached'); return true; }
            if (type === 1) {
                if (![40,41].includes(body.length)) { error(front,4,'invalid CREATE');return true; }
                if (route.provider.lanplay && (!body.readBigUInt64LE() || body.length !== 41 || !(body[40] & 1))) { error(front,4,'LAN Play requires an in-game local-wireless group');return true; }
                route.pendingRoom = { gameId: body.readBigUInt64LE() };
            } else if (type === 2) {
                if (![38,46,47].includes(body.length) || !codeValid(Buffer.from(body.subarray(0,6).toString('latin1').toUpperCase()))) { error(front,4,'invalid JOIN');return true; }
                route.pendingRoom = { code: body.subarray(0,6).toString('ascii').toUpperCase(), gameId: body.length >= 46 ? body.readBigUInt64LE(38) : 0n };
            } else {
                if (body.length !== 10) { error(front,4,'invalid RESUME');return true; }
                const old = tokens.get(body.readUInt32LE());
                if (!old || old.providerId !== route.provider.id || old.code !== body.subarray(4).toString('ascii')) {
                    error(front,5,'provider resume seat unavailable');return true;
                }
                if (old.route || old.claim) {
                    error(front,7,'provider resume seat still active');return true;
                }
                old.claim = route;
                forwarded = Buffer.from(body); forwarded.writeUInt32LE(old.remoteToken);
                route.pendingRoom = { code: old.code, gameId: old.gameId, resume: old };
            }
        } else if (type === 8) {
            if (![0,8,14,15].includes(body.length)) { error(front,4,'invalid FIND');return true; }
            if (!quota(route.provider,'find')) { error(front,7,'upstream shared discovery rate reached');return true; }
            if (route.provider.adapterMetadata) {
                if (route.pendingRoom) { error(front,7,'room admission still pending'); return true; }
                startQuery(route,false,0n);
            }
        } else if ([0x0c,0x22].includes(type)) {
            if (body.length !== 12) { error(front,4,'invalid page request');return true; }
            if (!quota(route.provider,'find')) { error(front,7,'upstream shared discovery rate reached');return true; }
        } else if (type === 0x21 && (!record || body.length !== 272)) { error(front,4,'metadata requires room owner');return true; }
        else if (type === 5 && body.length) { error(front,4,'invalid PING');return true; }
        else if (type === 3 && body.length) { error(front,4,'invalid LEAVE');return true; }
        else if ([4,7].includes(type) && !record) { error(front,4,'room required');return true; }
        upstreamWrite(route, type, forwarded);
        if (type === 3 && record) { route.discardRoomEvents = true; forget(record); }
        return true;
    }
    function handleDatagram(bytes, sender) {
        if (bytes.length < 9 || bytes.readUInt32LE() !== MAGIC) return false;
        const record = tokens.get(bytes.readUInt32LE(5));
        if (!record) return false;
        const route = record.route;
        if (!active(route) || !route.udpReady || paused() || sender.address !== record.publicIp) return true;
        if (!rate(record, bytes.length, 'out')) return true;
        const type = bytes[4];
        if (type === 1) { if (bytes.length !== 9) return true; }
        else if (type === 3) { if (bytes.length !== 9 || !record.frontUdp) return true; }
        else if (type === 2) {
            if (!record.frontUdp || bytes.length < 17) return true;
            if (bytes.length > 17 + 1455) { unsupported(record,'provider only supports legacy UDP payloads up to 1455 bytes');return true; }
            const dst = bytes.readUInt32LE(9);
            if (![0xffffffff,0x0a0dffff,0x0a7200ff,...record.members.values()].includes(dst)) return true;
        } else if (route.provider.udpCaps && type === 4) {
            if (bytes.length !== 13 || !bytes.readUInt32LE(9) || (bytes.readUInt32LE(9) & ~route.provider.udpCaps)) return true;
        } else if ((record.udpFeatures & 8) && type === 6) { if (!record.frontUdp || bytes.length !== 13) return true; }
        else if ((record.udpFeatures & 4) && type === 5) {
            if (!record.frontUdp || bytes.length <= 25 || bytes.length > 1125 || !bytes.readUInt16LE(21) ||
                bytes.readUInt16LE(21) > 65507 || bytes.readUInt16LE(23) + bytes.length - 25 > bytes.readUInt16LE(21) ||
                ![0xffffffff,0x0a0dffff,...record.members.values()].includes(bytes.readUInt32LE(9))) return true;
        } else { error(route.front,4,'provider does not support UDP extension');return true; }
        if (route.udp.getSendQueueSize() + bytes.length > 128*1024) return true;
        if (type === 1 || type === 4) record.udpFeatures = type === 4 ? bytes.readUInt32LE(9) : 0;
        record.frontUdp = { address: sender.address, port: sender.port };
        const rewritten = Buffer.from(bytes); rewritten.writeUInt32LE(record.remoteToken,5);
        route.udp.send(rewritten, e => { if (e) fail(route,11,'upstream UDP send failed'); }); if (!route.provider.localTransport) count(bytes.length+28);
        return true;
    }
    function onClose(front) { const route = routes.get(front); if (route && route.id !== 'self') close(route); routes.delete(front); }
    function shutdown() {
        closing = true;
        for (const route of routes.values()) if (route.id !== 'self') { if (route.record) upstreamWrite(route,3,Buffer.alloc(0)); close(route,false); }
        for (const record of tokens.values()) forget(record);
        routes.clear();
    }
    return { handleFrame, handleDatagram, onClose, shutdown, hasToken: token => tokens.has(token),
        activeMembers: () => [...tokens.values()].filter(r => active(r.route)).length,
        snapshot: () => {
            const current = [...tokens.values()].filter(r => active(r.route));
            return { connections: [...registry.values()].reduce((n,p)=>n+p.active,0), members: tokens.size, retainedMembers: tokens.size - current.length,
                activeMembers: current.length, rooms: new Set(current.map(r => r.providerId + ':' + r.code)).size,
                privateRooms: new Set(current.filter(r => r.gameId === 0n).map(r => r.providerId + ':' + r.code)).size };
        } };
}
module.exports = { create, createDiagnostics, PUBLIC_PROVIDERS, SELECT, SELECTED };
