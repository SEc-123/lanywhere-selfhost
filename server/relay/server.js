'use strict';
// Servidor de salas de LANywhere: control por TCP y paquetes del juego por UDP (ver docs/PROTOCOL.md).
// Sin dependencias: node server.js [--port 11460]
//
// Variables de entorno:
//   LANYWHERE_CAP_GB      tráfico de salida máximo al mes (GB; por defecto 8000). Al
//                    llegar, el servidor se pone en pausa hasta el mes siguiente (UTC).
//   LANYWHERE_STATE_DIR   dónde guardar el contador de tráfico y la historia del panel (por defecto, la carpeta del
//                    servidor).
//   LANYWHERE_STATS_PORT  puerto del panel de actividad, solo en 127.0.0.1 (por defecto 11461; 0 lo desactiva).
//   LANYWHERE_PUBLIC_PORT puerto de los datos públicos para la web, solo en 127.0.0.1 (por defecto 11463; 0 lo
//                    desactiva). Lo publica el proxy HTTPS.
//   LANYWHERE_OPS_PORT puerto de disponibilidad y drenaje, solo en 127.0.0.1 (por defecto 0).
//   LANYWHERE_OPS_TOKEN credencial opcional de 32 bytes base64url para POST /api/drain.
//   LANYWHERE_LANPLAY_PORT puerto de la pasarela opcional para emuladores (por defecto 0, desactivada).
//   LANYWHERE_MAX_CONNECTIONS y LANYWHERE_MAX_CONNECTIONS_PER_IP limitan conexiones TCP concurrentes.
//   LANYWHERE_CONTROL_FRAMES_PER_SEC, LANYWHERE_DATA_BYTES_PER_SEC y LANYWHERE_DATA_PACKETS_PER_SEC limitan tráfico.
//   LANYWHERE_GRACE_MS tiempo que se guarda un puesto al reconectar (por defecto 60000).
//   LANYWHERE_MATCH_WAIT_MS, LANYWHERE_MATCH_HOLD_MS plazos de búsqueda y reserva (90000 y 30000).
//   LANYWHERE_SHUTDOWN_GRACE_MS espera para que salgan los miembros al recibir SIGTERM (10000).
//   LANYWHERE_JOIN_TIMEOUT_MS plazo para que el anfitrión confirme un invitado en su grupo (10000).
//   LANYWHERE_UDP_BIND_ADDRESS IPv4 local para las respuestas UDP (0.0.0.0 por defecto).
//   LANYWHERE_ENABLE_PUBLIC_UPSTREAM=1 enables only the fixed lanywhere-public provider (default 0).

const fs = require('fs');
const path = require('path');
const net = require('net');
const dgram = require('dgram');
const crypto = require('crypto');
const matchmaking = require('./matchmaking');
const { groupPage } = require('./group-page');
const trafficStore = require('./traffic-store');
const upstreamGateway = require('./upstream-gateway');
const roomMetadata = require('./room-metadata').create();
const streamProtocol = require('./tcp-stream-protocol');
const fragments = require('./udp-fragments').create();
setInterval(() => fragments.sweep(), 250).unref();

function integerSetting(value, fallback, name, min, max) {
    if (value === undefined) return fallback;
    const n = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max)
        throw new Error(`${name} debe ser un entero entre ${min} y ${max}`);
    return n;
}

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--port')) throw new Error('uso: node server.js [--port 11460]');
const envInt = (name, fallback, min, max) => integerSetting(process.env[name], fallback, name, min, max);
const PORT = integerSetting(args[1], 11460, '--port', 0, 65535);
const STATS_PORT = envInt('LANYWHERE_STATS_PORT', 11461, 0, 65535);
const PUBLIC_PORT = envInt('LANYWHERE_PUBLIC_PORT', 11463, 0, 65535);
const OPS_PORT = envInt('LANYWHERE_OPS_PORT', 0, 0, 65535);
const LANPLAY_PORT = envInt('LANYWHERE_LANPLAY_PORT', 0, 0, 65535);
const CONTROL_BIND_ADDRESS = process.env.LANYWHERE_CONTROL_BIND_ADDRESS;
if (CONTROL_BIND_ADDRESS !== undefined && !net.isIP(CONTROL_BIND_ADDRESS)) throw new Error('Invalid control bind address');
const UPSTREAM_BIND_ADDRESS = process.env.LANYWHERE_UPSTREAM_BIND_ADDRESS ?? '0.0.0.0';
if (!net.isIPv4(UPSTREAM_BIND_ADDRESS)) throw new Error('Invalid upstream bind address');
const UDP_BIND_ADDRESS = process.env.LANYWHERE_UDP_BIND_ADDRESS ?? '0.0.0.0';
if (!net.isIPv4(UDP_BIND_ADDRESS)) throw new Error('LANYWHERE_UDP_BIND_ADDRESS debe ser una dirección IPv4 local');
const tcpPorts = [PORT, STATS_PORT, PUBLIC_PORT, OPS_PORT].filter(Boolean);
if (new Set(tcpPorts).size !== tcpPorts.length || (PORT && PORT === LANPLAY_PORT))
    throw new Error('los puertos del servidor se superponen');

const capSetting = process.env.LANYWHERE_CAP_GB ?? '8000';
const CAP_BYTES = Math.floor(Number(capSetting) * 1e9);
if (!/^\d+(?:\.\d+)?$/.test(capSetting) || !Number.isSafeInteger(CAP_BYTES) || CAP_BYTES < 1)
    throw new Error('LANYWHERE_CAP_GB debe ser un número decimal positivo');

const MAX_MEMBERS = 8;
const MAX_PAYLOAD = 1472;  // un datagrama UDP con MTU 1500, como en una LAN
const MAX_GAME_PAYLOAD = 65507, FRAGMENT_CHUNK = 1100, LEGACY_DOWNLINK_PAYLOAD = 1459;
const UDP_FEATURES = 4 | 8;
// Metadata extensions may add their independent capability bit here.
const SELF_CAPABILITIES = 3 | UDP_FEATURES | 16 | 32 | 64 | streamProtocol.CAPABILITY |
    ((LANPLAY_PORT || process.env.LANYWHERE_LANPLAY_REALM) ? streamProtocol.LEGACY_CAPABILITY : 0);
const IDLE_MS = 20000;
const GRACE_MS = envInt('LANYWHERE_GRACE_MS', 60000, 1, 300000);
const MATCH_WAIT_MS = envInt('LANYWHERE_MATCH_WAIT_MS', 90000, 1, 300000);
const MATCH_HOLD_MS = envInt('LANYWHERE_MATCH_HOLD_MS', 30000, 1, 120000);
const JOIN_TIMEOUT_MS = envInt('LANYWHERE_JOIN_TIMEOUT_MS', 10000, 100, 120000);
const SHUTDOWN_GRACE_MS = envInt('LANYWHERE_SHUTDOWN_GRACE_MS', 10000, 0, 300000);
const MAX_TCP_QUEUE = 128 * 1024;
const MAX_UDP_QUEUE = 256 * 1024;
const UDP_MAGIC = 0x594e414c;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const NET_BASE = (10 << 24) | (114 << 16);  // 10.114.0.0/24: salas de consolas sin la red de LAN Play
// Salas de clientes que la entienden (último byte de CREATE/JOIN, bit 0): la red de LAN Play, 10.13.0.0/16, con una
// IP única en todo el servidor por miembro. Así un emulador (lanplay.js) y las consolas ven las mismas direcciones,
// también las que el juego lleva dentro de sus paquetes.
const NET13 = (10 << 24) | (13 << 16);
const F_NET13 = 1;
// Grupo de ldn publicado (NetworkInfo de ldn_mitm): id del juego en 0, máximo de jugadores en 0x66, jugadores en
// 0x67, 8 nodos de 0x40 desde 0x68 (IP en +0, conectado en +11, nombre de 33 bytes en +12).
const NETWORK_INFO_SIZE = 0x480;
const NODES = 0x68, NODE_SIZE = 0x40;
const ACCEPT_POLICY = 0x62, ALWAYS_REJECT = 1;
const NODE_MAX = 0x66, NODE_COUNT = 0x67, ADVERTISE_SIZE = 0x26a;
const MAX_GROUPS = 6;  // por respuesta a FIND
const BROADCASTS = new Set([(NET_BASE | 255) >>> 0, (NET13 | 0xffff) >>> 0, 0xffffffff]);

// Límites contra abusos (por IP pública: una casa con varias consolas comparte IP).
const LIMITS = {
    connectionsTotal: envInt('LANYWHERE_MAX_CONNECTIONS', 1024, 1, 16000),
    connectionsPerIp: envInt('LANYWHERE_MAX_CONNECTIONS_PER_IP', 12, 1, 1024),
    controlFrames: envInt('LANYWHERE_CONTROL_FRAMES_PER_SEC', 100, 1, 10000),
    dataBytes: envInt('LANYWHERE_DATA_BYTES_PER_SEC', 512 * 1024, 1, 64 * 1024 * 1024),
    dataPackets: envInt('LANYWHERE_DATA_PACKETS_PER_SEC', 1000, 1, 10000),
    roomsTotal: 3000,
    perMinute: { create: envInt('LANYWHERE_CREATE_PER_MIN', 10, 1, 1000), join: 30, find: 120, match: 600 },
};
const STATE_FILE = path.join(process.env.LANYWHERE_STATE_DIR ?? __dirname, 'traffic.json');
if (process.env.LANYWHERE_STATE_DIR === '') throw new Error('LANYWHERE_STATE_DIR no puede estar vacío');
const UDP_OVERHEAD = 28, TCP_OVERHEAD = 52;  // cabeceras IP/UDP e IP/TCP: también cuentan como tráfico

const T = { CREATE: 0x01, JOIN: 0x02, LEAVE: 0x03, RELAY: 0x04, PING: 0x05, RESUME: 0x06, PUBLISH: 0x07, FIND: 0x08,
            RESERVE: 0x09, CANCEL: 0x0a, CAPS: 0x0b, FIND_PAGE: 0x0c, FIND_FILTER: 0x0d,
            META_SET: 0x21, FIND_META_PAGE: 0x22, META_PAGE: 0xa2,
            TCP_STREAM: streamProtocol.COMMAND, TCP_STREAM_IN: streamProtocol.RESPONSE,
            ROOM: 0x81, MEMBER_JOINED: 0x82, MEMBER_LEFT: 0x83, RELAY_IN: 0x84, ERROR: 0x85, PONG: 0x86, GROUPS: 0x87,
            RESERVATION: 0x88, CAPABILITIES: 0x89, PAGE: 0x8a };
const inboundDeadline = require('./inbound-deadline');
const U = { REGISTER: 0x01, DATA: 0x02, KEEPALIVE: 0x03, REGISTER_V2: 0x04, FRAGMENT: 0x05, HEARTBEAT: 0x06,
    REGISTERED: 0x81, DATA_IN: 0x82, REGISTERED_V2: 0x84, FRAGMENT_IN: 0x85, HEARTBEAT_ACK: 0x86 };
const E = { NO_ROOM: 1, FULL: 2, OTHER_GAME: 3, BAD_REQUEST: 4, NO_SEAT: 5, PAUSED: 6, BUSY: 7, UPDATE: 8, VERSION: 9, DATA_UNSUPPORTED: 10 };
const LDN = { SCAN: 1, SCAN_RESP: 2, CONNECT: 3, SYNC: 4, DISCONNECT: 5 };

const rooms = new Map();    // código → { code, gameId, members: Array(8), published }
const byToken = new Map();  // token → miembro
const byIp13 = new Map();   // IP 10.13 → miembro (salas en la red de LAN Play)
let ready = false, draining = false, shutdownTimer = null;
const realmId = process.env.LANYWHERE_LANPLAY_REALM;
// Self must receive the caller's resolved NACP communication ID. The legacy
// sentinel remains part of external LAN Play/fork wire interoperability.
function rejectUnresolvedLcid(socket, gameId) {
    if (realmId || socket.virtual || gameId !== 0xffffffffffffffffn) return false;
    sendError(socket, E.UPDATE, 'actualiza LANywhere para entrar en esta sala');
    return true;
}
const realmProvider = realmId && require('./lanplay-providers').find(p => p.id === realmId);
if (realmId && (!realmProvider || !process.send || CONTROL_BIND_ADDRESS !== '127.0.0.1' || UDP_BIND_ADDRESS !== '127.0.0.1'))
    throw new Error('LAN Play child realm must be supervised and loopback-only');
const regionList = process.env.LANYWHERE_LANPLAY_PROVIDERS;
const regionIds = regionList === undefined ? require('./lanplay-providers').map(p=>p.id) : regionList.split(',');
if (regionIds.some(id=>!require('./lanplay-providers').some(p=>p.id===id)) || new Set(regionIds).size !== regionIds.length)
    throw new Error('Invalid LAN Play provider allowlist');
const providerDiagnostics = upstreamGateway.createDiagnostics({
    providerIds: ['self', ...upstreamGateway.PUBLIC_PROVIDERS.map(p=>p.id), ...require('./lanplay-providers').map(p=>p.id)],
    count: reason => stats.count('provider_' + reason),
    emit: event => log(`provider=${event.provider} reason=${event.reason} code=${event.code} events=${event.events}`),
});
const realms = !realmId && envInt('LANYWHERE_ENABLE_LANPLAY_UPSTREAM', 0, 0, 1) ? require('./lanplay-realms').create({ count, providers: require('./lanplay-providers').filter(p=>regionIds.includes(p.id)),
    paused: () => paused, log: (...a) => log(...a), onEvent: providerDiagnostics.record }) : null;
let realmTraffic = 0, realmTransportReady = false, realmNativePort = 0;
let realmFirstDiscoveryWindow = false, realmReadySent = false, realmDiscoveryTimer = null;
function realmReady() {
    if (realmId && realmTransportReady && realmNativePort && realmFirstDiscoveryWindow && !realmReadySent) {
        realmReadySent = true; process.send?.({type:'ready', port:realmNativePort});
    }
}
if (realmId) {
    setInterval(() => { if (realmTraffic) { process.send?.({type:'traffic', bytes:realmTraffic}); realmTraffic = 0; } }, 1000).unref();
    process.on('disconnect', () => {
        const dir = path.dirname(STATE_FILE);
        if (path.dirname(dir) === require('node:os').tmpdir() && path.basename(dir).startsWith('lanywhere-realm-'))
            fs.rmSync(dir, {recursive:true, force:true});
        process.exit(0);
    });
}
const upstreams = upstreamGateway.create({
    providers: [...(envInt('LANYWHERE_ENABLE_PUBLIC_UPSTREAM', 0, 0, 1) ? upstreamGateway.PUBLIC_PROVIDERS : []), ...(realms?.providers || [])],
    send, sendUdp: udpSend, isLocalToken: token => byToken.has(token), count,
    onEvent: providerDiagnostics.record,
    selfCapabilities: () => SELF_CAPABILITIES, paused: () => paused, draining: () => draining,
    bindAddress: UPSTREAM_BIND_ADDRESS, dataBytes: LIMITS.dataBytes, dataPackets: LIMITS.dataPackets,
});
const matches = matchmaking.create({ rooms: () => rooms.values(), capacity: nativeMatchCapacity,
    waitMs: MATCH_WAIT_MS, holdMs: MATCH_HOLD_MS, joinedMs: Math.max(GRACE_MS, MATCH_HOLD_MS) });
setInterval(matches.sweep, 250).unref();

// Panel de actividad (stats.js): hasta que arranca, no cuenta nada.
let stats = { count() {}, event() {}, noteSearch() {}, save() {} };
const log = (...a) => {
    console.log(new Date().toISOString(), ...a);
    stats.event(a.join(' '));
};
const ipOf = (index) => (NET_BASE | (index + 1)) >>> 0;
// Una IP 10.13 libre: ni de otro miembro ni de un emulador de LAN Play (10.13.37.1 y 10.13.254.254 son reservadas).
function allocIp13() {
    for (let n = 0; n < 1000; n++) {
        const ip = (NET13 | ((1 + crypto.randomInt(254)) << 8) | (1 + crypto.randomInt(254))) >>> 0;
        if (ip === ((NET13 | 0x2501) >>> 0) || ip === ((NET13 | 0xfefe) >>> 0)) continue;
        if (byIp13.has(ip) || (lanplay && lanplay.taken(ip))) continue;
        return ip;
    }
    return 0;
}
const ipStr = (ip) => [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');
const plainIp = (a) => (a || '').replace(/^::ffff:/, '');

// --- apodos ---------------------------------------------------------------------------------------------------
// Los elige cada consola (nunca el nombre de usuario de la consola); aquí solo se limpian. Si un apodo no es válido
// o es ofensivo, el jugador aparece como "Jugador NNNN".

const BAD_WORDS = [
    // español
    'puta', 'puto', 'mierda', 'pendejo', 'pendeja', 'marica', 'maricon', 'verga', 'polla', 'coño', 'cono', 'culo',
    'chinga', 'chingada', 'cabron', 'cabrona', 'gonorrea', 'hijueputa', 'malparido', 'malparida', 'zorra', 'perra',
    'idiota', 'imbecil', 'estupido', 'estupida', 'mamaguevo', 'pajero', 'follar', 'violar', 'nazi', 'hitler',
    'sexo', 'porno', 'pene', 'vagina', 'tetas', 'negrata', 'sudaca', 'retrasado', 'mongolico', 'subnormal',
    // inglés
    'fuck', 'shit', 'bitch', 'cunt', 'dick', 'cock', 'pussy', 'whore', 'slut', 'nigger', 'nigga', 'faggot', 'fag',
    'retard', 'rape', 'porn', 'sex', 'penis', 'asshole', 'bastard',
];

function normalizeForFilter(s) {
    return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[0@4]/g, (c) => ({ 0: 'o', '@': 'a', 4: 'a' })[c])
        .replace(/[1!|]/g, 'i').replace(/3/g, 'e').replace(/5|\$/g, 's').replace(/7/g, 't')
        .replace(/[^a-zñ]/g, '');
}

function cleanNick(raw, fallbackSeed) {
    let s = String(raw || '').normalize('NFC').replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/\s+/g, ' ').trim();
    if ([...s].length > 20) s = [...s].slice(0, 20).join('').trim();
    const flat = normalizeForFilter(s);
    const offensive = BAD_WORDS.some((w) => flat.includes(w));
    if ([...s].length < 2 || offensive) {
        stats.count('nicksFiltered');
        const n = 1000 + (fallbackSeed % 9000);
        return `Jugador ${n}`;
    }
    return s;
}

function nick(buf) {
    const end = buf.indexOf(0);
    return buf.subarray(0, end < 0 ? buf.length : end).toString('utf8');
}

function nickBuf(s) {
    const b = Buffer.alloc(32);
    b.write(s || '', 0, 31, 'utf8');
    return b;
}

// Los nombres de los nodos de un NetworkInfo se reemplazan por los apodos limpios de la sala: un cliente modificado
// no puede poner ahí otro nombre (y nunca se ve el nombre de usuario de la consola).
function sanitizeNetworkInfo(room, info) {
    const out = Buffer.from(info);
    for (let i = 0; i < MAX_MEMBERS; i++) {
        const node = NODES + i * NODE_SIZE;
        out.fill(0, node + 12, node + 45);
        if (!out[node + 11]) continue;
        const ip = out.readUInt32LE(node);
        const member = room.members.find((m) => m && m.ip === ip);
        out.write(member ? member.nick : 'Jugador', node + 12, 32, 'utf8');
    }
    return out;
}

function networkMembers(member, info) {
    const { room } = member;
    const max = info[NODE_MAX], count = info[NODE_COUNT];
    if (info.length !== NETWORK_INFO_SIZE || info[ACCEPT_POLICY] > 3 || max < 1 || max > MAX_MEMBERS || count < 1 || count > max ||
        info.readUInt16LE(ADVERTISE_SIZE) > 384 || (room.gameId && info.readBigUInt64LE(0) !== room.gameId) ||
        info[NODES + 11] !== 1 || info.readUInt32LE(NODES) !== member.ip) return null;
    const connected = new Set();
    for (let i = 0; i < MAX_MEMBERS; i++) {
        const node = NODES + i * NODE_SIZE;
        const state = info[node + 11];
        if (state === 0) continue;
        const ip = info.readUInt32LE(node);
        const nodeMember = room.members.find((m) => m && m.ip === ip);
        if (state !== 1 || info[node + 10] !== i || !nodeMember || connected.has(nodeMember)) return null;
        connected.add(nodeMember);
    }
    return connected.size === count ? connected : null;
}

// --- tráfico del mes: tope para no pasarse del presupuesto -------------------------------------------------------

const monthNow = () => new Date().toISOString().slice(0, 7);
fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true, mode: 0o700 });
const traffic = trafficStore.load(STATE_FILE, monthNow());
let paused = false;

function saveTraffic() {
    try {
        trafficStore.save(STATE_FILE, traffic);
    } catch (e) {
        log(`no se pudo guardar el tráfico: ${e.message}`);
        process.exit(1);
    }
}

function checkMonth() {
    const m = monthNow();
    if (traffic.month < m) {
        if (traffic.month) log(`mes nuevo (${m}): contador de tráfico a cero`);
        traffic.month = m;
        traffic.bytes = 0;
    }
    const wasPaused = paused;
    paused = traffic.bytes >= CAP_BYTES;
    if (paused && !wasPaused) {
        matches.drain();
        streams.shutdown();
        log(`TOPE MENSUAL ALCANZADO (${(traffic.bytes / 1e9).toFixed(1)} GB): servidor en pausa hasta el mes que viene`);
        for (const room of rooms.values())
            for (const m of room.members) if (m && m.socket) sendError(m.socket, E.PAUSED, PAUSED_TEXT);
    }
    if (!paused && wasPaused) log('servidor activo de nuevo');
}
const PAUSED_TEXT = 'el servidor llegó a su límite de este mes; vuelve el día 1';

function count(bytes) {
    traffic.bytes += bytes;
    if (!paused && traffic.bytes >= CAP_BYTES) checkMonth();
}

// --- límites por IP --------------------------------------------------------------------------------------------

const connections = new Map();  // ip → conexiones abiertas
const buckets = new Map();      // `${ip}:${tipo}` → { minute, n }
let totalConnections = 0;

function allowed(ip, kind) {
    const minute = Math.floor(Date.now() / 60000);
    const key = `${ip}:${kind}`;
    let b = buckets.get(key);
    if (!b || b.minute !== minute) {
        if (!b && buckets.size >= LIMITS.connectionsTotal * 16) return false;
        buckets.set(key, (b = { minute, n: 0 }));
    }
    if (++b.n <= LIMITS.perMinute[kind]) return true;
    stats.count('rateLimited');
    return false;
}

setInterval(() => {
    const minute = Math.floor(Date.now() / 60000);
    for (const [k, b] of buckets) if (b.minute < minute) buckets.delete(k);
}, 60000).unref();

// --- salas -----------------------------------------------------------------------------------------------------

function newCode() {
    for (;;) {
        let code = '';
        for (const byte of crypto.randomBytes(6)) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
        if (!rooms.has(code)) return code;
    }
}

function newToken() {
    for (;;) {
        const t = crypto.randomBytes(4).readUInt32LE(0);
        if (t && !byToken.has(t) && !upstreams.hasToken(t)) return t;
    }
}

function memberBuf(m) {
    const b = Buffer.alloc(5);
    b.writeUInt8(m.index, 0);
    b.writeUInt32LE(m.ip, 1);
    return Buffer.concat([b, nickBuf(m.nick)]);
}

// Un "socket" puede ser una conexión TCP de una consola o un miembro virtual (un Ryujinx entrando por LAN Play, ver
// lanplay.js): ese recibe las tramas por deliver() en lugar de por la red.
function send(socket, type, body = Buffer.alloc(0)) {
    if (!socket || socket.destroyed) return false;
    if (socket.virtual) return socket.deliver(type, body) !== false;
    if (socket.writableEnded) return false;
    if (socket.writableLength + body.length + 3 > MAX_TCP_QUEUE) { socket.destroy(); return false; }
    const head = Buffer.alloc(3);
    head.writeUInt16LE(body.length + 1, 0);
    head.writeUInt8(type, 2);
    socket.write(Buffer.concat([head, body]));
    count(3 + body.length + TCP_OVERHEAD);
    return true;
}

function sendError(socket, code, text) {
    send(socket, T.ERROR, Buffer.concat([Buffer.from([code]), Buffer.from(text, 'utf8')]));
}

const streams = require('./tcp-streams').create({
    send: (member, body) => send(member.socket, T.TCP_STREAM_IN, body),
    event: (name) => stats.count(`tcpStream:${name}`),
});
const streamSweep = setInterval(() => streams.sweep(), 100).unref();

function others(room, member) {
    return room.members.filter((m) => m && m !== member);
}

function active(member) {
    return member && member.socket && !member.socket.destroyed;
}

function openCapacity(room) {
    const info = room.published?.info;
    if (paused || draining || !info || !active(room.members[0]) || info[ACCEPT_POLICY] === ALWAYS_REJECT) return 0;
    return Math.max(0, info[NODE_MAX] - Math.max(info[NODE_COUNT], room.members.filter(Boolean).length));
}

function nativeMatchCapacity(room) {
    // The gateway cannot reserve seats on an emulator's LAN listener, and only
    // AlwaysAccept makes an unconditional offer to strangers possible.
    return room.members[0]?.socket?.virtual || room.published?.info[ACCEPT_POLICY] !== 0 ? 0 : openCapacity(room);
}

function hasSeat(room) {
    return openCapacity(room) > matches.count(room);
}

function isOpen(room) {
    return hasSeat(room);
}

function join(socket, room, nickname, onJoined, features = 0) {
    const index = room.members.findIndex((m) => !m);
    if (index < 0) return sendError(socket, E.FULL, 'la sala está llena');
    // Un miembro virtual (emulador) conserva su IP de LAN Play.
    const ip = !room.net13 ? ipOf(index) : socket.virtual ? socket.ip13 : allocIp13();
    if (!ip || (room.net13 && byIp13.has(ip))) return sendError(socket, E.BUSY, 'no hay direcciones libres; prueba en un momento');
    const token = newToken();
    const member = { index, ip, nick: cleanNick(nickname, token), token, socket, room, udp: null, udpFeatures: 0, grace: null, admission: null,
                     publicIp: plainIp(socket.remoteAddress), features };
    room.members[index] = member;
    byToken.set(member.token, member);
    if (room.net13) byIp13.set(ip, member);
    socket.member = member;
    // A relay JOIN only reserves a connection, not a completed LDN station. A
    // client that never reaches the host must not occupy a public game forever.
    if (room.gameId && index !== 0) member.admission = setTimeout(() => {
        sendError(member.socket, E.NO_SEAT, 'el anfitrión no confirmó la conexión al juego');
        evict(member, 'no completó la conexión al juego');
    }, JOIN_TIMEOUT_MS);
    onJoined?.(member);
    sendRoom(member);
    for (const m of others(room, member)) send(m.socket, T.MEMBER_JOINED, memberBuf(member));
    stats.count('joins');
    log(`sala ${room.code}: entra ${member.nick} (${ipStr(member.ip)}), ${room.members.filter(Boolean).length} miembros`);
    return member;
}

function resumeMember(socket, old, ip) {
    if (old.socket === socket) return sendRoom(old);
    if (active(old)) return sendError(socket, E.BUSY, 'la conexión anterior todavía está activa');
    streams.closeMember(old);
    if (old.socket) { old.socket.member = null; old.socket.destroy(); }
    clearTimeout(old.grace);
    old.grace = null;
    old.socket = socket;
    old.publicIp = ip;  // al reconectar puede haber cambiado de red
    old.udp = null;
    old.udpFeatures = 0;
    fragments.clear(old);
    socket.member = old;
    sendRoom(old);
    matches.roomChanged(old.room);
    stats.count('resumes');
    log(`sala ${old.room.code}: vuelve ${old.nick} (${ipStr(old.ip)})`);
}

function sendRoom(member) {
    const { room, index } = member;
    const head = Buffer.alloc(6 + 1 + 4 + 4 + 8 + 1);
    head.write(room.code, 0, 6, 'ascii');
    head.writeUInt8(index, 6);
    head.writeUInt32LE(member.ip, 7);
    head.writeUInt32LE(member.token, 11);
    head.writeBigUInt64LE(room.gameId, 15);
    const list = room.members.filter(Boolean);
    head.writeUInt8(list.length, 23);
    send(member.socket, T.ROOM, Buffer.concat([head, ...list.map(memberBuf)]));
}

// Conexión cortada sin LEAVE: el puesto (índice, IP y token) se guarda GRACE_MS por si vuelve con RESUME.
function detach(member) {
    streams.closeMember(member);
    if (member.socket) member.socket.member = null;
    member.socket = null;
    member.udp = null;
    member.udpFeatures = 0;
    fragments.clear(member);
    clearTimeout(member.grace);
    member.grace = setTimeout(() => leave(member, 'no volvió'), GRACE_MS);
    matches.roomChanged(member.room);
    log(`sala ${member.room.code}: se cortó ${member.nick}, se guarda su puesto`);
    checkShutdown();
}

function evict(member, why) {
    const socket = member.socket;
    leave(member, why);
    if (socket && !socket.virtual) socket.end();
}

function leave(member, why) {
    const { room } = member;
    if (!room || room.members[member.index] !== member) return;
    streams.closeMember(member);
    room.members[member.index] = null;
    matches.memberLeft(member);
    byToken.delete(member.token);
    fragments.clear(member);
    if (byIp13.get(member.ip) === member) byIp13.delete(member.ip);
    clearTimeout(member.grace);
    clearTimeout(member.admission);
    if (member.socket) member.socket.member = null;
    if (room.published && room.published.member === member) room.published = null;
    for (const m of others(room, member)) send(m.socket, T.MEMBER_LEFT, Buffer.from([member.index]));
    const left = room.members.filter(Boolean).length;
    log(`sala ${room.code}: sale ${member.nick} (${why}), quedan ${left}`);
    if (left === 0 || (room.gameId && member.index === 0)) rooms.delete(room.code);
    if (room.gameId && member.index === 0) {
        for (const guest of others(room, member)) {
            const socket = guest.socket;
            leave(guest, 'el anfitrión cerró el grupo');
            if (socket && !socket.virtual) socket.end();
        }
    }
    matches.roomChanged(room);
    checkShutdown();
}

function relayControl(member, body) {
    if (body.length < 2) return;
    const { room } = member;
    const dest = body[0], type = body[1];
    if (dest === member.index || (dest !== 0xff && !active(room.members[dest]))) return;
    const publicRoom = room.gameId !== 0n;
    let payload = body.subarray(2);
    switch (type) {
        case LDN.SCAN:
            if (dest !== 0xff || payload.length !== 0) return;
            break;
        case LDN.SCAN_RESP:
        case LDN.SYNC:
            if (payload.length !== NETWORK_INFO_SIZE) return;
            if (rejectUnresolvedLcid(member.socket, payload.readBigUInt64LE(0))) return;
            if (dest === 0xff || (publicRoom && member.index !== 0) || !networkMembers(member, payload)) return;
            payload = sanitizeNetworkInfo(room, payload);
            break;
        case LDN.CONNECT:
            if (dest === 0xff || (publicRoom && (dest !== 0 || !room.published)) || payload.length !== NODE_SIZE ||
                payload[11] !== 1 || payload.readUInt32LE(0) !== member.ip) return;
            payload = Buffer.from(payload);
            payload.fill(0, 12, 45);
            payload.write(member.nick, 12, 32, 'utf8');
            break;
        case LDN.DISCONNECT:
            if (dest === 0xff || (publicRoom && member.index !== 0 && dest !== 0) || payload.length !== 0) return;
            break;
        default:
            return;  // MEMBER_LEFT lo genera el servidor, no un cliente.
    }
    const out = Buffer.concat([Buffer.from([member.index, type]), payload]);
    for (const m of others(room, member))
        if (dest === 0xff || m.index === dest) send(m.socket, T.RELAY_IN, out);
    // The public-room host is authoritative. A kicked guest cannot retain the
    // relay seat merely by ignoring DISCONNECT and continuing to send PING.
    if (publicRoom && member.index === 0 && type === LDN.DISCONNECT) {
        const guest = room.members[dest];
        if (guest) evict(guest, 'el anfitrión rechazó la conexión');
    }
}

function onFrame(socket, type, body) {
    if (upstreams.handleFrame(socket, type, body)) return;
    const member = socket.member;
    const ip = plainIp(socket.remoteAddress);
    if (paused && ![T.LEAVE, T.PING, T.CAPS, T.CANCEL].includes(type)) {
        stats.count('pausedRejects');
        return sendError(socket, E.PAUSED, PAUSED_TEXT);
    }
    if (draining && (type === T.CREATE || type === T.RESERVE || (type === T.JOIN && body.length !== 65)))
        return sendError(socket, E.BUSY, 'el servidor se está cerrando');
    switch (type) {
        case T.CREATE: {
            if (member || (body.length !== 40 && body.length !== 41)) return sendError(socket, E.BAD_REQUEST, 'CREATE no válido');
            if (rejectUnresolvedLcid(socket, body.readBigUInt64LE(0))) return;
            if (!allowed(ip, 'create') || rooms.size >= LIMITS.roomsTotal)
                return sendError(socket, E.BUSY, 'demasiadas salas; prueba en un momento');
            const features = body.length > 40 ? body[40] : 0;
            const room = { code: newCode(), gameId: body.readBigUInt64LE(0), members: new Array(MAX_MEMBERS).fill(null), published: null,
                           net13: !!(features & F_NET13) };
            rooms.set(room.code, room);
            stats.count('roomsCreated');
            log(`sala ${room.code} creada (juego ${room.gameId.toString(16)})`);
            join(socket, room, nick(body.subarray(8, 40)), undefined, features);
            if (!socket.member) rooms.delete(room.code);
            return;
        }
        case T.JOIN: {
            const reserved = body.length === 65;
            if ((!reserved && member) || ![38, 46, 47, 65].includes(body.length) || (reserved && socket.virtual))
                return sendError(socket, E.BAD_REQUEST, 'JOIN no válido');
            const gameId = body.length >= 6 + 32 + 8 ? body.readBigUInt64LE(38) : 0n;
            if (rejectUnresolvedLcid(socket, gameId)) return;
            const room = rooms.get(body.subarray(0, 6).toString('ascii').toUpperCase());
            if (room && rejectUnresolvedLcid(socket, room.gameId)) return;
            if (!allowed(ip, 'join')) return sendError(socket, E.BUSY, 'demasiados intentos; prueba en un momento');
            if (!room) return sendError(socket, E.NO_ROOM, 'la sala no existe');
            if (gameId && gameId !== room.gameId) return sendError(socket, E.OTHER_GAME, 'la sala es de otro juego');
            const features = body.length > 46 ? body[46] : 0;
            if (room.net13 && !(features & F_NET13))
                return sendError(socket, E.UPDATE, 'actualiza LANywhere para entrar en esta sala');
            if (reserved) {
                if (!gameId) return sendError(socket, E.BAD_REQUEST, 'JOIN sin juego');
                const version = body.readUInt16LE(63);
                const claim = matches.claim(body.subarray(47, 63), room, version, features, ip);
                if (claim.error === 'version') return sendError(socket, E.VERSION, 'la versión local del juego no coincide');
                if (claim.error) return sendError(socket, E.NO_SEAT, 'la reserva ya no está disponible');
                if (member && member !== claim.member) return sendError(socket, E.BAD_REQUEST, 'ya estás en una sala');
                if (claim.member) return resumeMember(socket, claim.member, ip);
                const joined = join(socket, room, nick(body.subarray(6, 38)), (seat) => matches.commit(claim.ticket, seat, version), features);
                if (joined) matches.roomChanged(room);
                return;
            }
            if (room.gameId) {
                const owner = room.members[0];
                // La pasarela registra estaciones ya presentes en el grupo de un emulador antes de su primer anuncio.
                if (!active(owner)) return sendError(socket, E.NO_ROOM, 'el grupo no está abierto');
                const existingEmulatedStation = socket.virtual && owner.socket.virtual;
                if (!existingEmulatedStation && (!room.published || room.published.info[ACCEPT_POLICY] === ALWAYS_REJECT))
                    return sendError(socket, E.NO_ROOM, 'el grupo no está abierto');
                if (!existingEmulatedStation && !hasSeat(room)) return sendError(socket, E.FULL, 'la sala está llena');
            }
            const joined = join(socket, room, nick(body.subarray(6, 38)), undefined, features);
            if (joined) matches.roomChanged(room);
            return;
        }
        case T.RESUME: {
            if (member || body.length !== 10) return sendError(socket, E.BAD_REQUEST, 'RESUME no válido');
            if (!allowed(ip, 'join')) return sendError(socket, E.BUSY, 'demasiados intentos; prueba en un momento');
            const old = byToken.get(body.readUInt32LE(0));
            if (!old || old.room.code !== body.subarray(4, 10).toString('ascii'))
                return sendError(socket, E.NO_SEAT, 'el puesto en la sala ya no existe');
            return resumeMember(socket, old, ip);
        }
        case T.LEAVE:
            if (body.length !== 0) return sendError(socket, E.BAD_REQUEST, 'LEAVE no válido');
            if (member) leave(member, 'salió');
            return;
        case T.RELAY:
            if (member) relayControl(member, body);
            return;
        case T.PUBLISH: {
            // El anfitrión anuncia su grupo (o lo retira con cuerpo vacío): aparece en FIND para su juego.
            if (!member || !member.room.gameId || member.index !== 0)
                return sendError(socket, E.BAD_REQUEST, 'solo el anfitrión puede publicar');
            const { room } = member;
            if (body.length === 0) {
                room.published = null;
            } else {
                if (body.length !== NETWORK_INFO_SIZE) return sendError(socket, E.BAD_REQUEST, 'grupo no válido');
                if (rejectUnresolvedLcid(socket, body.readBigUInt64LE(0))) return;
                const connected = networkMembers(member, body);
                if (!connected) return sendError(socket, E.BAD_REQUEST, 'grupo no válido');
                const first = !room.published;
                room.published = { member, info: sanitizeNetworkInfo(room, body), lcid: room.gameId, connected };
                for (const station of connected) {
                    clearTimeout(station.admission);
                    station.admission = null;
                }
                if (first) stats.count('groupsPublished');
                if (first) log(`sala ${room.code}: grupo publicado (juego ${room.gameId.toString(16)})`);
            }
            matches.roomChanged(room);
            return;
        }
        case T.FIND: {
            if (![0, 8, 14, 15].includes(body.length)) return sendError(socket, E.BAD_REQUEST, 'FIND no válido');
            if (body.length >= 8 && rejectUnresolvedLcid(socket, body.readBigUInt64LE(0))) return;
            if (!allowed(ip, 'find')) return sendError(socket, E.BUSY, 'demasiadas búsquedas');
            // Origen (byte 14): 1 = la lista de la app (se refresca cada pocos segundos), 0 = un juego buscando grupo.
            const fromApp = body.length >= 15 && body[14] === 1;
            if (!fromApp) stats.count('finds');
            stats.noteSearch(ip, fromApp ? 'app' : 'game');
            // Grupos abiertos de un juego (0: todos), con sitio libre; los que tienen más gente primero. Con un código
            // después del juego (el grupo elegido en la app), ese va el primero aunque haya muchos.
            const lcid = body.length >= 8 ? body.readBigUInt64LE(0) : 0n;
            const preferred = body.length >= 14 && body[8] ? body.subarray(8, 14).toString('ascii').toUpperCase() : '';
            const found = [...rooms.values()]
                .filter((r) => isOpen(r) && (!lcid || r.gameId === lcid))
                .sort((a, b) => (b.code === preferred) - (a.code === preferred) ||
                    b.published.info[NODE_COUNT] - a.published.info[NODE_COUNT])
                .slice(0, MAX_GROUPS);
            const parts = [Buffer.from([found.length])];
            for (const r of found) parts.push(Buffer.from(r.code, 'ascii'), r.published.info);
            return send(socket, T.GROUPS, Buffer.concat(parts));
        }
        case T.RESERVE:
        case T.CANCEL: {
            if (socket.virtual || (type === T.RESERVE && member))
                return sendError(socket, E.BAD_REQUEST, 'reserva no válida');
            if (type === T.RESERVE && body.length === 122 && rejectUnresolvedLcid(socket, body.readBigUInt64LE(16))) return;
            if (!allowed(ip, 'match')) return sendError(socket, E.BUSY, 'demasiadas peticiones de búsqueda');
            const match = type === T.RESERVE ? matches.poll(body, ip) : matches.cancel(body, ip);
            if (match.error === 'busy') return sendError(socket, E.BUSY, 'demasiadas reservas');
            if (match.error === 'missing') return sendError(socket, E.NO_SEAT, 'la reserva ya no está disponible');
            if (match.error) return sendError(socket, E.BAD_REQUEST, 'reserva no válida');
            const reply = Buffer.alloc(5);
            reply[0] = match.state;
            reply.writeUInt32LE(match.ttl, 1);
            if (match.state === matchmaking.STATUS.ASSIGNED)
                return send(socket, T.RESERVATION, Buffer.concat([reply, Buffer.from(match.room.code, 'ascii'), match.room.published.info]));
            return send(socket, T.RESERVATION, reply);
        }
        case T.CAPS: {
            if (body.length !== 0) return sendError(socket, E.BAD_REQUEST, 'CAPS no válido');
            const reply = Buffer.alloc(4);
            reply.writeUInt32LE(SELF_CAPABILITIES);
            return send(socket, T.CAPABILITIES, reply);
        }
        case T.META_SET: {
            const result = roomMetadata.set(member, body);
            if (result.error === 'rate') return sendError(socket, E.BUSY, 'demasiadas actualizaciones del nombre del juego');
            if (result.error) return sendError(socket, E.BAD_REQUEST, 'metadatos del anfitrión no válidos');
            return;
        }
        case T.FIND_META_PAGE: {
            if (body.length !== 12) return sendError(socket, E.BAD_REQUEST, 'página de metadatos no válida');
            if (rejectUnresolvedLcid(socket, body.readBigUInt64LE(0))) return;
            if (!allowed(ip, 'find')) return sendError(socket, E.BUSY, 'demasiadas búsquedas');
            stats.noteSearch(ip, 'app');
            const { entries, nextOffset } = groupPage({ rooms: rooms.values(), lcid: body.readBigUInt64LE(0),
                offset: body.readUInt32LE(8), isOpen });
            return send(socket, T.META_PAGE, roomMetadata.page(entries, nextOffset));
        }
        case T.FIND_PAGE: {
            if (body.length !== 12) return sendError(socket, E.BAD_REQUEST, 'FIND_PAGE no válido');
            if (rejectUnresolvedLcid(socket, body.readBigUInt64LE(0))) return;
            if (!allowed(ip, 'find')) return sendError(socket, E.BUSY, 'demasiadas búsquedas');
            stats.noteSearch(ip, 'app');
            const lcid = body.readBigUInt64LE(0);
            const offset = body.readUInt32LE(8);
            const { entries, nextOffset } = groupPage({ rooms: rooms.values(), lcid, offset, isOpen });
            const head = Buffer.alloc(5);
            head.writeUInt32LE(nextOffset);
            head[4] = entries.length;
            return send(socket, T.PAGE, Buffer.concat([head, ...entries.flatMap((room) => [Buffer.from(room.code, 'ascii'), room.published.info])]));
        }
        case T.FIND_FILTER: {
            const query = matchmaking.discoveryRequest(body);
            if (!query) return sendError(socket, E.BAD_REQUEST, 'filtro de búsqueda no válido');
            if (rejectUnresolvedLcid(socket, query.criteria.gameId)) return;
            if (!allowed(ip, 'find')) return sendError(socket, E.BUSY, 'demasiadas búsquedas');
            stats.noteSearch(ip, 'game');
            const { entries, nextOffset } = groupPage({ rooms: rooms.values(), offset: query.offset, isOpen,
                matches: (room) => matchmaking.matches(room, query.criteria) });
            const head = Buffer.alloc(5);
            head.writeUInt32LE(nextOffset);
            head[4] = entries.length;
            return send(socket, T.PAGE, Buffer.concat([head, ...entries.flatMap((room) => [Buffer.from(room.code, 'ascii'), room.published.info])]));
        }
        case T.TCP_STREAM: {
            if (!member) return sendError(socket, E.BAD_REQUEST, 'stream requires room membership');
            if (!allowDatagram(member, body.length + 3, TCP_OVERHEAD)) {
                streams.closeMember(member, streamProtocol.REASON.BACKPRESSURE);
                return sendError(socket, E.BUSY, 'game stream traffic limit reached');
            }
            const result = streams.handle(member, body);
            if (!result.ok && result.reason === 'invalid') sendError(socket, E.BAD_REQUEST, 'invalid game stream frame');
            return;
        }
        case T.PING:
            if (body.length !== 0) return sendError(socket, E.BAD_REQUEST, 'PING no válido');
            return send(socket, T.PONG);
        default:
            return sendError(socket, E.BAD_REQUEST, `tipo ${type} desconocido`);
    }
}

const tcp = net.createServer((socket) => {
    const ip = plainIp(socket.remoteAddress);
    const open = (connections.get(ip) || 0) + 1;
    if (open > LIMITS.connectionsPerIp || totalConnections >= LIMITS.connectionsTotal) {
        stats.count('rateLimited');
        socket.destroy();
        return;
    }
    connections.set(ip, open);
    totalConnections++;
    socket.setNoDelay(true);
    socket.setTimeout(IDLE_MS);
    const inbound = inboundDeadline.create(socket, IDLE_MS);
    let pending = Buffer.alloc(0);
    let second = 0, frames = 0, streamFrames = 0, streamBytes = 0, frameTimer = null;
    socket.on('data', (chunk) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 2) {
            const len = pending.readUInt16LE(0);
            if (len < 1 || len > 4096) return socket.destroy();
            if (pending.length < 2 + len) break;
            const frame = pending.subarray(2, 2 + len);
            pending = pending.subarray(2 + len);
            clearTimeout(frameTimer);
            frameTimer = null;
            const now = Math.floor(Date.now() / 1000);
            if (second !== now) { second = now; frames = streamFrames = streamBytes = 0; }
            const streaming = frame[0] === T.TCP_STREAM;
            if (streaming) { streamFrames++; streamBytes += frame.length + 2 + TCP_OVERHEAD; }
            if (streaming ? (streamFrames > LIMITS.dataPackets || streamBytes > LIMITS.dataBytes) : ++frames > LIMITS.controlFrames) {
                stats.count('rateLimited');
                return socket.destroy();
            }
            if (inboundDeadline.knownCommand(frame[0], frame.subarray(1))) inbound.touch();
            onFrame(socket, frame.readUInt8(0), frame.subarray(1));
            if (socket.destroyed || socket.writableEnded) return;
        }
        if (pending.length && !frameTimer) frameTimer = setTimeout(() => socket.destroy(), IDLE_MS);
    });
    socket.on('timeout', () => socket.destroy());
    socket.on('close', () => {
        inbound.close();
        clearTimeout(frameTimer);
        totalConnections--;
        const n = (connections.get(ip) || 1) - 1;
        if (n > 0) connections.set(ip, n); else connections.delete(ip);
        if (socket.member) detach(socket.member);
        upstreams.onClose(socket);
        checkShutdown();
    });
    socket.on('error', () => {});
});

const udp = dgram.createSocket('udp4');
function udpSend(buf, port, address) {
    if (udp.getSendQueueSize() + buf.length > MAX_UDP_QUEUE) return;
    udp.send(buf, port, address, (err) => { if (err) stats.count('udpSendErrors'); });
    count(buf.length + UDP_OVERHEAD);
}

function allowDatagram(member, bytes, overhead = UDP_OVERHEAD) {
    const second = Math.floor(Date.now() / 1000);
    if (!member.dataRate || member.dataRate.second !== second) member.dataRate = { second, bytes: 0, packets: 0 };
    const rate = member.dataRate;
    rate.bytes += bytes + overhead;
    rate.packets++;
    return rate.bytes <= LIMITS.dataBytes && rate.packets <= LIMITS.dataPackets;
}

udp.on('message', (msg, rinfo) => {
    if (upstreams.handleDatagram(msg, rinfo)) return;
    if (msg.length < 9 || msg.readUInt32LE(0) !== UDP_MAGIC) return;
    const type = msg.readUInt8(4);
    const member = byToken.get(msg.readUInt32LE(5));
    // Solo se acepta UDP desde la misma IP pública que la conexión de control: así nadie puede, con un token
    // adivinado o capturado, hacer que el servidor envíe tráfico a la dirección de otro (ataque de reflexión).
    if (!active(member) || rinfo.address !== member.publicIp || paused) return;
    if (type === U.REGISTER || type === U.KEEPALIVE) {
        if (msg.length !== 9 || (type === U.KEEPALIVE && !member.udp)) return;
    } else if (type === U.REGISTER_V2) {
        if (msg.length !== 13 || !msg.readUInt32LE(9) || (msg.readUInt32LE(9) & ~UDP_FEATURES)) return;
    } else if (type === U.HEARTBEAT) {
        if (msg.length !== 13 || !member.udp || !(member.udpFeatures & 8)) return;
    } else if (type === U.FRAGMENT) {
        if (!member.udp || !(member.udpFeatures & 4) || msg.length <= 25 || msg.length > 25 + FRAGMENT_CHUNK) return;
    } else if (type === U.DATA) {
        if (!member.udp || msg.length < 17 || msg.length - 17 > MAX_PAYLOAD) return;
    } else {
        return;
    }
    if (!allowDatagram(member, msg.length)) return;
    member.udp = { address: rinfo.address, port: rinfo.port };  // el router puede haber cambiado el puerto

    if (type === U.REGISTER || type === U.REGISTER_V2) {
        fragments.clear(member);
        member.udpFeatures = type === U.REGISTER_V2 ? msg.readUInt32LE(9) : 0;
        const reply = Buffer.alloc(type === U.REGISTER ? 5 : 9);
        reply.writeUInt32LE(UDP_MAGIC, 0);
        reply.writeUInt8(type === U.REGISTER ? U.REGISTERED : U.REGISTERED_V2, 4);
        if (type === U.REGISTER_V2) reply.writeUInt32LE(member.udpFeatures, 5);
        udpSend(reply, rinfo.port, rinfo.address);
    } else if (type === U.HEARTBEAT) {
        const reply = Buffer.alloc(9);
        reply.writeUInt32LE(UDP_MAGIC); reply[4] = U.HEARTBEAT_ACK;
        msg.copy(reply, 5, 9, 13);
        udpSend(reply, rinfo.port, rinfo.address);
    } else if (type === U.FRAGMENT) {
        const payload = fragments.push(member, msg.readUInt32LE(17), msg.subarray(9, 17).toString('hex'),
            msg.readUInt16LE(21), msg.readUInt16LE(23), msg.subarray(25));
        if (payload) forwardData(member, msg.readUInt32LE(9), Buffer.concat([msg.subarray(13, 17), payload]), true);
    } else if (type === U.DATA) {
        forwardData(member, msg.readUInt32LE(9), msg.subarray(13), true);
    }
});

// Paquete del juego de un miembro hacia otro de su sala (o a todos si dst es broadcast). ports_payload: puerto
// origen (u16) · puerto destino (u16) · carga.
let outboundMessageId = crypto.randomBytes(4).readUInt32LE();
function unsupportedDatagram(member, reason = 'el destinatario necesita actualizar el transporte UDP') {
    stats.count('unsupportedDatagrams');
    const now = Date.now();
    if (!member.lastUnsupported || now - member.lastUnsupported >= 1000) {
        member.lastUnsupported = now;
        sendError(member.socket, E.DATA_UNSUPPORTED, reason);
    }
}

function forwardData(member, dst, portsPayload, rateChecked = false) {
    if (paused || !active(member) || portsPayload.length < 4 || portsPayload.length - 4 > MAX_GAME_PAYLOAD) return;
    const { room } = member;
    const published = room.published;
    if (room.gameId && (!published || !active(room.members[0]) || !published.connected.has(member))) return;
    if (!rateChecked && !allowDatagram(member, portsPayload.length + 13)) return;
    const out = Buffer.alloc(portsPayload.length + 9);
    out.writeUInt32LE(UDP_MAGIC, 0);
    out.writeUInt8(U.DATA_IN, 4);
    out.writeUInt32LE(member.ip, 5);
    portsPayload.copy(out, 9);
    for (const m of others(room, member)) {
        if (paused) break;
        if (!active(m) || (room.gameId && !published.connected.has(m))) continue;
        if (!(BROADCASTS.has(dst) || m.ip === dst)) continue;
        if (m.socket.virtual) m.socket.data(member, dst, portsPayload);
        else if (m.udp) {
            const payload = portsPayload.subarray(4);
            if ((m.udpFeatures & 4) && payload.length > FRAGMENT_CHUNK) {
                const id = outboundMessageId = (outboundMessageId + 1) >>> 0;
                for (let offset = 0; offset < payload.length && !paused; offset += FRAGMENT_CHUNK) {
                    const chunk = payload.subarray(offset, offset + FRAGMENT_CHUNK);
                    const packet = Buffer.alloc(21 + chunk.length);
                    packet.writeUInt32LE(UDP_MAGIC); packet[4] = U.FRAGMENT_IN;
                    packet.writeUInt32LE(member.ip, 5); portsPayload.copy(packet, 9, 0, 4);
                    packet.writeUInt32LE(id, 13); packet.writeUInt16LE(payload.length, 17); packet.writeUInt16LE(offset, 19);
                    chunk.copy(packet, 21); udpSend(packet, m.udp.port, m.udp.address);
                }
            } else if (payload.length <= LEGACY_DOWNLINK_PAYLOAD) udpSend(out, m.udp.port, m.udp.address);
            else unsupportedDatagram(member);
        }
    }
}

checkMonth();

// Lo que muestra el panel en cada momento: consolas conectadas (miembros de salas con su conexión abierta), salas,
// grupos abiertos y jugadores por juego.
function snapshot() {
    let online = 0, privateRooms = 0, groups = 0, players = 0;
    const byGame = new Map();
    for (const r of rooms.values()) {
        online += r.members.filter((m) => m && m.socket).length;
        if (r.gameId === 0n) privateRooms++;
        if (!r.published || !active(r.members[0])) continue;
        const n = r.published.info[NODE_COUNT];
        groups++;
        players += n;
        const key = r.published.lcid.toString(16).padStart(16, '0');
        const g = byGame.get(key) || { game: key, groups: 0, players: 0 };
        g.groups++;
        g.players += n;
        byGame.set(key, g);
    }
    const upstream = upstreams.snapshot();
    return { online: online + upstream.activeMembers, rooms: rooms.size + upstream.rooms,
             privateRooms: privateRooms + upstream.privateRooms, groups, players, upstream,
             providerEvents: providerDiagnostics.snapshot(), realms: realms?.snapshot() || [], tcpStreams: streams.snapshot(),
             byGame: [...byGame.values()].sort((a, b) => b.players - a.players) };
}
// Grupos abiertos para la web pública: lo mismo que la lista de la app, sin el código de la sala.
function publicGroups() {
    const out = [];
    for (const r of rooms.values()) {
        if (!isOpen(r)) continue;
        const info = r.published.info, players = info[NODE_COUNT], max = info[NODE_MAX];
        const name = info.subarray(NODES + 12, NODES + 45);
        const end = name.indexOf(0);
        out.push({ game: r.published.lcid.toString(16).padStart(16, '0'), host: name.subarray(0, end < 0 ? name.length : end).toString('utf8'),
                   players, max });
    }
    return out.sort((a, b) => b.players - a.players).slice(0, 50);
}
require('./public').create({ stateDir: path.dirname(STATE_FILE), port: PUBLIC_PORT, snapshot, groups: publicGroups });
// Pasarela LAN Play (Ryujinx): miembros virtuales que usan las mismas salas.
const memberAt = (ip) => byIp13.get(ip) || null;
const lanplay = require('./lanplay').create({
    port: LANPLAY_PORT, upstream: realmProvider || null,
    onReady: () => { realmTransportReady = true; realmReady(); },
    onFirstScanSent: () => {
        if (realmId && !realmFirstDiscoveryWindow && !realmDiscoveryTimer) {
            // This is a bounded initial discovery window, not a claim that all peers have answered.
            realmDiscoveryTimer = setTimeout(() => { realmFirstDiscoveryWindow = true; realmReady(); }, 1500).unref();
        }
    },
    onFailure: () => { if (realmId) { process.send?.({type:'failed'}); beginShutdown(); } },
    log, rooms, count: bytes => { count(bytes); if (realmId) realmTraffic += bytes; }, paused: () => paused, memberAt, isOpen,
    frame: (socket, type, body) => onFrame(socket, type, body),
    forwardData,
    dataUnsupported: (member, reason) => {
        if (member && active(member)) unsupportedDatagram(member, reason);
    },
});
stats = require('./stats').create({ stateDir: path.dirname(STATE_FILE), port: STATS_PORT, snapshot, traffic,
                                    capBytes: CAP_BYTES, paused: () => paused });
if (OPS_PORT) require('./operations').create({ port: OPS_PORT, status: () => {
    if (draining) return 'draining';
    if (!ready) return 'booting';
    return paused ? 'paused' : 'ready';
}, drain: beginDrain, token: process.env.LANYWHERE_OPS_TOKEN });

function beginDrain() {
    if (draining) return;
    draining = true;
    matches.drain();
    log('cerrando: no se aceptan nuevas salas ni uniones');
}

let finishing = false;
async function finishShutdown() {
    if (finishing) return; finishing = true;
    clearTimeout(realmDiscoveryTimer);
    clearInterval(streamSweep);
    streams.shutdown();
    upstreams.shutdown();
    lanplay?.close();
    if (realms) await realms.shutdown();
    saveTraffic();
    stats.save();
    process.exit(0);
}

function checkShutdown() {
    if (shutdownTimer && !upstreams.activeMembers() && ![...rooms.values()].some((room) => room.members.some(active))) finishShutdown();
}

function beginShutdown() {
    if (shutdownTimer) return;
    beginDrain();
    shutdownTimer = setTimeout(finishShutdown, SHUTDOWN_GRACE_MS);
    checkShutdown();
}

setInterval(() => { checkMonth(); saveTraffic(); }, 60000).unref();
process.on('SIGUSR2', beginDrain);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, beginShutdown);

tcp.listen({ port: PORT, ...(CONTROL_BIND_ADDRESS ? { host: CONTROL_BIND_ADDRESS } : {}) }, () => {
    const port = tcp.address().port;
    log(`control TCP en ${port}; tráfico del mes ${(traffic.bytes / 1e9).toFixed(2)} GB de ${CAP_BYTES / 1e9} GB`);
    udp.bind(port, UDP_BIND_ADDRESS, () => {
        ready = true; realmNativePort = port; realmReady();
        log(`datos UDP en ${port}`);
    });
});

module.exports = { rooms, cleanNick, lanplay };
