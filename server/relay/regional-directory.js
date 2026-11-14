'use strict';

const net = require('node:net');
const { RECORD_BYTES, parse } = require('./room-metadata');
const { PAGE_SIZE, END } = require('./group-page');

const PROVIDER = 'relay-eu', CAPABILITY = 8192, REQUEST = 0x2a, RESPONSE = 0xaa;
const FIND_META_PAGE = 0x22, META_PAGE = 0xa2, TIMEOUT_MS = 3000, MAX_PAGES = 24;
const HEADER_BYTES = 5, MAX_FRAME_BYTES = 3 + HEADER_BYTES + PAGE_SIZE * RECORD_BYTES;

function parseEndpoint(value) {
    if (value === undefined) return null;
    const match = /^([\d.]+):([1-9]\d{0,4})$/.exec(value);
    const host = match?.[1], port = Number(match?.[2]);
    if (!host || !net.isIPv4(host) || port > 65535)
        throw new Error('LANYWHERE_EU_RELAY must be a literal IPv4 address and port (IPv4:port)');
    const octets = host.split('.').map(Number);
    if (octets[0] === 0 || octets[0] >= 224)
        throw new Error('LANYWHERE_EU_RELAY must be a unicast IPv4 address');
    const wire = Buffer.alloc(7);
    wire.set(octets);
    wire.writeUInt16BE(port, 4);
    return { host, port, wire };
}

function validSummary(row) {
    const id = row.readBigUInt64LE(8);
    if (!/^[A-HJ-NP-Z2-9]{6}$/.test(row.toString('latin1', 0, 6)) ||
        row[6] || row[7] || id === 0n || id === 0xffffffffffffffffn ||
        !row[32] || row[32] > row[33] || row[33] > 8 ||
        row[34] > 1 || row[35] > 2 || row.subarray(36, 40).some(Boolean)) return false;
    const identity = Buffer.concat([row.subarray(24, 32), row.subarray(16, 24), row.subarray(80)]);
    return row[34] ? Boolean(parse(identity)) : !identity.some(Boolean);
}

function create(endpoint, { localAddress, sent = () => {} } = {}) {
    let closed = false, active = null;

    function query() {
        if (closed || active) return Promise.resolve(null);

        return new Promise(resolve => {
            const socket = net.createConnection({ host: endpoint.host, port: endpoint.port, localAddress });
            socket.setNoDelay(true);
            const rows = new Map();
            let offset = 0, pages = 0, pending = Buffer.alloc(0);
            let finished = false;
            const timer = setTimeout(() => finish(null), TIMEOUT_MS).unref();
            active = () => finish(null);

            function finish(result) {
                if (finished) return;
                finished = true;
                active = null;
                clearTimeout(timer);
                socket.destroy();
                resolve(result);
            }

            function ask() {
                const frame = Buffer.alloc(16);
                frame.writeUInt16LE(frame.length - 2);
                frame[2] = FIND_META_PAGE;
                frame.writeUInt32LE(offset, 11);
                frame[15] = 1; // Request own rooms including their password modes.
                socket.write(frame);
                sent(frame.length);
            }

            socket.on('connect', () => { if (!finished) ask(); });
            socket.on('data', chunk => {
                if (finished) return;
                if (pending.length + chunk.length > MAX_FRAME_BYTES) return finish(null);
                pending = Buffer.concat([pending, chunk]);
                if (pending.length < 2) return;
                const frameBytes = pending.readUInt16LE() + 2;
                if (frameBytes < 3 || frameBytes > MAX_FRAME_BYTES) return finish(null);
                if (pending.length < frameBytes) return;
                if (pending.length !== frameBytes || frameBytes < 3 + HEADER_BYTES || pending[2] !== META_PAGE)
                    return finish(null);

                const next = pending.readUInt32LE(3), count = pending[7];
                if (count > PAGE_SIZE || frameBytes !== 3 + HEADER_BYTES + count * RECORD_BYTES ||
                    (next !== END && (count !== PAGE_SIZE || next !== offset + count))) return finish(null);
                for (let i = 0; i < count; i++) {
                    const start = 3 + HEADER_BYTES + i * RECORD_BYTES;
                    const row = pending.subarray(start, start + RECORD_BYTES);
                    const code = row.toString('ascii', 0, 6);
                    if (!validSummary(row)) return finish(null);
                    rows.set(code, row);
                }
                if (next === END) return finish([...rows.values()]);
                if (++pages >= MAX_PAGES) return finish(null);
                offset = next;
                pending = Buffer.alloc(0);
                ask();
            });
            socket.on('error', () => finish(null));
            socket.on('close', () => finish(null));
        });
    }

    return { endpoint, query, shutdown: () => { closed = true; active?.(); } };
}

module.exports = { PROVIDER, CAPABILITY, REQUEST, RESPONSE, parseEndpoint, create };
