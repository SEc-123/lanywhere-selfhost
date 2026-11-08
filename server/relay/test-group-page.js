'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { groupPage, END } = require('./group-page');

function room(n, gameId = 1n, players = 1, open = true) {
    const published = Buffer.alloc(0x480);
    published[0x67] = players;
    return { code: `R${String(n).padStart(5, '0')}`, gameId, published: { info: published }, open };
}
const isOpen = r => r.open;

test('every open room can be reached once over several pages of a stable lobby', () => {
    const rooms = Array.from({ length: 19 }, (_, i) => room(i, i < 9 ? 1n : 2n, 1 + (i % 4)));
    rooms.push(room(20, 1n, 8, false), room(21, 0n), { ...room(22), published: null });
    const seen = [], pages = [];
    for (let offset = 0; offset !== END;) {
        const page = groupPage({ rooms, offset, isOpen });
        assert(page.entries.length <= 6);
        pages.push(page.entries.length);
        seen.push(...page.entries.map(r => r.code));
        offset = page.nextOffset;
    }
    assert.deepEqual(pages, [6, 6, 6, 1]);
    assert.equal(new Set(seen).size, 19);
    assert.equal(seen[0], 'R00003');
    assert.equal(seen[1], 'R00007');
});

test('LCID filtering, out of range cursor and empty lobby never return an unrelated room', () => {
    const rooms = [room(1, 2n), room(2, 1n), room(3, 2n)];
    assert.deepEqual(groupPage({ rooms, lcid: 1n, isOpen }).entries.map(r => r.code), ['R00002']);
    assert.deepEqual(groupPage({ rooms, lcid: 3n, isOpen }), { entries: [], nextOffset: END });
    assert.deepEqual(groupPage({ rooms, offset: END, isOpen }), { entries: [], nextOffset: END });
    assert.deepEqual(groupPage({ rooms: [], isOpen }), { entries: [], nextOffset: END });
});

test('a live page applies current room admission state and has deterministic ties', () => {
    const rooms = [room(3), room(1), room(2)];
    assert.deepEqual(groupPage({ rooms, isOpen }).entries.map(r => r.code), ['R00001', 'R00002', 'R00003']);
    rooms[1].open = false;
    assert.deepEqual(groupPage({ rooms, isOpen }).entries.map(r => r.code), ['R00002', 'R00003']);
    assert.throws(() => groupPage({ rooms, offset: -1, isOpen }), TypeError);
    assert.throws(() => groupPage({ rooms, offset: 0.5, isOpen }), TypeError);
    assert.throws(() => groupPage({ rooms, lcid: 1, isOpen }), TypeError);
});
