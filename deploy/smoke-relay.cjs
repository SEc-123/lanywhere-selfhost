'use strict';

const dgram = require('node:dgram');
const { lookup } = require('node:dns/promises');
const { once } = require('node:events');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const MAGIC = 0x594e414c;

class Peer {
    constructor(name, host, port) {
        this.name = name;
        this.host = host;
        this.port = port;
        this.frames = [];
        this.packets = [];
        this.failure = null;
    }

    async connect() {
        this.tcp = net.connect({ host: this.host, port: this.port });
        let pending = Buffer.alloc(0);
        this.tcp.on('error', (error) => { this.failure = error; });
        this.tcp.on('data', (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 3) {
                const size = pending.readUInt16LE(0);
                if (size === 0 || size > 8192) {
                    this.failure = new Error('Malformed TCP response');
                    this.tcp.destroy();
                    return;
                }
                if (pending.length < 2 + size) break;
                this.frames.push(pending.subarray(2, 2 + size));
                pending = pending.subarray(2 + size);
            }
        });
        await once(this.tcp, 'connect', { signal: AbortSignal.timeout(3000) });
    }

    send(type, body = Buffer.alloc(0)) {
        const header = Buffer.from([0, 0, type]);
        header.writeUInt16LE(body.length + 1);
        this.tcp.write(Buffer.concat([header, body]));
    }

    async frame(type) {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
            if (this.failure) throw this.failure;
            while (this.frames.length) {
                const frame = this.frames.shift();
                if (frame[0] === 0x85) throw new Error(`Relay rejected ${this.name} with protocol error ${frame[1]}`);
                if (frame[0] === type) return frame.subarray(1);
            }
            if (this.tcp.destroyed) throw new Error(`${this.name} control connection closed`);
            await delay(20);
        }
        throw new Error(`${this.name} timed out awaiting TCP frame 0x${type.toString(16)}`);
    }

    async enter(code) {
        const nick = Buffer.alloc(32);
        nick.write(this.name, 'ascii');
        if (code) this.send(0x02, Buffer.concat([code, nick, Buffer.alloc(8)]));
        else this.send(0x01, Buffer.concat([Buffer.alloc(8), nick]));
        const room = await this.frame(0x81);
        if (room.length < 24) throw new Error('Truncated room reply');
        this.code = room.subarray(0, 6);
        this.ip = room.readUInt32LE(7);
        this.token = room.readUInt32LE(11);
    }

    sendUdp(type, body = Buffer.alloc(0)) {
        const header = Buffer.alloc(9);
        header.writeUInt32LE(MAGIC, 0);
        header[4] = type;
        header.writeUInt32LE(this.token, 5);
        this.udp.send(Buffer.concat([header, body]));
    }

    async register() {
        this.udp = dgram.createSocket('udp4');
        this.udp.on('error', (error) => { this.failure = error; });
        this.udp.on('message', (packet, sender) => {
            if (sender.address !== this.host || sender.port !== this.port) return;
            if (packet.length >= 5 && packet.readUInt32LE(0) === MAGIC) this.packets.push(packet);
        });
        const connected = once(this.udp, 'connect', { signal: AbortSignal.timeout(3000) });
        this.udp.connect(this.port, this.host);
        await connected;
        for (let attempt = 0; attempt < 12; attempt += 1) {
            if (this.failure) throw this.failure;
            this.sendUdp(0x01);
            await delay(150);
            if (this.packets.some((packet) => packet[4] === 0x81)) return;
        }
        throw new Error(`${this.name} could not register UDP`);
    }

    async transfer(receiver) {
        const marker = randomBytes(16);
        const packet = Buffer.alloc(8);
        packet.writeUInt32LE(receiver.ip, 0);
        packet.writeUInt16LE(45601, 4);
        packet.writeUInt16LE(45602, 6);
        for (let attempt = 0; attempt < 12; attempt += 1) {
            if (this.failure || receiver.failure) throw this.failure || receiver.failure;
            this.sendUdp(0x02, Buffer.concat([packet, marker]));
            await delay(150);
            if (receiver.packets.some((reply) => reply.length === 29 && reply[4] === 0x82 &&
                reply.readUInt32LE(5) === this.ip && reply.readUInt16LE(9) === 45601 &&
                reply.readUInt16LE(11) === 45602 && reply.subarray(13).equals(marker))) return;
        }
        throw new Error(`No UDP relay data reached ${receiver.name}`);
    }

    async leave() {
        if (this.code && !this.tcp.destroyed) {
            this.send(0x03);
            this.send(0x05);
            await this.frame(0x86);
        }
    }

    close() {
        this.tcp?.destroy();
        try { this.udp?.close(); } catch (error) {
            if (error.code !== 'ERR_SOCKET_DGRAM_NOT_RUNNING') throw error;
        }
    }
}

async function main() {
    const [host, portArg = '11460', ...extra] = process.argv.slice(2);
    const port = Number(portArg);
    if (!host || !/^\d+$/.test(portArg) || port < 1 || port > 65535 || extra.length)
        throw new Error('Usage: node deploy/smoke-relay.cjs VPS_HOST [11460]');
    const { address } = await lookup(host, { family: 4 });
    const first = new Peer('RelaySmokeA', address, port);
    const second = new Peer('RelaySmokeB', address, port);
    try {
        await Promise.all([first.connect(), second.connect()]);
        await first.enter();
        await second.enter(first.code);
        if (!second.code.equals(first.code) || second.ip === first.ip) throw new Error('Room membership did not match');
        await Promise.all([first.register(), second.register()]);
        await Promise.all([first.transfer(second), second.transfer(first)]);
        await Promise.all([second.leave(), first.leave()]);
        console.log('Switch Online relay smoke passed: TCP create/join, UDP registration, bidirectional UDP, leave');
    } finally {
        first.close();
        second.close();
    }
}

if (require.main === module) main().catch((error) => {
    console.error(`Switch Online relay smoke: ${error.message}`);
    process.exitCode = 1;
});

module.exports = { Peer };
