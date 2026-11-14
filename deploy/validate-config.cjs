'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { parseEndpoint } = require(fs.existsSync(path.join(__dirname, 'regional-directory.js')) ?
    './regional-directory.js' : '../server/relay/regional-directory.js');

// Keep the managed service ports and state directory in the unit, and only
// accept documented tuning values, regional address and operations token here.
const integerRanges = new Map([
    ['LANYWHERE_LANPLAY_PORT', [0, 65535]],
    ['LANYWHERE_ENABLE_PUBLIC_UPSTREAM', [0, 1]],
    ['LANYWHERE_ENABLE_COMMUNITY_DIRECT', [0, 1]],
    ['LANYWHERE_ENABLE_LANPLAY_UPSTREAM', [0, 1]],
    ['LANYWHERE_MAX_CONNECTIONS', [1, 16000]],
    ['LANYWHERE_MAX_CONNECTIONS_PER_IP', [1, 1024]],
    ['LANYWHERE_CONTROL_FRAMES_PER_SEC', [1, 10000]],
    ['LANYWHERE_DATA_BYTES_PER_SEC', [1, 64 * 1024 * 1024]],
    ['LANYWHERE_DATA_PACKETS_PER_SEC', [1, 10000]],
    ['LANYWHERE_GRACE_MS', [1, 300000]],
    ['LANYWHERE_MATCH_WAIT_MS', [1, 300000]],
    ['LANYWHERE_MATCH_HOLD_MS', [1, 120000]],
    ['LANYWHERE_SHUTDOWN_GRACE_MS', [0, 300000]],
    ['LANYWHERE_JOIN_TIMEOUT_MS', [100, 120000]],
    ['LANYWHERE_CREATE_PER_MIN', [1, 1000]],
]);

function validateConfig(source, { localAddresses = Object.values(os.networkInterfaces()).flat().filter(Boolean)
    .filter(address => address.family === 'IPv4' || address.family === 4).map(address => address.address) } = {}) {
    const settings = new Map();
    for (const [index, line] of source.split(/\r?\n/).entries()) {
        const text = line.trim();
        if (text === '' || text.startsWith('#')) continue;
        const match = /^([A-Z_]+)=([^\s]+)$/.exec(text);
        const prefix = `line ${index + 1}`;
        if (!match) throw new Error(`${prefix}: expected NAME=value without quotes or inline comments`);
        const [, key, value] = match;
        if (settings.has(key)) throw new Error(`${prefix}: repeated ${key}`);
        if (integerRanges.has(key)) {
            const [min, max] = integerRanges.get(key);
            if (!/^\d+$/.test(value) || Number(value) < min || Number(value) > max)
                throw new Error(`${prefix}: ${key} must be between ${min} and ${max}`);
            if (key === 'LANYWHERE_LANPLAY_PORT' && Number(value) === 11460)
                throw new Error(`${prefix}: optional LAN Play must use a separate port from 11460/UDP`);
        } else if (key === 'LANYWHERE_CAP_GB') {
            const bytes = Math.floor(Number(value) * 1e9);
            if (!/^\d+(?:\.\d+)?$/.test(value) || !Number.isSafeInteger(bytes) || bytes < 1)
                throw new Error(`${prefix}: ${key} must be a positive decimal traffic limit`);
        } else if (key === 'LANYWHERE_OPS_TOKEN') {
            if (!/^[A-Za-z0-9_-]{43}$/.test(value) || Buffer.from(value, 'base64url').toString('base64url') !== value)
                throw new Error(`${prefix}: ${key} must be a generated 32-byte base64url token`);
        } else if (key === 'LANYWHERE_EU_RELAY') {
            try { parseEndpoint(value); } catch (error) { throw new Error(`${prefix}: ${error.message}`); }
        } else if (key === 'LANYWHERE_LANPLAY_PROVIDERS') {
            const allowed = new Set(['lanplay-nl','lanplay-br','lanplay-id','lanplay-nl-jaysea-rust','lanplay-nl-r3ps4j-rust','lanplay-nl-r3ps4j-11452','lanplay-de-servegame',
                'lanplay-cn-jax','lanplay-cn-gugu','lanplay-cn-olunira','lanplay-cn-shanghai']);
            const ids = value.split(',');
            if (!ids.length || ids.some(id => !allowed.has(id)) || new Set(ids).size !== ids.length)
                throw new Error(`${prefix}: select unique, built-in LAN Play provider IDs`);
        } else if (key === 'LANYWHERE_UDP_BIND_ADDRESS') {
            if (!net.isIPv4(value)) throw new Error(`${prefix}: ${key} must be a literal IPv4 address`);
            if (value !== '0.0.0.0' && !localAddresses.includes(value))
                throw new Error(`${prefix}: ${key} must be assigned to a local interface (use the local address behind NAT)`);
        } else {
            throw new Error(`${prefix}: ${key} is not a managed setting`);
        }
        settings.set(key, value);
    }
    const total = Number(settings.get('LANYWHERE_MAX_CONNECTIONS') || 1024);
    const perIp = Number(settings.get('LANYWHERE_MAX_CONNECTIONS_PER_IP') || 12);
    if (perIp > total) throw new Error('The per-IP connection limit exceeds the total connection limit');
    if (Number(settings.get('LANYWHERE_ENABLE_COMMUNITY_DIRECT')) === 1 &&
        Number(settings.get('LANYWHERE_ENABLE_PUBLIC_UPSTREAM')) !== 1)
        throw new Error('Community direct requires LANYWHERE_ENABLE_PUBLIC_UPSTREAM=1');
}

if (require.main === module) {
    try {
        const filename = process.argv[2] || '/etc/switch-online/relay.env';
        validateConfig(fs.readFileSync(filename, 'utf8'));
        console.log('Switch Online configuration valid');
    } catch (error) {
        console.error(`Switch Online configuration: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = { validateConfig };
