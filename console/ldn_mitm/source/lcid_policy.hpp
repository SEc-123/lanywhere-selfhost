#pragma once
#include <cstdint>
#include "../../../common/game_identity_cache.h"

namespace ams::mitm::ldn {
    enum class LcidPolicyError { None, Unavailable, NotAllowed };
    struct LcidResolution {
        uint64_t wire, canonical;
        LcidPolicyError error;
    };

    // A validated exact caller record is required for self's default sentinel.
    // External ldn_mitm communities intentionally retain the legacy sentinel;
    // canonical is local identity information and must never replace their wire ID.
    inline LcidResolution ResolveGameLcid(uint64_t requested, bool self,
                                          GameCacheResult status, const GameCacheRecord &record) {
        LcidResolution out{requested, 0, LcidPolicyError::None};
        if (!requested) { out.error = LcidPolicyError::NotAllowed; return out; }
        const bool known = status == GameCacheFound;
        if (requested == UINT64_MAX) {
            if (known && record.local_communication_ids[0] && record.local_communication_ids[0] != UINT64_MAX)
                out.canonical = record.local_communication_ids[0];
            if (self) {
                if (!out.canonical) out.error = LcidPolicyError::Unavailable;
                else out.wire = out.canonical;
            }
            return out;
        }
        if (known) {
            bool allowed = false;
            for (auto id : record.local_communication_ids) allowed |= id == requested;
            if (!allowed) { out.error = LcidPolicyError::NotAllowed; return out; }
        }
        // Horizon preserves explicit positive IDs when it cannot load NACP.
        out.canonical = requested;
        return out;
    }
}
