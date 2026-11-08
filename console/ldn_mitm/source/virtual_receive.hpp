#pragma once
#include <algorithm>
#include <cstdint>

namespace ams::mitm::bsd {
    struct ReceiveResult { int ret; int error; uint32_t addrlen; };

    // Waits for both the real socket and the relay queue while retaining the caller's
    // nonblocking and SO_RCVTIMEO semantics. Wait is bounded only to observe the
    // queue; it is not the socket's receive deadline.
    template<class Clock, class Active, class Relay, class Native, class Wait>
    bool WaitVirtualReceive(bool nonblocking, int64_t timeout_ms, int again, Clock clock,
                            Active active, Relay relay, Native native, Wait wait, ReceiveResult *out) {
        const int64_t start = clock();
        for (;;) {
            if (!active()) return false;
            if (relay(out)) return true;
            *out = native();
            if (out->ret >= 0 || out->error != again) return true;
            const int64_t elapsed = std::max<int64_t>(0, clock() - start);
            if (nonblocking || (timeout_ms > 0 && elapsed >= timeout_ms)) return true;
            const int slice = timeout_ms > 0 ? static_cast<int>(std::min<int64_t>(5, timeout_ms - elapsed)) : 5;
            const int error = wait(slice);
            if (error) { *out = {-1, error, 0}; return true; }
        }
    }
}
