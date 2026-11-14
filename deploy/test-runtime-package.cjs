'use strict';
// Deployment regression: every literal local runtime dependency must be shipped.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {test} = require('node:test');
const root = path.resolve(__dirname, '..');
test('managed release includes every local runtime dependency ', () => {
    const installer = fs.readFileSync(path.join(__dirname, 'install-systemd.sh'), 'utf8');
    const files = new Set(installer.match(/^relay_files=\(([^)]+)\)/m)[1].trim().split(/\s+/));
    for (const name of files) {
        const file = path.join(root, 'server/relay', name);
        assert(fs.statSync(file).isFile(), `missing package source: ${name}`);
        if (!/\.(?:js|cjs)$/.test(name)) continue;
        const source = fs.readFileSync(file, 'utf8');
        for (const [, relative] of source.matchAll(/\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
            const resolved = require.resolve(path.resolve(path.dirname(file), relative));
            const dependency = path.relative(path.join(root, 'server/relay'), resolved);
            assert(files.has(dependency), `${name} needs unshipped ${dependency}`);
        }
    }
    for (const name of ['upstream-gateway.js','room-metadata.js','lanplay-providers.js','lanplay-realms.js','unified-lobby.js','regional-directory.js'])
        assert(files.has(name), `${name} must be shipped with the gateway release`);
});
