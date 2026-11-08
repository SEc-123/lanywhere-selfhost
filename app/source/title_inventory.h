#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "../../common/game_identity_cache.h"

/* Caller has initialized NS; failure is non-fatal to gameplay. */
bool title_inventory_refresh(void);

/* Injectable backend for host tests. A failed read may retain its old record;
 * a successfully read title may legitimately have no LCID values. */
typedef enum { TitleLoadFailed = 0, TitleLoadFound = 1, TitleLoadSkip = 2 } TitleInventoryLoad;
typedef struct {
    void *context;
    bool (*list)(void *context, uint32_t offset, uint64_t *ids, size_t capacity, size_t *count);
    TitleInventoryLoad (*load)(void *context, uint64_t application_id, GameCacheRecord *record);
} TitleInventoryBackend;
bool title_inventory_refresh_at(const char *path, const TitleInventoryBackend *backend);
