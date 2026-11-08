#pragma once
#include <cstdint>

namespace ams::mitm::lanywhere {
    class HeartbeatTracker {
        uint32_t nonce{};
        unsigned missed{};
        bool pending{};
    public:
        void Reset() { nonce = 0; missed = 0; pending = false; }
        bool NeedsRegistration() { return pending && ++missed >= 3; }
        void Sent(uint32_t value) { nonce = value; pending = true; }
        bool Acknowledge(uint32_t value) {
            if (!pending || nonce != value) return false;
            pending = false; missed = 0; return true;
        }
    };
}
