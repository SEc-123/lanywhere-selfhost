/* LANywhere transport recovery policy. SPDX-License-Identifier: GPL-2.0-only */
#pragma once
#include <algorithm>
#include <cstdint>

namespace ams::mitm::lanywhere {
    enum class RecoveryResult { Resumed, Cancelled, Expired, Rejected, TimedOut };

    class TcpLiveness {
        uint64_t first_unanswered{};
        bool awaiting{};
    public:
        static constexpr uint64_t ReplyTimeoutMs = 15000;
        void Reset() { first_unanswered = 0; awaiting = false; }
        void Sent(uint64_t now) { if (!awaiting) first_unanswered = now; awaiting = true; }
        void Acknowledge() { awaiting = false; }
        bool Expired(uint64_t now) const {
            return awaiting && now >= first_unanswered && now - first_unanswered >= ReplyTimeoutMs;
        }
    };

    class RecoveryBackoff {
        unsigned attempt{};
    public:
        unsigned Next() {
            constexpr unsigned delays[] = {1000, 2000, 4000, 5000};
            return delays[std::min(attempt++, 3u)];
        }
    };
}
