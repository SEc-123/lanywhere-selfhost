'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const MAX_STATE_BYTES = 256;
const validMonth = (month) => typeof month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);

function validate(state) {
    if (!state || !validMonth(state.month) || !Number.isSafeInteger(state.bytes) || state.bytes < 0)
        throw new Error('traffic state must contain a YYYY-MM month and a non-negative safe integer byte count');
    return { month: state.month, bytes: state.bytes };
}

function load(filename, currentMonth) {
    if (!validMonth(currentMonth)) throw new Error('current traffic month must be YYYY-MM');
    let fd;
    try {
        fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    } catch (error) {
        // Only a genuinely new state file can start with a zero counter.
        if (error.code !== 'ENOENT' || !fs.statSync(path.dirname(filename)).isDirectory()) throw error;
        return { month: currentMonth, bytes: 0 };
    }
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_STATE_BYTES) throw new Error('invalid traffic state file');
        const raw = Buffer.alloc(MAX_STATE_BYTES + 1);
        const n = fs.readSync(fd, raw, 0, raw.length, 0);
        if (n !== stat.size) throw new Error('traffic state changed while it was read');
        let state;
        try {
            state = validate(JSON.parse(raw.subarray(0, n).toString('utf8')));
        } catch (error) {
            throw new Error('invalid persisted traffic state', { cause: error });
        }
        if (state.month > currentMonth) throw new Error('persisted traffic month is ahead of the server clock');
        return state;
    } finally {
        fs.closeSync(fd);
    }
}

function save(filename, state) {
    const content = `${JSON.stringify(validate(state))}\n`;
    const dir = path.dirname(filename);
    const temporary = path.join(dir, `.${path.basename(filename)}.${randomBytes(8).toString('hex')}.tmp`);
    let created = false;
    try {
        const fd = fs.openSync(temporary, 'wx', 0o600);
        created = true;
        try {
            fs.writeFileSync(fd, content, 'utf8');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temporary, filename);
        created = false;
        const dirFd = fs.openSync(dir, 'r');
        try {
            fs.fsyncSync(dirFd);
        } finally {
            fs.closeSync(dirFd);
        }
    } finally {
        if (created) fs.rmSync(temporary, { force: true });
    }
}

module.exports = { load, save };
