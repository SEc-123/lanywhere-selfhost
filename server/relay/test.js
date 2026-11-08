'use strict';
// Pruebas del servidor de salas: node test.js [host] [puerto]
// Sin host, arranca un servidor local en un puerto libre y lo prueba.

const net = require('net');
const dgram = require('dgram');
const { spawn } = require('child_process');
const { once } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const UDP_MAGIC = 0x594e414c;
const GAME = 0x0100000000ABC000n;
let HOST = process.argv[2] || '127.0.0.1';
let PORT = Number(process.argv[3]) || 21460;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ip = (s) => s.split('.').reduce((a, b) => ((a << 8) | Number(b)) >>> 0, 0);

async function stop(child) {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill();
    await exited;
}

class Client {
    constructor(name) {
        this.name = name;
        this.frames = [];
        this.datagrams = [];
    }
    async connect() {
        this.tcp = net.connect(PORT, HOST);
        await new Promise((ok, fail) => { this.tcp.once('connect', ok); this.tcp.once('error', fail); });
        let pending = Buffer.alloc(0);
        this.tcp.on('data', (c) => {
            pending = Buffer.concat([pending, c]);
            while (pending.length >= 3 && pending.length >= 2 + pending.readUInt16LE(0)) {
                const len = pending.readUInt16LE(0);
                this.frames.push({ type: pending[2], body: pending.subarray(3, 2 + len) });
                pending = pending.subarray(2 + len);
            }
        });
        this.udp = dgram.createSocket('udp4');
        this.udp.on('message', (m) => this.datagrams.push(m));
        await new Promise((ok) => this.udp.bind(0, ok));
    }
    sendFrame(type, body = Buffer.alloc(0)) {
        const h = Buffer.alloc(3);
        h.writeUInt16LE(body.length + 1, 0);
        h[2] = type;
        this.tcp.write(Buffer.concat([h, body]));
    }
    async frame(type, ms = 2000) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            const i = this.frames.findIndex((f) => f.type === type);
            if (i >= 0) return this.frames.splice(i, 1)[0].body;
            await sleep(10);
        }
        throw new Error(`${this.name}: no llegó la trama 0x${type.toString(16)}`);
    }
    nick() { const b = Buffer.alloc(32); b.write(this.name); return b; }
    onRoom(body) {
        this.code = body.subarray(0, 6).toString('ascii');
        this.index = body[6];
        this.ip = body.readUInt32LE(7);
        this.token = body.readUInt32LE(11);
        this.members = body[23];
    }
    async create() {
        const g = Buffer.alloc(8);
        g.writeBigUInt64LE(GAME);
        this.sendFrame(0x01, Buffer.concat([g, this.nick()]));
        this.onRoom(await this.frame(0x81));
    }
    async join(code, game = GAME) {
        const g = Buffer.alloc(8);
        g.writeBigUInt64LE(game);
        this.sendFrame(0x02, Buffer.concat([Buffer.from(code, 'ascii'), this.nick(), g]));
    }
    async publish(players, max = 8) {
        const info = Buffer.alloc(0x480);
        info.writeBigUInt64LE(GAME, 0);
        info[0x66] = max;
        info[0x67] = players.length;
        for (const [i, player] of players.entries()) {
            const node = 0x68 + i * 0x40;
            info.writeUInt32LE(player.ip, node);
            info[node + 10] = i;
            info[node + 11] = 1;
        }
        this.sendFrame(0x07, info);
        this.sendFrame(0x05);
        await this.frame(0x86);
    }
    udpSend(type, body) {
        const h = Buffer.alloc(9);
        h.writeUInt32LE(UDP_MAGIC, 0);
        h[4] = type;
        h.writeUInt32LE(this.token, 5);
        this.udp.send(Buffer.concat([h, body]), PORT, HOST);
    }
    async register() {
        for (let i = 0; i < 20; i++) {
            this.udpSend(0x01, Buffer.alloc(0));
            await sleep(50);
            if (this.datagrams.some((d) => d[4] === 0x81)) {
                this.datagrams = this.datagrams.filter((d) => d[4] !== 0x81);
                return;
            }
        }
        throw new Error(`${this.name}: sin REGISTERED`);
    }
    sendData(dst, srcPort, dstPort, payload) {
        const b = Buffer.alloc(8);
        b.writeUInt32LE(dst, 0);
        b.writeUInt16LE(srcPort, 4);
        b.writeUInt16LE(dstPort, 6);
        this.udpSend(0x02, Buffer.concat([b, payload]));
    }
    async data(ms = 1000) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            const d = this.datagrams.shift();
            if (d && d[4] === 0x82) return { src: d.readUInt32LE(5), srcPort: d.readUInt16LE(9), dstPort: d.readUInt16LE(11), payload: d.subarray(13) };
            await sleep(10);
        }
        return null;
    }
    close() { this.tcp.destroy(); this.udp.close(); }
}

function nick(buf) {
    const end = buf.indexOf(0);
    return buf.subarray(0, end < 0 ? buf.length : end).toString('utf8');
}

async function main() {
    let server, statsDir;
    if (!process.argv[2]) {
        statsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanywhere-stats-'));
        server = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', String(PORT)],
            { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, LANYWHERE_STATS_PORT: String(PORT + 2),
                LANYWHERE_PUBLIC_PORT: '0', LANYWHERE_LANPLAY_PORT: '0', LANYWHERE_SHUTDOWN_GRACE_MS: '0',
                LANYWHERE_STATE_DIR: statsDir } });
        await new Promise((ok) => server.stdout.on('data', (d) => String(d).includes('datos UDP') && ok()));
    }
    const ok = (msg) => console.log('  ok', msg);
    try {
        const a = new Client('ana'), b = new Client('beto'), c = new Client('caro');
        for (const x of [a, b, c]) await x.connect();

        await a.create();
        await a.publish([a]);
        assert.match(a.code, /^[A-HJ-NP-Z2-9]{6}$/);
        assert.strictEqual(a.ip, ip('10.114.0.1'));
        ok(`sala creada ${a.code}, ana = 10.114.0.1`);

        await b.join(a.code.toLowerCase());
        b.onRoom(await b.frame(0x81));
        assert.strictEqual(b.ip, ip('10.114.0.2'));
        assert.strictEqual(b.members, 2);
        const joined = await a.frame(0x82);
        assert.strictEqual(joined.readUInt32LE(1), b.ip);
        ok('beto se une con el código (en minúsculas) y ana recibe el aviso');

        await a.register();
        await b.register();
        await a.publish([a, b]);
        a.sendData(b.ip, 12345, 12345, Buffer.from('hola beto'));
        const d1 = await b.data();
        assert.ok(d1 && d1.src === a.ip && d1.srcPort === 12345 && d1.payload.toString() === 'hola beto');
        assert.strictEqual(await a.data(200), null);
        ok('paquete directo ana → beto con la IP virtual de origen');

        await c.join(a.code);
        c.onRoom(await c.frame(0x81));
        await c.register();
        await a.publish([a, b, c]);
        b.sendData(ip('10.114.0.255'), 12345, 12345, Buffer.from('a todos'));
        const [da, dc] = [await a.data(), await c.data()];
        assert.ok(da && dc && da.payload.toString() === 'a todos' && dc.src === b.ip);
        assert.strictEqual(await b.data(200), null);
        ok('broadcast de beto llega a ana y caro, no a él mismo');

        c.sendFrame(0x04, Buffer.from([0, 5])); // DISCONNECT de LDN hacia el anfitrión
        const r = await a.frame(0x84);
        assert.deepStrictEqual(r, Buffer.from([c.index, 5]));
        await assert.rejects(b.frame(0x84, 300));
        ok('mensaje de control dirigido caro → ana (beto no lo recibe)');

        b.close();
        await assert.rejects(a.frame(0x83, 300));
        const b2 = new Client('beto');
        await b2.connect();
        const resume = Buffer.alloc(10);
        resume.writeUInt32LE(b.token, 0);
        resume.write(b.code, 4, 'ascii');
        b2.sendFrame(0x06, resume);
        b2.onRoom(await b2.frame(0x81));
        assert.ok(b2.index === b.index && b2.ip === b.ip && b2.token === b.token);
        ok('si se corta beto, su puesto se guarda y vuelve con RESUME (mismo índice e IP)');

        const bad = new Client('malo');
        await bad.connect();
        bad.sendFrame(0x06, Buffer.concat([Buffer.alloc(4), Buffer.from(b.code)]));
        assert.strictEqual((await bad.frame(0x85))[0], 5);
        bad.close();
        ok('RESUME con un token que no existe da error 5');

        b2.sendFrame(0x03);
        const left = await a.frame(0x83);
        assert.strictEqual(left[0], 1);
        b2.close();
        ok('al salir beto (LEAVE), ana recibe que salió');

        // Grupos abiertos: el anfitrión publica su grupo de ldn y alguien de fuera lo encuentra con FIND.
        await a.publish([a, c]);
        const finder = new Client('buscador');
        await finder.connect();
        const lc = Buffer.alloc(8);
        lc.writeBigUInt64LE(0x0100000000ABC000n);
        await sleep(100);
        finder.sendFrame(0x08, lc);
        let g = await finder.frame(0x87);
        assert.ok(g[0] === 1 && g.subarray(1, 7).toString() === a.code && g.length === 1 + 6 + 0x480);
        lc.writeBigUInt64LE(0x0100000000099000n);
        finder.sendFrame(0x08, lc);
        assert.strictEqual((await finder.frame(0x87))[0], 0);
        await a.publish([a, c], 2);  // lleno: deja de aparecer
        finder.sendFrame(0x08, Buffer.alloc(8));
        assert.strictEqual((await finder.frame(0x87))[0], 0);
        a.sendFrame(0x07);        // retirado
        a.sendFrame(0x05);
        await a.frame(0x86);
        finder.sendFrame(0x08, Buffer.alloc(8));
        assert.strictEqual((await finder.frame(0x87))[0], 0);
        finder.close();
        ok('grupo publicado: FIND lo encuentra por juego; lleno o retirado ya no aparece');

        const x = new Client('x');
        await x.connect();
        await x.join('ZZZZZZ');
        assert.strictEqual((await x.frame(0x85))[0], 1);
        await x.join(a.code, 0x0100000000099000n);
        assert.strictEqual((await x.frame(0x85))[0], 3);
        ok('errores: sala inexistente y sala de otro juego');

        const extra = [];
        await a.publish([a, c]);
        for (let i = 0; i < 7; i++) {  // ana y caro dentro: caben 6 más (8 en total)
            const y = new Client(`j${i}`);
            await y.connect();
            await y.join(a.code);
            extra.push(y);
        }
        const errs = [];
        for (const y of extra) {
            const f = await Promise.race([y.frame(0x81).then(() => 'ok'), y.frame(0x85).then((e) => e[0])]);
            errs.push(f);
        }
        assert.strictEqual(errs.filter((e) => e === 'ok').length, 6);
        assert.deepStrictEqual(errs.filter((e) => e !== 'ok'), [2]);
        ok('sala llena: entran 6 hasta completar 8 y el séptimo recibe "sala llena"');

        for (const y of [a, c, x, ...extra]) y.close();

        const rude = new Client('Put4 loca');
        await rude.connect();
        await rude.create();
        await rude.publish([rude]);
        const named = new Client('Tigre Veloz 27');
        await named.connect();
        await named.join(rude.code);
        const room = await named.frame(0x81);
        const nicks = [];
        for (let i = 0; i < room[23]; i++) nicks.push(nick(room.subarray(24 + i * 37 + 5, 24 + (i + 1) * 37)));
        assert.ok(/^Jugador \d{4}$/.test(nicks[0]), nicks[0]);
        assert.strictEqual(nicks[1], 'Tigre Veloz 27');
        rude.close();
        named.close();
        ok('apodos: uno ofensivo pasa a "Jugador NNNN"; uno normal se mantiene');

        if (server) {
            // Panel de actividad: solo en 127.0.0.1, con contadores y la página.
            const get = (url, options = {}) => new Promise((ok, fail) => require('http').get(url, options, (r) => {
                let body = '';
                r.on('data', (c) => (body += c));
                r.on('end', () => ok({ status: r.statusCode, body }));
            }).on('error', fail));
            const api = JSON.parse((await get(`http://127.0.0.1:${PORT + 2}/api/stats`)).body);
            assert.ok(api.counters.roomsCreated >= 1 && api.counters.joins >= 1 && api.counters.finds >= 1, JSON.stringify(api.counters));
            assert.ok(api.counters.nicksFiltered >= 1 && api.traffic.cap === 8000e9);
            // La lista de la app (origen 1) no cuenta como búsqueda de un juego, pero sí como "app abierta".
            const appClient = new Client('app');
            await appClient.connect();
            const appFind = Buffer.alloc(15);
            appFind[14] = 1;
            appClient.sendFrame(0x08, appFind);
            await appClient.frame(0x87);
            appClient.close();
            const after = JSON.parse((await get(`http://127.0.0.1:${PORT + 2}/api/stats`)).body);
            assert.strictEqual(after.counters.finds, api.counters.finds);
            assert.ok(after.now.appOpen >= 1);
            const page = await get(`http://127.0.0.1:${PORT + 2}/`);
            assert.ok(page.status === 200 && page.body.includes('LANywhere'));
            assert.strictEqual((await get(`http://127.0.0.1:${PORT + 2}/api/stats`,
                { headers: { host: 'untrusted.example' } })).status, 403);
            assert.strictEqual((await get(`http://127.0.0.1:${PORT + 2}/api/stats`,
                { headers: { origin: 'https://untrusted.example' } })).status, 403);
            assert.strictEqual((await get(`http://127.0.0.1:${PORT + 2}/api/stats`, { method: 'POST' })).status, 405);
            ok('panel: /api/stats cuenta salas, entradas, búsquedas (aparte las de la app) y apodos filtrados; la página se sirve');
        }

        if (server) {
            // Tope mensual: con el contador del mes ya por encima del tope, el servidor arranca en pausa.
            const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanywhere-'));
            fs.writeFileSync(path.join(dir, 'traffic.json'), JSON.stringify({ month: new Date().toISOString().slice(0, 7), bytes: 9e12 }));
            const capped = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--port', String(PORT + 1)],
                { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, LANYWHERE_STATS_PORT: '0',
                    LANYWHERE_PUBLIC_PORT: '0', LANYWHERE_LANPLAY_PORT: '0', LANYWHERE_SHUTDOWN_GRACE_MS: '0',
                    LANYWHERE_STATE_DIR: dir } });
            await new Promise((ok) => capped.stdout.on('data', (d) => String(d).includes('datos UDP') && ok()));
            const savedPort = PORT;
            PORT = PORT + 1;
            const p1 = new Client('p1');
            await p1.connect();
            p1.sendFrame(0x01, Buffer.concat([Buffer.alloc(8), p1.nick()]));
            assert.strictEqual((await p1.frame(0x85))[0], 6);
            p1.close();
            await stop(capped);
            PORT = savedPort;
            fs.rmSync(dir, { recursive: true, force: true });
            ok('tope mensual: por encima del tope el servidor está en pausa (error 6)');
        }
        console.log('TODAS LAS PRUEBAS OK');
    } finally {
        await stop(server);
        if (statsDir) fs.rmSync(statsDir, { recursive: true, force: true });
    }
}

main().then(() => process.exit(0), (e) => { console.error('FALLO:', e.message); process.exit(1); });
