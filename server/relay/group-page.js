'use strict';

// A page is a fresh view of the live lobby, never a list of invented match rooms.
// A room code stays the selection identity as other players join/leave between pages.
const PAGE_SIZE = 6;
const END = 0xffffffff;

function groupPage({ rooms, lcid = 0n, offset = 0, isOpen, matches = () => true }) {
    if (typeof lcid !== 'bigint' || lcid < 0n || lcid > 0xffffffffffffffffn ||
        !Number.isInteger(offset) || offset < 0 || offset > END || typeof isOpen !== 'function')
        throw new TypeError('invalid lobby page query');
    const visible = [];
    for (const room of rooms) {
        if (room.gameId && (!lcid || room.gameId === lcid) && room.published && isOpen(room) && matches(room)) visible.push(room);
    }
    // Group games, then fill the busiest open room first. The code is the stable tie breaker.
    visible.sort((a, b) => {
        if (a.gameId !== b.gameId) return a.gameId < b.gameId ? -1 : 1;
        const population = b.published.info[0x67] - a.published.info[0x67];
        return population || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
    });
    const entries = visible.slice(offset, offset + PAGE_SIZE);
    const nextOffset = offset + entries.length < visible.length ? offset + entries.length : END;
    return { entries, nextOffset };
}

module.exports = { groupPage, PAGE_SIZE, END };
