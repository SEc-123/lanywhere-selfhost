/* SPDX-License-Identifier: GPL-2.0-only */
#pragma once
#include "ldn.h"
namespace overlay {
    struct Snapshot {
        bool config_ok{}, relay_ok{}, enabled{}, logging{};
        LanywhereOverlayStatus status{};
        LanywhereOverlayMatch match{};
    };
    inline bool canChangeEnabled(const Snapshot &s) {
        // Missing relay data is not proof that the game is idle.
        return s.config_ok && s.relay_ok && s.status.state == 0 &&
            (s.match.state == 0 || s.match.state == 6 || s.match.state == 7 || s.match.state == 8);
    }
}
