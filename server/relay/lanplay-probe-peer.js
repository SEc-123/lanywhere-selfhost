'use strict';
// Independent standard LAN Play protocol peer for bounded integration probes.
const dgram = require('node:dgram');
const L = require('./lanplay');
const NI = 0x480, NODES = 0x68, NS = 0x40;
let GAME = 0x0100000000abc000n;
function networkInfo(hostIp, name, players = 1) {
    const b = Buffer.alloc(NI);
    b.writeBigUInt64LE(GAME, 0);
    b[0x20] = 2; b.writeUInt32LE(hostIp, 0x22);
    b[0x66] = 8; b[0x67] = players;
    b.writeUInt32LE(hostIp, NODES); b[NODES + 11] = 1; b.write(name, NODES + 12);
    return b;
}
function nodeInfo(ip, name) {
    const n = Buffer.alloc(NS);
    n.writeUInt32LE(ip, 0); n[11] = 1; n.write(name, 12);
    return n;
}

class Emu {
    constructor(ip, name, endpoint, game = GAME) { this.endpoint = endpoint; this.game = game; this.ip = ip; this.name = name; this.udpIn = []; this.tcps = new Map(); this.scanResults = []; this.hosting = null; this.sendQueue=[]; this.sendTimer=null; }
    async start() {
        this.sock = dgram.createSocket('udp4');
        this.sock.on('message', (m, r) => { if (r.address === this.endpoint.host && r.port === this.endpoint.port) { this.received = (this.received || 0) + 1; this.onMsg(m); } });
        await new Promise((ok) => this.sock.bind(0, ok)); try { this.sock.setRecvBufferSize(1024*1024); } catch {}
        this.raw(L.P.KEEPALIVE, Buffer.alloc(0));
    }
    raw(type, payload) { this.sock.send(Buffer.concat([Buffer.from([type]), payload]), this.endpoint.port, this.endpoint.host); }
    sendIp(pkt) {
        this.sendQueue.push(...L.fragmentIpv4(pkt).reverse());
        const flush=()=>{this.sendTimer=null;const part=this.sendQueue.shift();if(part)this.raw(L.P.IPV4,part);
            if(this.sendQueue.length)this.sendTimer=setTimeout(flush,15);};
        if(!this.sendTimer)this.sendTimer=setTimeout(flush,15);
    }
    udp(dst, sport, dport, data) { this.sendIp(L.udpPacket(this.ip, sport, dst, dport, data)); }
    onMsg(m) {
        if (m[0] !== L.P.IPV4) return;
        this.maxMsg = Math.max(this.maxMsg || 0, m.length);
        let p = L.parseIpv4(m.subarray(1));
        if (!p) return;
        if (p.mf || p.off) {  // fragmento IP: como Ryujinx, se reensambla
            const key = `${p.src}-${p.id}`;
            for (const [old, entry] of (this.frags ||= new Map())) if (Date.now()-entry.at>5000) this.frags.delete(old);
            if (!this.frags.has(key) && this.frags.size >= 8) return;
            const r = this.frags.get(key) || { parts: [], total: -1, at:Date.now() };
            const duplicate = r.parts.find(part => part.off === p.off);
            if (duplicate) { if (!duplicate.body.equals(p.body) || duplicate.mf !== p.mf) this.frags.delete(key); return; }
            if (r.parts.some(part => p.off < part.off+part.body.length && p.off+p.body.length > part.off)) {this.frags.delete(key);return;}
            this.frags.set(key, r);
            r.parts.push(p);
            if (!p.mf) r.total = p.off + p.body.length;
            if (r.total < 0 || r.parts.reduce((n, x) => n + x.body.length, 0) < r.total) return;
            this.frags.delete(key);
            const body = Buffer.alloc(r.total);
            for (const x of r.parts) x.body.copy(body, x.off);
            p = { ...p, body, mf: false, off: 0 };
        }
        if (p.proto === 17) {
            const sport = p.body.readUInt16BE(0), dport = p.body.readUInt16BE(2), data = p.body.subarray(8);
            if (dport === 11452) {
                for (const f of L.ldnRead({}, data)) {
                    if (f.type === L.LT.SCAN_RESP) this.scanResults.push({ from: p.src, info: f.data });
                    if (f.type === L.LT.SCAN && this.hosting) this.udp(p.src, 11452, sport, L.ldnFrame(L.LT.SCAN_RESP, this.hosting));
                }
            } else {
                this.udpIn.push({ src: p.src, dst: p.dst, sport, dport, data: Buffer.from(data), text: data.toString() });
            }
        } else if (p.proto === 6) {
            const t = p.body, sport = t.readUInt16BE(0), dport = t.readUInt16BE(2);
            const key = L.Tcp.key(this.ip, dport, p.src, sport);
            let c = this.tcps.get(key);
            if (!c && this.hosting && dport === 11452 && (t[13] & 2)) {
                c = new L.Tcp(this.ip, 11452, p.src, sport, (pkt) => this.sendIp(pkt));
                this.tcps.set(key, c);
                this.onStation(c);
                c.accept(t.readUInt32BE(4));
                return;
            }
            if (c) c.input(t);
        }
    }
    // Estación: unirse al grupo de host por TCP.
    join(hostIp, sport = 50001) {
        const c = new L.Tcp(this.ip, sport, hostIp, 11452, (pkt) => this.sendIp(pkt));
        this.tcps.set(c.key(), c);
        const st = {};
        this.syncs = [];
        c.onOpen = () => c.write(L.ldnFrame(L.LT.CONNECT, nodeInfo(this.ip, this.name)));
        c.onData = (d) => { for (const f of L.ldnRead(st, d)) if (f.type === L.LT.SYNC) this.syncs.push(f.data); };
        c.onClose = () => { this.closed = true; };
        c.connect();
        return c;
    }
    // Anfitrión: grupo con este emulador como nodo 0.
    host() {
        this.hosting = networkInfo(this.ip, this.name); this.hosting.writeBigUInt64LE(this.game);
        this.stations = [];
    }
    onStation(c) {
        const st = {};
        c.onData = (d) => {
            for (const f of L.ldnRead(st, d)) {
                if (f.type !== L.LT.CONNECT) continue;
                const n = f.data;
                if (this.allowStationName && n.subarray(12,45).toString().replace(/\0.*$/, '') !== this.allowStationName) return;
                this.stations.push(n.readUInt32LE(0));
                this.hosting[0x67]++;
                const slot = NODES + this.hosting[0x67 - 0] * 0;
                n.copy(this.hosting, NODES + (this.hosting[0x67] - 1) * NS);
                this.hosting[NODES + (this.hosting[0x67] - 1) * NS + 10] = this.hosting[0x67] - 1;
                c.write(L.ldnFrame(L.LT.SYNC, this.hosting));
                void slot;
            }
        };
    }
    close() { clearTimeout(this.sendTimer); this.sendQueue.length=0; for (const t of this.tcps.values()) t.finish(); this.sock.close(); }
}

module.exports = { Emu, networkInfo, nodeInfo };
