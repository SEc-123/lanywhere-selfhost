'use strict';

// Framing is checked by the caller before this function; command-specific
// validation remains in the normal protocol handlers.
function knownCommand(type, body) {
    return ((type >= 1 && type <= 0x0d) || type === 0x20 || type === 0x21 ||
            type === 0x22 || type === 0x24) && (type !== 5 || body.length === 0);
}

function create(socket, timeoutMs) {
    let timer;
    function touch() {
        clearTimeout(timer);
        timer = setTimeout(() => socket.destroy(), timeoutMs);
        timer.unref();
    }
    function close() { clearTimeout(timer); timer = undefined; }
    touch();
    return { touch, close };
}

module.exports = { create, knownCommand };
