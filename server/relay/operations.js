'use strict';

const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');

const LOOPBACK = '127.0.0.1';
const STATES = new Set(['booting', 'ready', 'draining', 'paused']);
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

function parseToken(value) {
    if (typeof value !== 'string' || !TOKEN.test(value)) return null;
    const decoded = Buffer.from(value, 'base64url');
    return decoded.length === 32 && decoded.toString('base64url') === value ? decoded : null;
}

function send(res, status, data, headers = {}) {
    const body = JSON.stringify(data);
    res.writeHead(status, {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers,
    });
    res.end(body);
}

function create({ port, status, drain, token }) {
    const adminToken = token === undefined ? null : parseToken(token);
    if (token !== undefined && !adminToken) throw new Error('LANYWHERE_OPS_TOKEN must be 32 bytes encoded as base64url');

    const server = http.createServer({
        headersTimeout: 2500, requestTimeout: 3500, connectionsCheckingInterval: 500,
        keepAliveTimeout: 1000, maxHeaderSize: 2048,
    }, (req, res) => {
        const host = req.headersDistinct.host;
        const localPort = req.socket.localPort;
        if (req.socket.remoteAddress !== LOOPBACK || req.headers.origin !== undefined ||
            host?.length !== 1 || ![`${LOOPBACK}:${localPort}`, `localhost:${localPort}`].includes(host[0]))
            return send(res, 403, { error: 'local operations only' }, { connection: 'close' });
        if (req.headers['transfer-encoding'] !== undefined || ![undefined, '0'].includes(req.headers['content-length']))
            return send(res, 413, { error: 'request bodies are unsupported' }, { connection: 'close' });

        if (req.url === '/api/ready') {
            if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' });
            const state = status();
            return send(res, state === 'ready' ? 200 : 503, { status: STATES.has(state) ? state : 'unavailable' });
        }
        if (req.url === '/api/drain') {
            if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' });
            const auth = req.headersDistinct.authorization;
            const supplied = auth?.length === 1 && /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(auth[0]);
            const candidate = supplied && parseToken(supplied[1]);
            if (!adminToken || !candidate || !timingSafeEqual(adminToken, candidate))
                return send(res, 403, { error: 'drain authorization required' });
            drain();
            return send(res, 202, { status: 'draining' });
        }
        return send(res, 404, { error: 'not found' });
    });
    server.maxConnections = 16;
    server.maxRequestsPerSocket = 8;
    server.setTimeout(4500, (socket) => socket.destroy());
    server.on('checkContinue', (_req, res) => send(res, 417, { error: 'unexpected request body' }, { connection: 'close' }));
    return server.listen(port, LOOPBACK);
}

module.exports = { create };
