# Local game identity cache API

The two identifiers are different: an LDN local communication ID (LCID) is used for discovery/matching; an NS application ID identifies an installed title. The intercepted ldn:u caller's ProgramID is a third piece of information. Never assume an LCID is an NS application ID, or mask a ProgramID to manufacture an application ID.

## Writer

After **successful** `nsInitialize()`, the app may call `title_inventory_refresh()` from `app/source/title_inventory.h`. It returns `false` on enumeration, I/O, integrity or commit failure; callers must continue gameplay. It pages through NS application records and queries storage control data, decodes both normal and HOS 21+ compressed NACP names with the existing `nacp_titles`, stores up to eight NACP `local_communication_id` values and English/Chinese display names. No icon, account or gameplay data is stored. A failed individual NS read retains that application's previous validated record when available; a successfully read title with no LCIDs remains available for exact ProgramID lookup but cannot provide an LCID fallback. A failed enumeration or duplicate NS application ID leaves the prior committed cache usable.

The cache is separate from `config.ini`, at `sdmc:/lanywhere/game-titles.bin`. The writer creates and verifies a sibling `.tmp`, flushes it, retains the previous validated file as `.previous`, and renames in stages for Horizon filesystems that cannot overwrite an existing destination. If interrupted between renames, `.previous` remains usable. This is a best-effort local file update; actual Horizon rename/flush behavior and NS access must still be validated on the console.

## Reader

`GameIdentityCacheLookup(program_id, lcid, &out)` in `console/ldn_mitm/source/game_identity_cache.hpp` streams and validates the whole primary cache; when it is missing or invalid it tries `.previous`. It does **not** fall back to a stale prior generation when the current cache is valid but has no matching entry. It allocates no whole-file buffers and returns:

- `GameCacheFound`: `out.program_id` is the intercepted session value; `out.application_id`, `out.english`, and `out.chinese` come from the cache. An exact NS application ID equal to the trusted caller ProgramID wins even if the LCID array is empty; otherwise a single distinct LCID-to-application match is required.
- `GameCacheAmbiguous`: multiple distinct application IDs or conflicting names match and there is no unambiguous exact match; application ID and names remain empty.
- `GameCacheUnknown`: no matching LCID; application ID and names remain empty.
- `GameCacheInvalid`: neither file can be validated; application ID and names remain empty.

`GameIdentity` is 272 bytes in memory: two `uint64_t` IDs followed by `english[128]` and `chinese[128]`. Serialize integer fields as little-endian explicitly on the wire. Names are valid, bounded UTF-8 and are not necessarily full untruncated NACP strings. A missing preferred language falls back to an actual available NACP name.

## Storage format v1

All numeric fields are little-endian. The 64-byte header is `magic[8] = "LNYID01\0"`, `version:u32 = 1`, `header_size:u32 = 64`, `record_size:u32 = 328`, `count:u32` (maximum 4096), `generation:u64`, and `sha256[32]`. The digest covers header bytes 0–31 followed by every record. File size must equal `64 + count * 328`. Each record is `application_id:u64`, eight `lcid:u64` values, `english[128]` and `chinese[128]`; strings are NUL-terminated, zero-padded, nonempty and checked for valid UTF-8, forbidden controls and bidirectional formatting characters. An LCID of zero is an empty slot; records with no LCID are eligible only for exact ProgramID lookup.

SHA-256 detects accidental corruption. It is **not a MAC or signature**: an SD-card writer can fabricate records and recompute the digest, and room metadata supplied by another console is untrusted. A cache result must not itself authorize a launch or prove the host's actual game. Check any local installation separately and require the player's explicit action; retain an ID-based fallback when names are unavailable or ambiguous. Do not log names with account data, keys, or room secrets.

## Host checks

```sh
cc -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined -Iapp/source app/tests/title_inventory_test.c app/source/title_inventory.c app/source/nacp_titles.c -lz -o /tmp/title-inventory-test && /tmp/title-inventory-test
c++ -std=c++17 -Wall -Wextra -Werror -fsanitize=address,undefined -Iapp/tests/mock_horizon app/tests/game_identity_cache_fs_test.cpp -o /tmp/identity-cache-fs-test && /tmp/identity-cache-fs-test
```

The fixture exercises the same cache parsing/writer logic and the module's reader through a temporary host filesystem shim. It does not demonstrate Nintendo NS permissions, SD-card commit semantics, module behavior or a game session on real hardware.
