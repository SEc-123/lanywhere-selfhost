'use strict';
// Pasarela LAN Play: deja que un emulador con modo "LAN Play" (el protocolo de switch-lan-play) entre en la red de
// LANywhere.
//
// Por dentro de LAN Play viaja el mismo modo local de ldn_mitm que usan las consolas, pero como paquetes IPv4 en
// una red virtual 10.13.0.0/16: búsqueda por broadcast UDP al puerto 11452, unión por TCP al 11452 del anfitrión y
// los paquetes del juego por UDP. Aquí:
//  - Se reenvía entre emuladores como un servidor de LAN Play normal (por la IP de destino).
//  - Los grupos abiertos de consolas aparecen al emulador que busca, y unirse lo mete en la sala como un miembro
//    virtual (con su misma IP 10.13).
//  - Los grupos que crea un emulador se publican como grupos abiertos de LANywhere, y las consolas que se unen
//    llegan al emulador por una conexión TCP que abre la pasarela en su nombre.
//  - Las salas que se cruzan con LAN Play usan la misma red 10.13.0.0/16 (server.js da a cada consola una IP única),
//    así que las direcciones no se traducen: el juego también las lleva dentro de sus paquetes.
//
// No hace falta cuenta ni contraseña: los emuladores usan los grupos abiertos.

const dgram = require('dgram');
const crypto = require('crypto');
const Fork = require('./lanplay-fork');
const ForkTcp = require('./lanplay-fork-tcp');
const StreamWire = require('./tcp-stream-protocol');

// --- LAN Play -----------------------------------------------------------------------------------------------------
const P = { KEEPALIVE: 0x00, IPV4: 0x01, PING: 0x02, IPV4_FRAG: 0x03, AUTH_ME: 0x04, INFO: 0x10 };
const NET = 0x0a0d0000, MASK = 0xffff0000, BCAST = (NET | ~MASK) >>> 0;  // 10.13.0.0/16, 10.13.255.255
const GATEWAY_IP = (NET | 0xfefe) >>> 0;                                 // 10.13.254.254: la pasarela al buscar
const CLIENT_IDLE_MS = 40000;
const MAX_CLIENTS_PER_IP = 8;
const LDN_PORT = 11452;
const SCAN_EVERY_MS = 3000;           // la pasarela pregunta a los emuladores si tienen grupo
const HOST_GONE_MS = 10000;           // sin respuesta a la búsqueda en este tiempo: el grupo se retira
const FRAG_MS = 5000, MAX_REASSEMBLY = 256;
const MAX_REASSEMBLY_BYTES = 4 * 1024 * 1024, MAX_FRAGMENT_PARTS = 256;
const MAX_IP_BODY = 65535 - 20, MAX_CLIENTS = 1024, MAX_IPS_PER_CLIENT = 8;
const MAX_TCP_CONNECTIONS = 1024, MAX_TCP_PER_CLIENT = 16, MAX_SEND_QUEUE = 256 * 1024;
const STATS_EVERY_MS = 30000;

// --- ldn_mitm (protocolo del modo local en LAN) --------------------------------------------------------------------
const LAN_MAGIC = 0x11451400;
const LT = { SCAN: 0, SCAN_RESP: 1, CONNECT: 2, SYNC: 3 };
const NETWORK_INFO_SIZE = 0x480, NODE_INFO_SIZE = 0x40, NODES = 0x68, NODE_SIZE = 0x40, MAX_NODES = 8;

// Mensajes de ldn entre miembros de una sala (LdnMsg en el sysmodule).
const LDN = { SCAN: 1, SCAN_RESP: 2, CONNECT: 3, SYNC: 4, DISCONNECT: 5 };
const T = { CREATE: 0x01, JOIN: 0x02, LEAVE: 0x03, RELAY: 0x04, PUBLISH: 0x07,
            ROOM: 0x81, MEMBER_JOINED: 0x82, MEMBER_LEFT: 0x83, RELAY_IN: 0x84, ERROR: 0x85 };
const F_NET13 = Buffer.from([1]);
const F_NET13_FORK_TCP = Buffer.from([1 | StreamWire.MEMBER_FEATURE]);  // último byte de CREATE/JOIN: la sala va en la red 10.13 (ver server.js)

const ipStr = (ip) => [ip >>> 24, (ip >>> 16) & 255, (ip >>> 8) & 255, ip & 255].join('.');

// --- IPv4 / UDP / TCP --------------------------------------------------------------------------------------------
function sum16(buf, acc = 0) {
    for (let i = 0; i + 1 < buf.length; i += 2) acc += buf.readUInt16BE(i);
    if (buf.length & 1) acc += buf[buf.length - 1] << 8;
    return acc;
}
function fold(acc) {
    while (acc > 0xffff) acc = (acc & 0xffff) + (acc >>> 16);
    return (~acc) & 0xffff;
}
function pseudo(src, dst, proto, len) {
    const b = Buffer.alloc(12);
    b.writeUInt32BE(src, 0); b.writeUInt32BE(dst, 4); b[9] = proto; b.writeUInt16BE(len, 10);
    return sum16(b);
}
let ipId = 1;
function ipv4(src, dst, proto, payload) {
    const h = Buffer.alloc(20);
    h[0] = 0x45; h.writeUInt16BE(20 + payload.length, 2); h.writeUInt16BE(ipId++ & 0xffff, 4);
    h[8] = 64; h[9] = proto; h.writeUInt32BE(src, 12); h.writeUInt32BE(dst, 16);
    h.writeUInt16BE(fold(sum16(h)), 10);
    return Buffer.concat([h, payload]);
}
function udpPacket(src, sport, dst, dport, data) {
    const u = Buffer.alloc(8 + data.length);
    u.writeUInt16BE(sport, 0); u.writeUInt16BE(dport, 2); u.writeUInt16BE(u.length, 4);
    data.copy(u, 8);
    u.writeUInt16BE(fold(sum16(u, pseudo(src, dst, 17, u.length))) || 0xffff, 6);
    return ipv4(src, dst, 17, u);
}
// Un paquete de 1500 bytes no cabe en un datagrama por internet con la cabecera de LAN Play: los grandes se parten en
// fragmentos IP (los clientes de LAN Play los reensamblan).
const MAX_WIRE_IPV4 = 1400;
function fragmentIpv4(pkt) {
    const ihl = (pkt[0] & 15) * 4, data = pkt.subarray(ihl), out = [];
    const flags = pkt.readUInt16BE(6);
    if (flags & 0x4000 || flags & 0x3fff) return [pkt];  // DF o ya es un fragmento: tal cual
    const step = (MAX_WIRE_IPV4 - ihl) & ~7;
    for (let off = 0; off < data.length; off += step) {
        const part = data.subarray(off, off + step);
        const h = Buffer.from(pkt.subarray(0, ihl));
        h.writeUInt16BE(ihl + part.length, 2);
        h.writeUInt16BE((off + step < data.length ? 0x2000 : 0) | (off / 8), 6);
        h.writeUInt16BE(0, 10);
        h.writeUInt16BE(fold(sum16(h)), 10);
        out.push(Buffer.concat([h, part]));
    }
    return out;
}
function parseIpv4(pkt) {
    if (pkt.length < 20 || (pkt[0] >> 4) !== 4) return null;
    const ihl = (pkt[0] & 15) * 4, total = pkt.readUInt16BE(2);
    if (ihl < 20 || total < ihl || total > pkt.length) return null;
    const frag = pkt.readUInt16BE(6);
    return { proto: pkt[9], src: pkt.readUInt32BE(12), dst: pkt.readUInt32BE(16), body: pkt.subarray(ihl, total),
             id: pkt.readUInt16BE(4), mf: (frag & 0x2000) !== 0, off: (frag & 0x1fff) * 8 };
}

// --- ldn_mitm: tramas con cabecera de 12 bytes y compresión RLE de ceros ------------------------------------------
function ldnFrame(type, data = Buffer.alloc(0)) {
    const h = Buffer.alloc(12);
    h.writeUInt32LE(LAN_MAGIC, 0); h[4] = type; h[5] = 0; h.writeUInt16LE(data.length, 6);
    return Buffer.concat([h, data]);
}
function rleDecompress(input, expected) {
    const out = Buffer.alloc(expected);
    let o = 0;
    for (let i = 0; i < input.length && o < expected; ) {
        const c = input[i++];
        out[o++] = c;
        if (c === 0) {
            if (i >= input.length) return null;
            for (let n = input[i++]; n > 0 && o < expected; n--) out[o++] = 0;
        }
    }
    return o === expected ? out : null;
}
// Lee tramas de un flujo (TCP) o de un datagrama (UDP). Devuelve [{type, data}] y deja el resto en state.buf.
function ldnRead(state, chunk) {
    state.buf = state.buf ? Buffer.concat([state.buf, chunk]) : chunk;
    const out = [];
    while (state.buf.length >= 12) {
        if (state.buf.readUInt32LE(0) !== LAN_MAGIC) { state.buf = Buffer.alloc(0); break; }
        const len = state.buf.readUInt16LE(6);
        if (state.buf.length < 12 + len) break;
        let data = state.buf.subarray(12, 12 + len);
        if (state.buf[5]) data = rleDecompress(data, state.buf.readUInt16LE(8));
        const type = state.buf[4], seq = state.buf.readUInt16LE(10);
        state.buf = state.buf.subarray(12 + len);
        if (data) out.push({ type, seq, data: Buffer.from(data) });
    }
    return out;
}

// --- TCP mínimo: lo justo para la conversación de unión de ldn_mitm (pocos mensajes pequeños) ---------------------
const TF = { FIN: 1, SYN: 2, RST: 4, PSH: 8, ACK: 16 };
const MSS = 1360, RTO_START = 300, RTO_MAX = 4000, MAX_RETRIES = 10;

class Tcp {
    // send(pkt): entrega un paquete IPv4 al otro lado. Eventos: onData(buf), onOpen(), onClose().
    constructor(local, lport, remote, rport, send) {
        Object.assign(this, { local, lport, remote, rport, send });
        this.state = 'closed';
        this.snd = crypto.randomBytes(4).readUInt32BE(0);  // siguiente número de secuencia a enviar
        this.una = this.snd;                               // el más antiguo sin confirmar
        this.rcv = 0;
        this.queue = [];                                   // segmentos enviados sin confirmar
        this.pending = [];                                 // datos que aún no caben (ventana)
        this.rto = RTO_START;
        this.timer = null;
        this.onData = this.onOpen = this.onClose = () => {};
    }
    key() { return Tcp.key(this.local, this.lport, this.remote, this.rport); }
    static key(a, ap, b, bp) { return `${a}:${ap}-${b}:${bp}`; }

    segment(flags, data = Buffer.alloc(0), seq = this.snd) {
        const t = Buffer.alloc(20 + data.length);
        t.writeUInt16BE(this.lport, 0); t.writeUInt16BE(this.rport, 2);
        t.writeUInt32BE(seq >>> 0, 4); t.writeUInt32BE(flags & TF.ACK ? this.rcv >>> 0 : 0, 8);
        t[12] = 5 << 4; t[13] = flags; t.writeUInt16BE(0xffff, 14);
        data.copy(t, 20);
        t.writeUInt16BE(fold(sum16(t, pseudo(this.local, this.remote, 6, t.length))), 16);
        this.send(ipv4(this.local, this.remote, 6, t));
    }
    // Envía con retransmisión hasta que se confirme (SYN y FIN ocupan un número de secuencia).
    reliable(flags, data = Buffer.alloc(0)) {
        const len = data.length + (flags & (TF.SYN | TF.FIN) ? 1 : 0);
        const seg = { seq: this.snd, flags, data, end: (this.snd + len) >>> 0 };
        this.snd = seg.end;
        this.queue.push(seg);
        this.segment(flags, data, seg.seq);
        this.arm();
    }
    arm() {
        if (this.timer || !this.queue.length) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            if (!this.queue.length) return;
            if (++this.retries > MAX_RETRIES) return this.abort();
            this.rto = Math.min(this.rto * 2, RTO_MAX);
            for (const s of this.queue) this.segment(s.flags | (this.state === 'syn-sent' ? 0 : TF.ACK), s.data, s.seq);
            this.arm();
        }, this.rto);
        this.timer.unref?.();
        this.retries = this.retries || 0;
    }
    connect() {
        this.state = 'syn-sent';
        this.reliable(TF.SYN);
    }
    accept(seq) {
        this.rcv = (seq + 1) >>> 0;
        this.state = 'syn-received';
        this.reliable(TF.SYN | TF.ACK);
    }
    write(buf) {
        for (let i = 0; i < buf.length; i += MSS) this.reliable(TF.ACK | TF.PSH, buf.subarray(i, i + MSS));
    }
    close() {
        if (this.state === 'established' || this.state === 'close-wait') {
            this.state = this.state === 'close-wait' ? 'last-ack' : 'fin-wait';
            this.reliable(TF.FIN | TF.ACK);
        } else {
            this.abort();
        }
    }
    abort() {
        if (this.state === 'gone') return;
        if (this.state !== 'closed') this.segment(TF.RST | TF.ACK);
        this.finish();
    }
    finish() {
        clearTimeout(this.timer);
        this.timer = null;
        const was = this.state;
        this.state = 'gone';
        this.queue = [];
        if (was !== 'gone') this.onClose();
    }
    // Segmento recibido para esta conexión.
    input(t) {
        if (t.length < 20) return;
        const seq = t.readUInt32BE(4), ack = t.readUInt32BE(8), off = (t[12] >> 4) * 4, flags = t[13];
        const data = t.subarray(off);
        if (flags & TF.RST) return this.finish();
        if (this.state === 'syn-sent') {
            if ((flags & TF.SYN) && (flags & TF.ACK) && ack === this.snd) {
                this.rcv = (seq + 1) >>> 0;
                this.acked(ack);
                this.state = 'established';
                this.segment(TF.ACK);
                this.onOpen();
            }
            return;
        }
        if (flags & TF.SYN) {  // nuestro SYN-ACK se perdió y el otro repite el SYN
            if (this.state === 'syn-received') this.segment(TF.SYN | TF.ACK, Buffer.alloc(0), (this.snd - 1) >>> 0);
            return;
        }
        if (flags & TF.ACK) this.acked(ack);
        if (this.state === 'syn-received' && (flags & TF.ACK) && ack === this.snd) {
            this.state = 'established';
            this.onOpen();
        }
        let advanced = false;
        if (data.length) {
            if (seq === this.rcv) {
                this.rcv = (this.rcv + data.length) >>> 0;
                advanced = true;
                this.onData(Buffer.from(data));
            }
            this.segment(TF.ACK);  // confirmar (o volver a pedir lo que falta)
        }
        if ((flags & TF.FIN) && ((seq + data.length) >>> 0) === this.rcv) {
            this.rcv = (this.rcv + 1) >>> 0;
            this.segment(TF.ACK);
            if (this.state === 'established') {
                this.state = 'close-wait';
                this.close();  // cerramos también: no hay nada más que enviar
            } else if (this.state === 'fin-wait') {
                this.finish();
            }
        } else if (!advanced && !data.length && this.state === 'last-ack' && !this.queue.length) {
            this.finish();
        }
        if (this.state === 'fin-wait' && !this.queue.length && (flags & TF.FIN)) this.finish();
    }
    acked(ack) {
        const before = this.queue.length;
        this.queue = this.queue.filter((s) => ((ack - s.end) | 0) < 0);
        if (this.queue.length !== before) {
            this.retries = 0;
            this.rto = RTO_START;
            clearTimeout(this.timer);
            this.timer = null;
            this.arm();
        }
        if (this.state === 'last-ack' && !this.queue.length) this.finish();
    }
}

// --- La pasarela -------------------------------------------------------------------------------------------------
function create({ port, log, rooms, count, paused, frame, forwardData, memberAt, isOpen,
                  dataBytes = 512 * 1024, dataPackets = 1000, upstream = null, onReady = () => {}, onFailure = () => {},
                  dataUnsupported = () => {}, onFirstScanSent = () => {} }) {
    if (!port && !upstream) return null;
    const sock = dgram.createSocket('udp4');
    // A client transport has exactly one pinned, allowlisted relay endpoint.
    let upstreamClient = null, closed = false, confirmed = false, pingNonce = null;
    const sendQueue = []; let queuedBytes = 0, sendTimer = null;
    function flushUpstream() {
        sendTimer = null;
        if (closed || paused()) { sendQueue.length = 0; queuedBytes = 0; return; }
        const item = sendQueue.shift(); if (!item) return;
        queuedBytes -= item.b.length;
        sock.send(item.b, item.client.port, item.client.address, err => {
            if (err && !closed) onFailure(err); else if (!err && !closed) item.onSent?.();
        });
        count(item.b.length + 28);
        if (sendQueue.length) sendTimer = setTimeout(flushUpstream, 15).unref();
    }
    const gatewayIp = upstream ? (NET | (1 + crypto.randomInt(65533))) >>> 0 : GATEWAY_IP;
    const resolve = require('node:dns').promises.lookup;

    const clients = new Map();   // "ip:puerto" del emulador → { address, port, seen, ips:Set }
    const byIp = new Map();      // IP 10.13 → cliente (aprendida del origen de sus paquetes)
    const tcps = new Map();      // conexiones TCP de la pasarela
    const bridges = new Map();   // código de sala → puente (ver bridge())
    const forkPorts = ForkTcp.portPool();
    const perIp = new Map();
    const rates = new Map();
    const reassembly = new Map();  // endpoint generation + source/destination/id → bounded assembly
    let reassemblyBytes = 0, nextClientId = 1;
    // Paquetes del juego entre emuladores y consolas (para el registro).
    const traffic = { up: 0, upBytes: 0, upMax: 0, down: 0, downBytes: 0, downMax: 0, frags: 0, relayFrags: 0, udp: 0, miss: 0, missDst: 0 };
    let trafficLogged = '';
    // Consola (miembro no virtual de una sala en la red 10.13) con esa IP: la pasarela responde por ella.
    const consoleAt = (ip) => {
        const m = memberAt(ip);
        return m && !(m.socket && m.socket.virtual) ? m : null;
    };

    function allowTraffic(address, direction, bytes) {
        const second = Math.floor(Date.now() / 1000);
        let rate = rates.get(address);
        if (!rate || rate.second !== second) {
            if (!rate && rates.size >= MAX_CLIENTS * 2) return false;
            rates.set(address, (rate = { second, inBytes: 0, inPackets: 0, outBytes: 0, outPackets: 0 }));
        }
        rate[`${direction}Bytes`] += bytes;
        rate[`${direction}Packets`]++;
        return rate[`${direction}Bytes`] <= dataBytes && rate[`${direction}Packets`] <= dataPackets;
    }
    function ownsSource(client, ip, learn = false) {
        if (((ip & MASK) >>> 0) !== NET || ip === NET || ip === BCAST || ip === gatewayIp || consoleAt(ip)) return false;
        const owner = byIp.get(ip);
        if (owner) return owner === client;
        if (!learn || client.ips.size >= (upstream ? 128 : MAX_IPS_PER_CLIENT)) return false;
        byIp.set(ip, client);
        client.ips.add(ip);
        return true;
    }
    function dropAssembly(key) {
        const r = reassembly.get(key);
        if (r) reassemblyBytes -= r.bytes;
        reassembly.delete(key);
    }
    function canOpenTcp(client) {
        return client && tcps.size < MAX_TCP_CONNECTIONS &&
            [...tcps.values()].filter((t) => t.endpoint === client).length < MAX_TCP_PER_CLIENT;
    }

    // relayed: el paquete viene de otro emulador tal cual; si cupo al llegar, cabe al salir y no se parte.
    function sendTo(client, type, payload, relayed = false, onSent = null) {
        if (!client || paused()) return false;
        if (type === P.IPV4 && !relayed && payload.length > MAX_WIRE_IPV4) {
            // Do not recurse forever if a packet has DF set or was already fragmented.
            for (const f of fragmentIpv4(payload)) sendTo(client, type, f, true);
            return;
        }
        const b = Buffer.concat([Buffer.from([type]), payload]);
        if (!allowTraffic(client.address, 'out', b.length + 28) ||
            queuedBytes + (sock.getSendQueueSize?.() || 0) + b.length > MAX_SEND_QUEUE) return false;
        if (upstream) {
            sendQueue.push({client, b, onSent}); queuedBytes += b.length;
            if (!sendTimer) sendTimer = setTimeout(flushUpstream, 15).unref();
            return true;
        }
        sock.send(b, client.port, client.address, (err) => { if (err) log(`lan play: envío UDP falló: ${err.code}`); else onSent?.(); });
        count(b.length + 28);
        return true;
    }
    function deliverIpv4(dst, pkt, except) {
        if (upstream && except === upstreamClient) return; // Never reflect public traffic back to its relay.
        if (dst === BCAST || dst === 0xffffffff) {
            for (const c of clients.values()) if (c !== except) sendTo(c, P.IPV4, pkt, true);
        } else {
            sendTo(byIp.get(dst), P.IPV4, pkt, true);
        }
    }

    // Miembro virtual: un participante del lado LAN Play (un emulador) dentro de una sala, con su IP 10.13.
    function virtualMember(publicAddress, ip13, onFrame, legacyTcp = false) {
        const vs = {
            virtual: true, legacyTcp, destroyed: false, remoteAddress: publicAddress, member: null, ip13,
            endpoint: byIp.get(ip13),
            deliver: (type, body) => {
                if (type === StreamWire.RESPONSE && vs.forkTcp) return vs.forkTcp.receiveControl(body);
                return onFrame(vs, type, body);
            },
            data: (from, dst, portsPayload) => {
                // Paquete de una consola de la sala para el emulador (entre emuladores ya va por LAN Play).
                if ((from.socket && from.socket.virtual) || byIp.get(ip13) !== vs.endpoint) return;
                const sport = portsPayload.readUInt16LE(0), dport = portsPayload.readUInt16LE(2);
                const to = dst === ip13 ? ip13 : BCAST;
                traffic.down++; traffic.downBytes += portsPayload.length - 4;
                traffic.downMax = Math.max(traffic.downMax, portsPayload.length - 4);
                const b = vs.member && bridges.get(vs.member.room.code);
                const real = b?.fork?.realByVirtual.get(ip13);
                if (real) {
                    const payload = Fork.wrap(from.ip, to === BCAST ? 0xffffffff : real, portsPayload.subarray(4));
                    if (!payload) { dataUnsupported(from, 'Fork network supports UDP payloads up to 1472 bytes'); return; }
                    if (!sendForkIp(byIp.get(ip13), Fork.addIpId(udpPacket(from.ip, sport, to, dport, payload), Fork.GAME_V2)))
                        dataUnsupported(from, 'Fork network data queue is full');
                } else sendTo(byIp.get(ip13), P.IPV4, udpPacket(from.ip, sport, to, dport, portsPayload.subarray(4)));
            },
        };
        return vs;
    }

    // Puente de una sala con emuladores.
    //  origin 'console': la sala la creó una consola; los emuladores entran como estaciones.
    //  origin 'emu': el grupo lo creó un emulador; la pasarela publica la sala y une a las consolas.
    function bridge(code, origin) {
        let b = bridges.get(code);
        if (b) return b;
        b = { code, origin,
              emu: new Map(),  // IP 10.13 de un emulador → socket virtual (con .member)
              host13: 0, lastSeen: Date.now(), info: null };
        bridges.set(code, b);
        return b;
    }
    function dropBridge(b) {
        for (const [, vs] of b.emu) {
            vs.forkTcp?.shutdown();
            if (vs.member) frame(vs, T.LEAVE, Buffer.alloc(0));
        }
        for (const t of [...tcps.values()]) if (t.bridge === b) t.abort();
        bridges.delete(b.code);
    }

    // ---------- Grupos de consolas → emuladores --------------------------------------------------------------
    // Un emulador busca grupo: respondemos con los grupos abiertos de consolas, como si sus anfitriones estuvieran
    // en la LAN.
    function answerScan(client, src, sport) {
        for (const room of rooms.values()) {
            const pub = room.published;
            if (!room.net13 || !isOpen(room)) continue;
            const existing = bridges.get(room.code);
            if (existing && existing.origin === 'emu') continue;  // ese grupo ya lo ve por LAN Play
            if (pub.member.socket && pub.member.socket.virtual) continue;
            bridge(room.code, 'console');
            sendTo(client, P.IPV4, udpPacket(pub.member.ip, LDN_PORT, src, sport, ldnFrame(LT.SCAN_RESP, pub.info)));
        }
    }

    // TCP de un emulador al 11452 de un anfitrión consola: es la unión al grupo.
    function acceptStation(client, ip, b, hostIndex, t) {
        const room = rooms.get(b.code);
        if (!room) return t.abort();
        const vs = virtualMember(client.address, ip, onStationFrame);
        let joined = false, nodeInfo = null;
        const st = {};
        t.bridge = b;
        t.endpoint = client;
        function onStationFrame(_vs, type, body) {
            if (type === T.ROOM) {
                joined = true;
                b.emu.set(ip, vs);
                if (nodeInfo) sendConnect();
            } else if (type === T.ERROR) {
                t.close();
            } else if (type === T.RELAY_IN && body.length >= 2) {
                const from = body[0], msg = body[1], data = body.subarray(2);
                if (from !== hostIndex) return;
                if (msg === LDN.SYNC && data.length === NETWORK_INFO_SIZE) {
                    t.write(ldnFrame(LT.SYNC, data));
                } else if (msg === LDN.DISCONNECT) {
                    t.close();
                }
            } else if (type === T.MEMBER_LEFT && body[0] === hostIndex) {
                t.close();
            }
        }
        function sendConnect() {
            frame(vs, T.RELAY, Buffer.concat([Buffer.from([hostIndex, LDN.CONNECT]), nodeInfo]));
        }
        t.onData = (chunk) => {
            for (const f of ldnRead(st, chunk)) {
                if (f.type !== LT.CONNECT || f.data.length !== NODE_INFO_SIZE || nodeInfo) continue;
                nodeInfo = f.data;
                const name = nodeInfo.subarray(12, 45);
                const end = name.indexOf(0);
                const nick = Buffer.alloc(32);
                name.subarray(0, end < 0 ? 32 : Math.min(end, 32)).copy(nick);
                const gameId = Buffer.alloc(8);
                gameId.writeBigUInt64LE(room.gameId);
                frame(vs, T.JOIN, Buffer.concat([Buffer.from(b.code, 'ascii'), nick, gameId, F_NET13]));
                if (joined) sendConnect();
            }
        };
        t.onClose = () => {
            tcps.delete(t.key());
            if (vs.member) {
                frame(vs, T.RELAY, Buffer.from([hostIndex, LDN.DISCONNECT]));
                frame(vs, T.LEAVE, Buffer.alloc(0));
            }
            b.emu.delete(ip);
            log(`lan play: ${ipStr(ip)} sale del grupo de la sala ${b.code}`);
        };
        log(`lan play: ${ipStr(ip)} se une al grupo de la sala ${b.code}`);
    }

    // ---------- Grupos de emuladores → consolas --------------------------------------------------------------
    // Respuesta a nuestra búsqueda: un emulador tiene grupo. Se publica como grupo abierto de LANywhere.
    function onEmuGroup(client, host13, info, forkControl = false) {
        if (paused() || info.length !== NETWORK_INFO_SIZE ||
            !info[NODES + 11] || info[0x66] < 1 || info[0x66] > 8 || info[0x67] < 1 || info[0x67] > info[0x66]) return;
        const identity = forkControl ? Fork.identity(info) : null;
        if (forkControl ? !identity : info.readUInt32LE(NODES) !== host13) return;
        if (forkControl && identity.real !== host13 && (consoleAt(identity.real) || byIp.has(identity.real))) return;
        if (upstream && !forkControl) for (let i = 1; i < MAX_NODES; i++) {
            const at = NODES + i * NODE_SIZE;
            if (info[at + 11] && !consoleAt(info.readUInt32LE(at))) ownsSource(client, info.readUInt32LE(at), true);
        }
        let b = [...bridges.values()].find((x) => x.origin === 'emu' && x.host13 === host13);
        if (b && (!!b.fork !== !!forkControl || (b.fork && b.fork.key !== identity.key))) return;
        if (!b) {
            const node0 = NODES;
            const name = info.subarray(node0 + 12, node0 + 45);
            const end = name.indexOf(0);
            const nick = Buffer.alloc(32);
            name.subarray(0, end < 0 ? 32 : Math.min(end, 32)).copy(nick);
            const gameId = Buffer.alloc(8);
            gameId.writeBigUInt64LE(info.readBigUInt64LE(0));
            const host = { b: null };
            const vs = virtualMember(client.address, host13, (_vs, type, body) => onHostFrame(host.b, _vs, type, body), !!identity);
            frame(vs, T.CREATE, Buffer.concat([gameId, nick, identity ? F_NET13_FORK_TCP : F_NET13]));
            if (!vs.member) return;
            b = bridge(vs.member.room.code, 'emu');
            host.b = b;
            b.host13 = host13;
            if (identity) b.fork = { key: identity.key, bssid: identity.bssid, raw: null,
                realByVirtual: new Map([[host13, identity.real]]), virtualByReal: new Map([[identity.real, host13]]), peerLast: new Map() };
            b.emu.set(host13, vs);
            if (identity) attachForkTcp(b, vs);
            log(`lan play: grupo de ${ipStr(host13)} publicado en la sala ${b.code}`);
        }
        b.lastSeen = Date.now();
        if (b.fork) {
            b.fork.raw = Buffer.from(info);
            for (const [virt, real] of b.fork.realByVirtual) {
                if (virt === host13 || Fork.hasNode(info, real)) continue;
                const old = b.emu.get(virt); old?.forkTcp?.shutdown(); if (old?.member) frame(old, T.LEAVE, Buffer.alloc(0));
                b.emu.delete(virt); b.fork.realByVirtual.delete(virt); b.fork.virtualByReal.delete(real); b.fork.peerLast.delete(virt);
            }
            const normalized = Fork.normalize(info, real => {
                const mapped = b.fork.virtualByReal.get(real);
                const local = consoleAt(real);
                return mapped || (local && local.room.code === b.code ? real : 0);
            });
            if (!normalized) {
                b.info = null;
                const host = b.emu.get(host13); if (host?.member) frame(host, T.PUBLISH, Buffer.alloc(0));
                return;
            }
            b.info = normalized;
        } else b.info = info;
        publishEmu(b);
    }
    // Lo que publica (y ven las consolas): el NetworkInfo del emulador.
    function publishEmu(b) {
        const vs = b.emu.get(b.host13);
        if (!vs || !vs.member || !b.info) return;
        // Las estaciones del grupo que sean emuladores sin miembro aún (entraron por LAN Play) se añaden a la sala.
        for (let i = 1; i < MAX_NODES; i++) {
            const n = NODES + i * NODE_SIZE;
            if (!b.info[n + 11]) continue;
            const ip13 = b.info.readUInt32LE(n);
            if (b.emu.has(ip13) || consoleAt(ip13) || !byIp.has(ip13)) continue;
            addEmuStation(b, ip13, b.info.subarray(n + 12, n + 45));
        }
        frame(vs, T.PUBLISH, b.info);
    }
    function addEmuStation(b, ip13, rawName) {
        const legacyTcp = !!b.fork?.realByVirtual.has(ip13);
        const vs = virtualMember(byIp.get(ip13).address, ip13, () => {}, legacyTcp);
        if (legacyTcp) attachForkTcp(b, vs);
        const end = rawName.indexOf(0);
        const nick = Buffer.alloc(32);
        rawName.subarray(0, end < 0 ? 32 : Math.min(end, 32)).copy(nick);
        const gameId = Buffer.alloc(8);
        gameId.writeBigUInt64LE(rooms.get(b.code).gameId);
        frame(vs, T.JOIN, Buffer.concat([Buffer.from(b.code, 'ascii'), nick, gameId, legacyTcp ? F_NET13_FORK_TCP : F_NET13]));
        if (vs.member) b.emu.set(ip13, vs);
    }
    // Lo que le llega al miembro virtual anfitrión (el emulador): consolas que se unen a su grupo.
    function onHostFrame(b, vs, type, body) {
        if (!b) return;
        if (type === T.RELAY_IN && body.length >= 2) {
            const from = body[0], msg = body[1], data = body.subarray(2);
            if (msg === LDN.CONNECT && data.length === NODE_INFO_SIZE) connectConsole(b, from, data);
            else if (msg === LDN.DISCONNECT) closeConsole(b, from, true);
            else if (msg === LDN.SCAN && b.info)  // una consola dentro de la sala busca: el grupo es este
                frame(vs, T.RELAY, Buffer.concat([Buffer.from([from, LDN.SCAN_RESP]), b.info]));
        } else if (type === T.MEMBER_LEFT) {
            closeConsole(b, body[0], true);
        }
    }
    let forkFragmentId = 0;
    function sendForkIp(client, packet) {
        if (packet.length <= MAX_WIRE_IPV4) return sendTo(client, P.IPV4, packet);
        const pmtu = 1024, total = Math.ceil(packet.length / pmtu);
        if (total > 8) return false;
        const id = forkFragmentId++ & 0xffff;
        for (let part = 0; part < total; part++) {
            const chunk = packet.subarray(part * pmtu, (part + 1) * pmtu);
            const header = Buffer.alloc(16); packet.copy(header,0,12,20);
            header.writeUInt16BE(id,8); header[10]=part; header[11]=total;
            header.writeUInt16BE(chunk.length,12); header.writeUInt16BE(pmtu,14);
            if (!sendTo(client,P.IPV4_FRAG,Buffer.concat([header,chunk]))) return false;
        }
        return true;
    }
    function attachForkTcp(b, vs) {
        vs.forkTcp = ForkTcp.create({
            room: b.code, ports: forkPorts,
            networkId: () => rooms.get(b.code)?.published?.info.subarray(0,32) || null,
            hasPeer: ip => {
                const member = consoleAt(ip), room = rooms.get(b.code);
                return !!(member && vs.member && room && member.room === room && vs.member.room === room &&
                    room.published?.connected.has(member) && room.published.connected.has(vs.member));
            },
            sendControl: (_peer, body) => frame(vs, StreamWire.COMMAND, body),
            sendLegacy: (peer, data) => {
                const room = rooms.get(b.code), member = consoleAt(peer), real = b.fork?.realByVirtual.get(vs.ip13);
                if (!room || !member || member.room !== room || !real || byIp.get(vs.ip13) !== vs.endpoint) return false;
                const payload = Fork.wrap(peer, real, data); if (!payload) return false;
                return sendForkIp(vs.endpoint, Fork.addIpId(udpPacket(peer,11453,vs.ip13,11453,payload),Fork.GAME_V2));
            },
        });
    }
    // Fork peers identify themselves with a control packet and session BSSID.
    // These maps are confined to one bridge/provider and expire with that room.
    function rememberForkPeer(b, virt, real) {
        if (!b.fork || !virt || !real || b.fork.realByVirtual.size >= MAX_NODES && !b.fork.realByVirtual.has(virt)) return false;
        const oldReal = b.fork.realByVirtual.get(virt), oldVirt = b.fork.virtualByReal.get(real);
        if ((oldReal && oldReal !== real) || (oldVirt && oldVirt !== virt) ||
            (real !== virt && (consoleAt(real) || byIp.has(real)))) return false;
        b.fork.realByVirtual.set(virt, real); b.fork.virtualByReal.set(real, virt); return true;
    }
    function forkPacket(src, dst, type, payload, seq = 0) {
        const data = ldnFrame(type, payload); data.writeUInt16LE(seq, 10);
        return Fork.addIpId(udpPacket(src, LDN_PORT, dst, LDN_PORT, data), Fork.CONTROL);
    }
    function forkSync(b, vs, hostIndex, info) {
        if (!b.fork || !vs.member || info.length !== NETWORK_INFO_SIZE) return;
        const host = vs.member.room.members[hostIndex]; if (!host) return;
        const peerInfo = Fork.forPeer(info, virt => b.fork.realByVirtual.get(virt) || virt);
        b.fork.txSeq = ((b.fork.txSeq || 0) + 1) & 0xffff; if (!b.fork.txSeq) b.fork.txSeq = 1;
        sendTo(vs.endpoint, P.IPV4, forkPacket(host.ip, BCAST, LT.SYNC, peerInfo, b.fork.txSeq));
    }
    function forkConnect(client, src, data) {
        if (data.length !== NODE_INFO_SIZE + 6 || !data[11]) return;
        const target = data.subarray(NODE_INFO_SIZE), matches = [...bridges.values()].filter(x => {
            const r = rooms.get(x.code);
            return x.origin === 'console' && r && isOpen(r) && r.published &&
                r.published.info.subarray(0x20, 0x26).equals(target);
        });
        if (matches.length !== 1) return;
        const b = matches[0], room = rooms.get(b.code), pub = room.published;
        const identity = Fork.identity(pub.info); if (!identity) return;
        if (!b.fork) b.fork = { key: identity.key, bssid: identity.bssid, raw: null, realByVirtual: new Map(), virtualByReal: new Map(), peerLast: new Map() };
        const previous = b.emu.get(src);
        if (previous && (previous.endpoint !== client || !previous.forkControl)) return;
        if (b.fork.key !== identity.key || !rememberForkPeer(b, src, data.readUInt32LE(0))) return;
        b.fork.peerLast.set(src, Date.now());
        if (previous) {
            if (previous.endpoint !== client || !previous.forkControl || !previous.member) return;
            const n = Buffer.from(data.subarray(0, NODE_INFO_SIZE)); n.writeUInt32LE(src,0);
            frame(previous, T.RELAY, Buffer.concat([Buffer.from([pub.member.index, LDN.CONNECT]), n]));
            return;
        }
        const node = Buffer.from(data.subarray(0, NODE_INFO_SIZE)); node.writeUInt32LE(src, 0);
        const vs = virtualMember(client.address, src, (self, type, body) => {
            if (type === T.RELAY_IN && body.length >= 2 && body[0] === pub.member.index) {
                if (body[1] === LDN.SYNC) forkSync(b, self, pub.member.index, body.subarray(2));
                else if (body[1] === LDN.DISCONNECT && self.member) frame(self, T.LEAVE, Buffer.alloc(0));
            } else if (type === T.MEMBER_LEFT && body[0] === pub.member.index && self.member) frame(self,T.LEAVE,Buffer.alloc(0));
        }, true);
        vs.forkControl = true; attachForkTcp(b, vs);
        const nick = Buffer.alloc(32); node.subarray(12,44).copy(nick);
        const game = Buffer.alloc(8); game.writeBigUInt64LE(room.gameId);
        frame(vs, T.JOIN, Buffer.concat([Buffer.from(b.code,'ascii'), nick, game, F_NET13_FORK_TCP]));
        if (!vs.member) { b.fork.realByVirtual.delete(src); b.fork.virtualByReal.delete(data.readUInt32LE(0)); b.fork.peerLast.delete(src); return; }
        b.emu.set(src, vs);
        frame(vs, T.RELAY, Buffer.concat([Buffer.from([pub.member.index, LDN.CONNECT]), node]));
    }
    function forkHeartbeat(src, data) {
        if (data.length !== 12) return;
        const real = data.readUInt32LE(8), bssid = data.subarray(0,6);
        const matches = [...bridges.values()].filter(b => b.fork && b.fork.bssid.equals(bssid) &&
            ((b.origin === 'emu' && b.fork.raw && Fork.hasNode(b.fork.raw, real)) ||
             (b.origin === 'console' && b.fork.realByVirtual.get(src) === real)));
        if (matches.length !== 1) return;
        const b = matches[0];
        if (b.origin === 'emu' && src === b.host13) return;
        if (!rememberForkPeer(b, src, real)) return;
        b.fork.peerLast.set(src, Date.now());
        if (b.origin === 'console') return;
        if (!b.emu.has(src)) {
            const n = Fork.nodeInfo(b.fork.raw, real);
            if (n && byIp.has(src)) addEmuStation(b, src, n.subarray(12,45));
        }
        const normalized = Fork.normalize(b.fork.raw, r => b.fork.virtualByReal.get(r) ||
            ((consoleAt(r) && consoleAt(r).room.code === b.code) ? r : 0));
        if (normalized) { b.info = normalized; publishEmu(b); }
    }
    function forkBye(src, data) {
        if (data.length !== 12) return;
        const real = data.readUInt32LE(8), bssid = data.subarray(0,6);
        const matches = [...bridges.values()].filter(b => b.fork?.bssid.equals(bssid) && b.fork.realByVirtual.get(src) === real);
        if (matches.length !== 1) return;
        const b = matches[0];
        if (b.origin === 'emu' && b.host13 === src) { dropBridge(b); return; }
        const vs = b.emu.get(src);
        vs?.forkTcp?.shutdown();
        if (vs?.member) {
            if (b.origin === 'console') {
                const pub = rooms.get(b.code)?.published;
                if (pub) frame(vs,T.RELAY,Buffer.from([pub.member.index,LDN.DISCONNECT]));
            }
            frame(vs,T.LEAVE,Buffer.alloc(0));
        }
        b.emu.delete(src); b.fork.realByVirtual.delete(src); b.fork.virtualByReal.delete(real); b.fork.peerLast.delete(src);
        if (b.origin === 'emu') {
            const host = b.emu.get(b.host13);
            if (host?.member) frame(host,T.PUBLISH,Buffer.alloc(0)); // await the host's updated beacon
        }
    }
    function forkHostSync(src, info, seq) {
        const identity = Fork.identity(info); if (!identity) return;
        const b = [...bridges.values()].find(x => x.origin === 'emu' && x.host13 === src && x.fork?.key === identity.key);
        if (!b || b.fork.realByVirtual.get(src) !== identity.real) return;
        if (seq && b.fork.rxSeq !== undefined && ((b.fork.rxSeq - seq) & 0xffff) < 256) return;
        if (seq) b.fork.rxSeq = seq;
        b.fork.raw = Buffer.from(info); b.lastSeen = Date.now();
        const normalized = Fork.normalize(info, r => b.fork.virtualByReal.get(r) ||
            ((consoleAt(r) && consoleAt(r).room.code === b.code) ? r : 0));
        if (!normalized) {
            b.info = null;
            const host = b.emu.get(src); if (host?.member) frame(host,T.PUBLISH,Buffer.alloc(0));
            return;
        }
        b.info = normalized; publishEmu(b);
        const host = b.emu.get(src);
        if (host?.member) for (const [index, pending] of b.fork.pending || []) {
            const member = host.member.room.members[index];
            if (member !== pending.member || Date.now() - pending.started > 3000 || pending.epoch !== b.fork.key) { b.fork.pending.delete(index); continue; }
            if (Fork.hasNode(info, member.ip)) {
                frame(host, T.RELAY, Buffer.concat([Buffer.from([index, LDN.SYNC]), normalized]));
                b.fork.pending.delete(index);
            }
        }
    }

    // Una consola se une al grupo de un emulador: la pasarela abre el TCP al anfitrión en su nombre.
    function connectConsole(b, index, nodeInfo) {
        const room = rooms.get(b.code);
        const m = room && room.members[index];
        if (!m || (m.socket && m.socket.virtual)) return;
        const prior = b.fork?.pending?.get(index);
        if (prior && prior.member === m && prior.epoch === b.fork.key && prior.node.equals(nodeInfo)) return;
        closeConsole(b, index);
        if (b.fork) {
            const endpoint = byIp.get(b.host13); if (!endpoint) return;
            const now = Date.now();
            (b.fork.pending ||= new Map()).set(index, { member:m, epoch:b.fork.key, node:Buffer.from(nodeInfo),
                started:now, next:now+500, attempts:1 });
            sendTo(endpoint, P.IPV4, forkPacket(m.ip, BCAST, LT.CONNECT, Buffer.concat([nodeInfo,b.fork.bssid])));
            return;
        }
        const endpoint = byIp.get(b.host13);
        if (!canOpenTcp(endpoint)) return;
        const ip13 = m.ip;
        const sport = 40000 + (crypto.randomBytes(2).readUInt16BE(0) % 20000);
        const t = new Tcp(ip13, sport, b.host13, LDN_PORT, (pkt) => deliverIpv4(b.host13, pkt));
        t.bridge = b;
        t.consoleIndex = index;
        t.endpoint = endpoint;
        tcps.set(t.key(), t);
        const st = {};
        t.onOpen = () => t.write(ldnFrame(LT.CONNECT, nodeInfo));
        t.onData = (chunk) => {
            for (const f of ldnRead(st, chunk)) {
                if (f.type !== LT.SYNC || f.data.length !== NETWORK_INFO_SIZE) continue;
                b.info = f.data;
                b.lastSeen = Date.now();
                publishEmu(b);
                const vsHost = b.emu.get(b.host13);
                if (vsHost && vsHost.member)
                    frame(vsHost, T.RELAY, Buffer.concat([Buffer.from([index, LDN.SYNC]), f.data]));
            }
        };
        t.onClose = () => {
            tcps.delete(t.key());
            const vsHost = b.emu.get(b.host13);
            const still = rooms.get(b.code) && rooms.get(b.code).members[index];
            if (vsHost && vsHost.member && still && !t.quiet) frame(vsHost, T.RELAY, Buffer.from([index, LDN.DISCONNECT]));
        };
        t.connect();
        log(`lan play: consola ${index} de la sala ${b.code} entra en el grupo de ${ipStr(b.host13)}`);
    }
    function closeConsole(b, index, dropStreams = false) {
        b.fork?.pending?.delete(index);
        const ip = rooms.get(b.code)?.members[index]?.ip;
        if (dropStreams && ip) for (const vs of b.emu.values()) vs.forkTcp?.dropPeer(ip);
        for (const t of [...tcps.values()]) {
            if (t.bridge === b && t.consoleIndex === index) { t.quiet = true; t.close(); }
        }
    }

    // ---------- Paquetes de los emuladores ---------------------------------------------------------------------
    function onIpv4(client, pkt) {
        const p = parseIpv4(pkt);
        if (!p || !ownsSource(client, p.src, true)) return;
        const toGateway = p.dst === gatewayIp || !!consoleAt(p.dst);
        if (p.mf || p.off) {
            // Fragmento IP (Ryujinx parte los datagramas de más de 1480 bytes): los emuladores lo reciben tal cual;
            // para las consolas se reensambla.
            if (!toGateway) deliverIpv4(p.dst, pkt, client);
            traffic.frags++;
            const whole = reassemble(client, p);
            if (whole && whole.proto === 17 && whole.body.length >= 8) {
                const sport = whole.body.readUInt16BE(0), dport = whole.body.readUInt16BE(2);
                if (dport !== LDN_PORT) gameData(p.src, p.dst, sport, dport, whole.body.subarray(8, whole.body.readUInt16BE(4)), p.id);
            }
            return;
        }
        // ICMP eco a una IP de la pasarela (Ryujinx comprueba así que su IP no esté ocupada).
        if (p.proto === 1 && toGateway && p.body.length >= 8 && p.body[0] === 8) {
            const reply = Buffer.from(p.body);
            reply[0] = 0; reply.writeUInt16BE(0, 2);
            reply.writeUInt16BE(fold(sum16(reply)), 2);
            return sendTo(client, P.IPV4, ipv4(p.dst, p.src, 1, reply));
        }
        if (p.proto === 17 && p.body.length >= 8) {
            const udpLen = p.body.readUInt16BE(4); if (udpLen < 8 || udpLen > p.body.length) return;
            const sport = p.body.readUInt16BE(0), dport = p.body.readUInt16BE(2);
            const data = p.body.subarray(8, udpLen);
            if (dport === LDN_PORT) {
                for (const f of ldnRead({}, data)) {
                    if (p.id === Fork.CONTROL && (p.dst === BCAST || p.dst === 0xffffffff)) {
                        if (f.type === LT.CONNECT) forkConnect(client, p.src, f.data);
                        else if (f.type === LT.SYNC) forkHostSync(p.src, f.data, f.seq);
                        else if (f.type === 4) forkHeartbeat(p.src, f.data);
                        else if (f.type === 5) forkBye(p.src, f.data);
                    }
                    if (f.type === LT.SCAN && (p.dst === BCAST || p.dst === 0xffffffff)) answerScan(client, p.src, sport);
                    else if (f.type === LT.SCAN_RESP && f.data.length === NETWORK_INFO_SIZE) {
                        const forkControl = p.id === Fork.CONTROL && (p.dst === BCAST || p.dst === 0xffffffff);
                        if (p.dst === gatewayIp || forkControl) onEmuGroup(client, p.src, f.data, forkControl);
                    }
                }
                if (toGateway) return;
            } else {
                traffic.udp++;
                gameData(p.src, p.dst, sport, dport, data, p.id);
                if (toGateway) return;
            }
        }
        if (p.proto === 6 && toGateway) return onTcp(client, p);
        deliverIpv4(p.dst, pkt, client);  // reenvío normal entre emuladores
    }
    function reassemble(client, p) {
        const key = `${client.id}-${p.src}-${p.dst}-${p.id}-${p.proto}`;
        const end = p.off + p.body.length;
        if (!p.body.length || end > MAX_IP_BODY || (p.mf && p.body.length % 8)) { dropAssembly(key); return null; }
        let r = reassembly.get(key);
        if (!r) {
            if (reassembly.size >= MAX_REASSEMBLY) return null;
            r = { at: Date.now(), client, parts: [], have: 0, total: -1, bytes: 0 };
            reassembly.set(key, r);
        }
        const same = r.parts.find((x) => x.off === p.off);
        if (same && same.mf === p.mf && same.body.equals(p.body)) return null;
        if (r.parts.length >= MAX_FRAGMENT_PARTS || reassemblyBytes + p.body.length > MAX_REASSEMBLY_BYTES ||
            r.parts.some((x) => p.off < x.off + x.body.length && end > x.off) ||
            (r.total >= 0 && (end > r.total || (!p.mf && end !== r.total))) ||
            (!p.mf && r.parts.some((x) => x.off + x.body.length > end))) { dropAssembly(key); return null; }
        r.parts.push({ off: p.off, mf: p.mf, body: Buffer.from(p.body) });
        r.bytes += p.body.length;
        reassemblyBytes += p.body.length;
        r.have += p.body.length;
        if (!p.mf) r.total = end;
        if (r.total < 0 || r.have !== r.total) return null;
        dropAssembly(key);
        const body = Buffer.alloc(r.total);
        for (const x of r.parts) x.body.copy(body, x.off);
        return { proto: p.proto, src: p.src, dst: p.dst, body };
    }

    // Cabecera de 16 bytes de un fragmento de LAN Play: origen, destino, id (u16), parte, total de partes, longitud
    // (u16) y MTU del camino (u16). El orden de bytes de los u16 se deduce de la longitud, que debe cuadrar.
    function relayFragment(payload) {
        if (payload.length < 16) return null;
        const le = payload.readUInt16LE(12) === payload.length - 16;
        if (!le && payload.readUInt16BE(12) !== payload.length - 16) return null;
        const u16 = (o) => (le ? payload.readUInt16LE(o) : payload.readUInt16BE(o));
        const id = u16(8), part = payload[10], total = payload[11], len = u16(12), pmtu = u16(14);
        if (!total || total > 30 || part >= total || !pmtu || pmtu * total > 65535 ||
            !len || len > pmtu || (part < total - 1 && len !== pmtu)) return null;
        return { id, part, total, len, pmtu };
    }
    function relayReassemble(client, payload, fragment) {
        const { id, part, total, len, pmtu } = fragment;
        const key = `f-${client.id}-${payload.readUInt32BE(0)}-${payload.readUInt32BE(4)}-${id}`;
        let r = reassembly.get(key);
        if (!r) {
            if (reassembly.size >= MAX_REASSEMBLY || reassemblyBytes + pmtu * total > MAX_REASSEMBLY_BYTES) return null;
            r = { at: Date.now(), client, buf: Buffer.alloc(pmtu * total), mask: 0, total, pmtu, size: 0, bytes: pmtu * total };
            reassembly.set(key, r);
            reassemblyBytes += r.bytes;
        }
        if (r.total !== total || r.pmtu !== pmtu) { dropAssembly(key); return null; }
        if (r.mask & (1 << part)) return null;
        payload.copy(r.buf, pmtu * part, 16, 16 + len);
        r.mask |= 1 << part;
        r.size = Math.max(r.size, pmtu * part + len);
        if (r.mask !== (1 << total) - 1) return null;
        dropAssembly(key);
        return r.buf.subarray(0, r.size);
    }

    // Un emulador envía un paquete del juego: si va a una consola de su sala (o a todos), sale por la sala.
    function gameData(src13, dst13, sport, dport, data, ipId) {
        for (const b of bridges.values()) {
            const vs = b.emu.get(src13);
            if (!vs || !vs.member) continue;
            let body = data;
            const real = b.fork?.realByVirtual.get(src13);
            if (real) {
                const wrapped = Fork.unwrap(ipId, data);
                if (!wrapped || wrapped.data.length > Fork.MAX_PAYLOAD ||
                    (ipId === Fork.GAME_V2 && (wrapped.realSrc !== real ||
                        (dst13 !== BCAST && dst13 !== 0xffffffff && wrapped.realDst !== dst13) ||
                        ((dst13 === BCAST || dst13 === 0xffffffff) && wrapped.realDst !== 0xffffffff)))) continue;
                body = wrapped.data;
            }
            const broadcast = dst13 === BCAST || dst13 === 0xffffffff;
            const m = broadcast ? null : consoleAt(dst13);
            if (!broadcast && !(m && m.room === vs.member.room)) {
                if (!byIp.has(dst13)) { traffic.miss++; traffic.missDst = dst13; }
                continue;
            }
            if (real && dport === 11453) {
                if (!broadcast && m && vs.forkTcp) vs.forkTcp.receiveLegacy(dst13, body);
                continue;
            }
            traffic.up++; traffic.upBytes += data.length; traffic.upMax = Math.max(traffic.upMax, data.length);
            const ports = Buffer.alloc(4);
            ports.writeUInt16LE(sport, 0); ports.writeUInt16LE(dport, 2);
            forwardData(vs.member, broadcast ? BCAST : dst13, Buffer.concat([ports, body]));
        }
    }
    function onTcp(client, p) {
        const t = p.body;
        if (t.length < 20) return;
        const sport = t.readUInt16BE(0), dport = t.readUInt16BE(2), flags = t[13];
        const key = Tcp.key(p.dst, dport, p.src, sport);
        let conn = tcps.get(key);
        if (!conn) {
            const m = consoleAt(p.dst);
            const room = m && m.room;
            const b = room && isOpen(room) && room.published.member === m && bridges.get(room.code);
            if (!(flags & TF.SYN) || (flags & TF.ACK) || dport !== LDN_PORT || !b || b.origin !== 'console') {
                if (!(flags & TF.RST)) {  // nadie escucha: RST
                    const r = new Tcp(p.dst, dport, p.src, sport, (pkt) => sendTo(client, P.IPV4, pkt));
                    r.rcv = (t.readUInt32BE(4) + Math.max(1, t.length - (t[12] >> 4) * 4)) >>> 0;
                    r.state = 'x';
                    r.segment(TF.RST | TF.ACK, Buffer.alloc(0), (flags & TF.ACK) ? t.readUInt32BE(8) : 0);
                }
                return;
            }
            if (!canOpenTcp(client)) return;
            conn = new Tcp(p.dst, dport, p.src, sport, (pkt) => sendTo(byIp.get(p.src) || client, P.IPV4, pkt));
            tcps.set(key, conn);
            acceptStation(client, p.src, b, m.index, conn);
            conn.accept(t.readUInt32BE(4));
            return;
        }
        conn.input(t);
    }

    // ---------- Socket LAN Play --------------------------------------------------------------------------------
    sock.on('message', (msg, rinfo) => {
        if (upstream && (!upstreamClient || rinfo.address !== upstreamClient.address || rinfo.port !== upstreamClient.port)) return;
        if (!msg.length || paused() || !allowTraffic(rinfo.address, 'in', msg.length + 28)) return;
        const key = `${rinfo.address}:${rinfo.port}`;
        let client = clients.get(key);
        if (!client) {
            const n = perIp.get(rinfo.address) || 0;
            if (n >= MAX_CLIENTS_PER_IP || clients.size >= MAX_CLIENTS) return;
            perIp.set(rinfo.address, n + 1);
            client = { id: nextClientId++, address: rinfo.address, port: rinfo.port, seen: 0, ips: new Set() };
            clients.set(key, client);
            log(`lan play: entra un emulador (${clients.size} conectados)`);
        }
        client.seen = Date.now();
        count(msg.length + 28);
        if (paused()) return;
        const type = msg[0] & 0x7f, payload = msg.subarray(1);
        if (upstream && (type === P.AUTH_ME || (msg[0] & 0x80))) { onFailure(new Error('LAN Play upstream requires unsupported authentication')); return; }
        if (type === P.IPV4) onIpv4(client, payload);
        else if (type === P.PING) {
            if (!upstream) sendTo(client, P.PING, payload);
            else if (pingNonce && ((payload.length === 4 && payload.equals(pingNonce)) ||
                (payload.length === 3 && payload.equals(pingNonce.subarray(0, 3))))) {
                if (!confirmed) {
                    confirmed = true;
                    const firstScan = udpPacket(gatewayIp, LDN_PORT, BCAST, LDN_PORT, ldnFrame(LT.SCAN));
                    if (!sendTo(upstreamClient, P.IPV4, firstScan, false, () => { onReady(); onFirstScanSent(); }))
                        onFailure(new Error('LAN Play initial scan could not be queued'));
                }
                pingNonce = null;
            }
        }
        else if (type === P.IPV4_FRAG && payload.length >= 16) {
            const fragment = relayFragment(payload);
            const src = payload.readUInt32BE(0);
            if (!fragment || !ownsSource(client, src)) return;
            traffic.relayFrags++;
            // Fragmentos de LAN Play (un paquete IPv4 partido por el cliente): a los emuladores se reenvían tal cual
            // por su destino; si van a una consola (o a todos), se reensamblan para sacarlos por la sala.
            const dst = payload.readUInt32BE(4);
            const toConsole = !!consoleAt(dst);
            if (!upstream && !toConsole && dst !== gatewayIp) {
                if (dst === BCAST) for (const c of clients.values()) { if (c !== client) sendTo(c, P.IPV4_FRAG, payload); }
                else sendTo(byIp.get(dst), P.IPV4_FRAG, payload);
            }
            if (toConsole || dst === BCAST) {
                const whole = relayReassemble(client, payload, fragment);
                const p = whole && parseIpv4(whole);
                if (p && p.src === src && p.dst === dst && p.proto === 17 && !p.mf && !p.off &&
                    p.body.length >= 8 && p.body.readUInt16BE(2) !== LDN_PORT)
                    gameData(p.src, p.dst, p.body.readUInt16BE(0), p.body.readUInt16BE(2), p.body.subarray(8, p.body.readUInt16BE(4)), p.id);
            }
        }
    });
    sock.on('error', (e) => { log(`lan play: ${e.message}`); if (upstream) onFailure(e); });
    function keepalive() {
        if (!upstreamClient || closed || paused()) return;
        sendTo(upstreamClient, P.KEEPALIVE, Buffer.alloc(0));
        pingNonce = crypto.randomBytes(4); // Rust echoes all 5 wire bytes; Node echoes their first 4.
        sendTo(upstreamClient, P.PING, pingNonce);
    }
    if (upstream) {
        resolve(upstream.host, { family: 4 }).then(({ address }) => {
            if (closed) return;
            const octets = address.split('.').map(Number);
            const privateAddress = octets[0] === 0 || octets[0] === 10 || octets[0] === 127 || octets[0] >= 224 ||
                (octets[0] === 169 && octets[1] === 254) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
                (octets[0] === 192 && octets[1] === 168) || (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
            if (privateAddress && !upstream.allowPrivate) throw new Error('LAN Play upstream resolved to a non-public address');
            upstreamClient = { id: nextClientId++, address, port: upstream.port, seen: Date.now(), ips: new Set() };
            clients.set(`${address}:${upstream.port}`, upstreamClient);
            perIp.set(address, 1);
            sock.bind(0, '0.0.0.0', () => { if (!closed) { try { sock.setRecvBufferSize(1024 * 1024); } catch {} keepalive(); log(`lan play upstream ${upstream.id} ready for probe`); } });
        }).catch(onFailure);
    } else sock.bind(port, () => log(`lan play en UDP ${port}`));

    // Reference fork retries CONNECT every 500 ms for ~3 s. Keep retries
    // bounded and tied to the same room epoch and member object.
    const forkPendingTimer = setInterval(() => {
        if (closed || paused()) return;
        const now = Date.now();
        for (const b of bridges.values()) {
            if (!b.fork) continue;
            for (const vs of b.emu.values()) vs.forkTcp?.sweep();
            if (!b.fork.pending) continue;
            const room = rooms.get(b.code), host = b.emu.get(b.host13);
            for (const [index, pending] of b.fork.pending) {
                if (!room || room.members[index] !== pending.member || pending.epoch !== b.fork.key || !host?.member) {
                    b.fork.pending.delete(index); continue;
                }
                if (now - pending.started >= 3000) {
                    b.fork.pending.delete(index);
                    frame(host, T.RELAY, Buffer.from([index, LDN.DISCONNECT]));
                    continue;
                }
                if (now < pending.next || pending.attempts >= 6) continue;
                const endpoint = byIp.get(b.host13);
                if (!endpoint) { b.fork.pending.delete(index); continue; }
                pending.attempts++; pending.next = now + 500;
                sendTo(endpoint, P.IPV4, forkPacket(pending.member.ip, BCAST, LT.CONNECT,
                    Buffer.concat([pending.node, b.fork.bssid])));
            }
        }
    }, 250).unref();

    // Mantenimiento: buscar grupos de emuladores, retirar los que ya no responden, olvidar clientes inactivos.
    const scan = ldnFrame(LT.SCAN);
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [key, c] of clients) {
            if (now - c.seen > CLIENT_IDLE_MS) {
                if (upstream && c === upstreamClient) { onFailure(new Error('LAN Play upstream stopped responding')); continue; }
                clients.delete(key);
                const remaining = (perIp.get(c.address) || 1) - 1;
                if (remaining > 0) perIp.set(c.address, remaining); else perIp.delete(c.address);
                for (const ip of c.ips) if (byIp.get(ip) === c) byIp.delete(ip);
                for (const t of [...tcps.values()]) if (t.endpoint === c) t.abort();
                for (const b of [...bridges.values()]) for (const [ip, vs] of [...b.emu]) {
                    if (vs.endpoint === c) {
                        if (vs.member) frame(vs, T.LEAVE, Buffer.alloc(0));
                        b.emu.delete(ip);
                    }
                }
                for (const [key, r] of reassembly) if (r.client === c) dropAssembly(key);
                log(`lan play: sale un emulador (${clients.size} conectados)`);
            }
        }
        for (const b of [...bridges.values()]) {
            if (b.fork) for (const [virt, seen] of b.fork.peerLast) {
                if (now - seen <= 20000) continue;
                const bye = Buffer.alloc(12); b.fork.bssid.copy(bye); bye.writeUInt32LE(b.fork.realByVirtual.get(virt),8);
                forkBye(virt, bye);
            }
            const room = rooms.get(b.code);
            if (!room) { dropBridge(b); continue; }
            if (b.origin === 'emu' && now - b.lastSeen > HOST_GONE_MS) {
                log(`lan play: el grupo de ${ipStr(b.host13)} ya no responde; se retira la sala ${b.code}`);
                dropBridge(b);
            } else if (b.origin === 'console' && !b.emu.size && !room.published) {
                dropBridge(b);
            }
        }
        for (const [key, r] of reassembly) if (now - r.at > FRAG_MS) dropAssembly(key);
        const second = Math.floor(now / 1000);
        for (const [address, rate] of rates) if (rate.second < second) rates.delete(address);
        if (upstream) keepalive();
        if (!clients.size || paused()) return;
        for (const c of clients.values()) sendTo(c, P.IPV4, udpPacket(gatewayIp, LDN_PORT, BCAST, LDN_PORT, scan));
    }, SCAN_EVERY_MS);
    timer.unref();
    const statsTimer = setInterval(() => {
        const t = traffic;
        const line = `lan play: juego emulador→consola ${t.up} paquetes (${t.upBytes} B, máx ${t.upMax}), ` +
                     `consola→emulador ${t.down} (${t.downBytes} B, máx ${t.downMax}), fragmentos ${t.frags}, fragmentos LAN Play ${t.relayFrags}, ` +
                     `UDP de emuladores ${t.udp}, sin destino en la sala ${t.miss}${t.miss ? ` (p. ej. a ${ipStr(t.missDst)})` : ''}`;
        if (t.up + t.down + t.frags + t.relayFrags + t.miss && line !== trafficLogged) log(line);
        trafficLogged = line;
        Object.keys(t).forEach((k) => { t[k] = 0; });
    }, STATS_EVERY_MS);
    statsTimer.unref();

    return {
        stats: () => ({ clients: clients.size, bridges: bridges.size }),
        // La IP la usa un emulador (o la pasarela): server.js no se la da a una consola.
        taken: (ip) => ip === gatewayIp || byIp.has(ip),
        close: () => {
            closed = true; clearTimeout(sendTimer); sendQueue.length = 0; queuedBytes = 0;
            clearInterval(timer); clearInterval(statsTimer); clearInterval(forkPendingTimer);
            for (const t of tcps.values()) t.finish();
            try { sock.close(); } catch {}
        },
    };
}

module.exports = { create, Tcp, ldnFrame, ldnRead, udpPacket, parseIpv4, ipv4, fragmentIpv4, P, LT, NET, BCAST, GATEWAY_IP };
