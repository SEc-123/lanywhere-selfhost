#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct {
    const unsigned char *titles, *aliases, *text;
    size_t title_count, alias_count, text_size;
} GameCatalog;

typedef enum {
    CatalogNone, CatalogApplication, CatalogCommunication, CatalogShared, CatalogEqualId,
} CatalogKind;

typedef struct {
    uint64_t app_id;
    const char *en, *zh;
    CatalogKind kind;
} CatalogMatch;

bool game_catalog_open(GameCatalog *catalog, const void *data, size_t size);
CatalogMatch game_catalog_identify(const GameCatalog *catalog, uint64_t host_app_id, uint64_t lcid);
const char *game_catalog_name(const CatalogMatch *match, bool chinese);
