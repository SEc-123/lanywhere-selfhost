#pragma once
#include <stratosphere.hpp>
#include "../../../common/game_identity_cache.h"

namespace ams::mitm::lanywhere {
    /* Stream the current cache, falling back to the previous committed cache on
     * missing/corrupt primary. Returns Unknown/Ambiguous rather than guessing. */
    GameCacheResult GameIdentityCacheLookup(u64 program_id, u64 local_communication_id, GameIdentity *out);
    // Network policy uses only an exact trusted caller ID in the current fully
    // validated file. No LCID inference, ID masking or stale previous-file fallback.
    GameCacheResult GameIdentityCacheExactRecord(u64 program_id, GameCacheRecord *out);
    /* Header digest is a cheap change hint only; it is neither validated nor authenticated. */
    bool GameIdentityCacheFingerprint(u8 out[32]);
}
