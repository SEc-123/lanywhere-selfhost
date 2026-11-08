'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const deadline = require('./inbound-deadline');

// The same bounded framing path as the relay calls the production deadline
// helper. Real loopback sockets keep the test independent of clock mocks.
async function pair(t) {
    let accepted;
    let shutdownExpected = false;
    const unexpected = [];
    function recordError(error) {
        if (!shutdownExpected || !accepted?.destroyed || !['ECONNRESET', 'EPIPE'].includes(error.code))
            unexpected.push(error);
    }
    const server = net.createServer(s => {
        accepted = s;
        s.on('error', recordError);
        const inbound = deadline.create(s, 250);
        let pending = Buffer.alloc(0);
        s.on('data', chunk => {
            pending = Buffer.concat([pending, chunk]);
            while (pending.length >= 2) {
                const n = pending.readUInt16LE();
                if (n < 1 || n > 4096) return s.destroy();
                if (pending.length < n + 2) break;
                const frame = pending.subarray(2, n + 2);
                pending = pending.subarray(n + 2);
                if (deadline.knownCommand(frame[0], frame.subarray(1))) inbound.touch();
            }
        });
        s.on('close', () => inbound.close());
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const client = net.connect(server.address().port, '127.0.0.1');
    client.on('error', recordError);
    client.resume();
    await once(client, 'connect');
    while (!accepted) await delay(1);
    t.after(async () => {
        client.destroy();
        accepted.destroy();
        await new Promise(resolve => server.close(resolve));
        assert.deepEqual(unexpected, []);
    });
    return { client, accepted, expectShutdown: () => { shutdownExpected = true; } };
}

test('outbound traffic and partial inbound frame cannot extend the inbound deadline', async t => {
    const { client, accepted, expectShutdown } = await pair(t);
    const closed = Promise.all([accepted, client].map(socket => new Promise(resolve => socket.once('close', resolve))));
    expectShutdown();
    const writes = setInterval(() => { if (!accepted.destroyed) accepted.write('outbound'); }, 30);
    t.after(() => clearInterval(writes));
    client.write(Buffer.from([2, 0, 5])); // Incomplete frame; never reaches the touch call.
    await Promise.race([closed, delay(1000).then(() => { throw Error('inbound deadline did not close socket'); })]);
    assert(accepted.destroyed);
});

test('valid complete PINGs keep the connection alive, invalid PINGs do not', async t => {
    const { client, accepted, expectShutdown } = await pair(t);
    const closed = Promise.all([accepted, client].map(socket => new Promise(resolve => socket.once('close', resolve))));
    const ping = Buffer.from([1, 0, 5]);
    const pings = setInterval(() => { if (!client.destroyed) client.write(ping); }, 40);
    t.after(() => clearInterval(pings));
    await delay(650);
    clearInterval(pings);
    assert(!accepted.destroyed, 'valid inbound PINGs kept the deadline fresh');
    expectShutdown();
    const invalid = setInterval(() => { if (!client.destroyed) client.write(Buffer.from([2, 0, 5, 1])); }, 40);
    t.after(() => clearInterval(invalid));
    await Promise.race([closed, delay(1000).then(() => { throw Error('invalid PING kept socket alive'); })]);
});
