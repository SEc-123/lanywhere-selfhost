'use strict';

const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const http = require('node:http');
const test = require('node:test');
const { create } = require('./operations');

const token = () => randomBytes(32).toString('base64url');

async function listen(t, options) {
    const server = create({ port: 0, ...options });
    t.after(() => new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
    }));
    await once(server, 'listening');
    const { address, port } = server.address();
    assert.equal(address, '127.0.0.1');
    return port;
}

function request(port, pathname, method = 'GET', headers = {}, body = '') {
    return new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers, agent: false }, (res) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(2500, () => req.destroy(new Error('operations response timeout')));
        req.end(body);
    });
}

test('readiness is loopback-only and distinguishes lifecycle states', async (t) => {
    let state = 'booting';
    const port = await listen(t, { status: () => state, drain: () => {} });
    for (const [status, code] of [['booting', 503], ['ready', 200], ['paused', 503], ['draining', 503]]) {
        state = status;
        const result = await request(port, '/api/ready');
        assert.equal(result.status, code);
        assert.deepEqual(result.data, { status });
        assert.equal(result.headers['cache-control'], 'no-store');
    }
    assert.equal((await request(port, '/api/ready', 'GET', { host: `evil.test:${port}` })).status, 403);
    assert.equal((await request(port, '/api/ready', 'POST')).status, 405);
    assert.equal((await request(port, '/api/stats')).status, 404);
});

test('drain rejects browser-origin requests, request bodies, and unauthorized callers', async (t) => {
    const secret = token();
    let state = 'ready', calls = 0;
    const port = await listen(t, { status: () => state, drain: () => { state = 'draining'; calls++; }, token: secret });
    const auth = { authorization: `Bearer ${secret}` };
    assert.equal((await request(port, '/api/drain')).status, 405);
    assert.equal((await request(port, '/api/drain', 'POST')).status, 403);
    assert.equal((await request(port, '/api/drain', 'POST', { authorization: `Bearer ${token()}` })).status, 403);
    assert.equal((await request(port, '/api/drain', 'POST', { ...auth, origin: 'https://evil.test' })).status, 403);
    assert.equal((await request(port, '/api/drain', 'POST', { ...auth, 'content-length': '1' }, 'x')).status, 413);
    assert.equal(calls, 0);
    const result = await request(port, '/api/drain', 'POST', auth);
    assert.equal(result.status, 202);
    assert.deepEqual(result.data, { status: 'draining' });
    assert.equal(calls, 1);
    assert.equal((await request(port, '/api/ready')).status, 503);
});

test('drain stays disabled without a credential and rejects bad startup credentials', async (t) => {
    const port = await listen(t, { status: () => 'ready', drain: () => assert.fail('drain should be disabled') });
    assert.equal((await request(port, '/api/drain', 'POST', { authorization: `Bearer ${token()}` })).status, 403);
    assert.throws(() => create({ port: 0, token: 'short' }), /LANYWHERE_OPS_TOKEN/);
});
