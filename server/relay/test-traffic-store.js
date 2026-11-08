'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { load, save } = require('./traffic-store');

const month = '2026-11';

function stateFile(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lanywhere-counter-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return path.join(dir, 'traffic.json');
}

test('a new file starts at zero and subsequent atomic checkpoints survive reopen', (t) => {
    const filename = stateFile(t);
    assert.deepEqual(load(filename, month), { month, bytes: 0 });
    save(filename, { month, bytes: 999 });
    save(filename, { month, bytes: 1001 });
    assert.deepEqual(load(filename, month), { month, bytes: 1001 });
    assert.deepEqual(load(filename, '2026-12'), { month, bytes: 1001 });
    assert.deepEqual(fs.readdirSync(path.dirname(filename)), ['traffic.json']);
    if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
});

test('corrupt, oversized, and future-month checkpoints fail closed', (t) => {
    const filename = stateFile(t);
    for (const payload of ['', '{"month":', 'null', 'x'.repeat(4096), '{"month":"2026-13","bytes":5}',
        '{"month":"2026-11","bytes":"99"}', '{"month":"2026-11","bytes":-1}',
        '{"month":"2026-11","bytes":9007199254740992}', '{"month":"2026-12","bytes":10}']) {
        fs.writeFileSync(filename, payload);
        assert.throws(() => load(filename, month), /invalid|ahead/);
        assert.equal(fs.readFileSync(filename, 'utf8'), payload);
    }
    assert.throws(() => load(path.join(path.dirname(filename), 'absent', 'traffic.json'), month), { code: 'ENOENT' });
});

test('invalid writes preserve the valid checkpoint and failed renames clean up temporary files', (t) => {
    const filename = stateFile(t);
    save(filename, { month, bytes: 10 });
    assert.throws(() => save(filename, { month, bytes: NaN }), /non-negative safe integer/);
    assert.deepEqual(load(filename, month), { month, bytes: 10 });
    const directory = path.join(path.dirname(filename), 'directory');
    fs.mkdirSync(directory);
    assert.throws(() => save(directory, { month, bytes: 20 }));
    assert.deepEqual(fs.readdirSync(path.dirname(filename)).sort(), ['directory', 'traffic.json']);
});

test('the relay will not listen or replace a corrupt persisted counter', (t) => {
    const filename = stateFile(t);
    fs.writeFileSync(filename, '{"month":');
    const result = spawnSync(process.execPath, [path.join(__dirname, 'server.js'), '--port', '0'], {
        env: { ...process.env, LANYWHERE_STATE_DIR: path.dirname(filename), LANYWHERE_STATS_PORT: '0',
            LANYWHERE_OPS_PORT: '0', LANYWHERE_PUBLIC_PORT: '0', LANYWHERE_LANPLAY_PORT: '0' },
        encoding: 'utf8', timeout: 4000,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /invalid persisted traffic state/);
    assert.doesNotMatch(result.stdout, /control TCP|datos UDP/);
    assert.equal(fs.readFileSync(filename, 'utf8'), '{"month":');
});
