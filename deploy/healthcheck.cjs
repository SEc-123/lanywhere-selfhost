'use strict';

const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');

const controlPort = Number(process.env.LANYWHERE_HEALTH_CONTROL_PORT || 11460);
const statsPort = Number(process.env.LANYWHERE_STATS_PORT || 11461);
const opsPort = Number(process.env.LANYWHERE_OPS_PORT || 11462);

function checkControl() {
    return new Promise((resolve, reject) => {
        const socket = net.connect({ host: '127.0.0.1', port: controlPort });
        let response = Buffer.alloc(0);
        socket.setTimeout(1000, () => socket.destroy(new Error('Control PONG timed out')));
        socket.on('error', reject);
        socket.on('close', () => reject(new Error('Control connection closed before PONG')));
        socket.on('connect', () => socket.write(Buffer.from([0x01, 0x00, 0x05])));
        socket.on('data', (data) => {
            response = Buffer.concat([response, data]);
            if (response.length < 3) return;
            if (!response.subarray(0, 3).equals(Buffer.from([0x01, 0x00, 0x86]))) {
                socket.destroy(new Error('Unexpected control response'));
                return;
            }
            resolve();
            socket.destroy();
        });
    });
}

async function checkDashboard() {
    const response = await fetch(`http://127.0.0.1:${statsPort}/api/stats`, {
        signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) throw new Error(`Dashboard returned HTTP ${response.status}`);
    const stats = await response.json();
    if (!stats.now || !stats.traffic) throw new Error('Unexpected dashboard response');
}

async function checkReadiness(allowPaused) {
    const response = await fetch(`http://127.0.0.1:${opsPort}/api/ready`, {
        signal: AbortSignal.timeout(1000),
    });
    const { status } = await response.json();
    if (response.ok && status === 'ready') return 'ready';
    if (allowPaused && response.status === 503 && status === 'paused') return 'paused';
    const known = ['booting', 'draining', 'paused'].includes(status) ? status : `HTTP ${response.status}`;
    throw new Error(`Relay is not ready (${known})`);
}

async function main() {
    const once = process.argv.includes('--once');
    const live = process.argv.includes('--live');
    const allowPaused = process.argv.includes('--allow-paused');
    for (let attempt = 0; ; attempt += 1) {
        try {
            const checks = [checkControl(), checkDashboard(), live ? 'live' : checkReadiness(allowPaused)];
            const [, , status] = await Promise.all(checks);
            const result = {
                live: 'local control and dashboard are alive',
                ready: 'relay is ready',
                paused: 'relay is running with its monthly traffic cap reached',
            }[status];
            console.log(`Switch Online: ${result}`);
            return;
        } catch (error) {
            if (once || attempt === 5) throw error;
            await delay(500);
        }
    }
}

main().catch((error) => {
    console.error(`Switch Online health check: ${error.message}`);
    process.exitCode = 1;
});
