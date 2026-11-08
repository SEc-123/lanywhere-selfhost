#include "game_catalog.h"

#include <string.h>

enum { HeaderSize = 20, TitleSize = 16, AliasSize = 24 };

static uint32_t read32(const unsigned char *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

static uint64_t read64(const unsigned char *p)
{
    return read32(p) | ((uint64_t)read32(p + 4) << 32);
}

bool game_catalog_open(GameCatalog *catalog, const void *data, size_t size)
{
    if (!catalog) return false;
    *catalog = (GameCatalog){0};
    const unsigned char *p = data;
    if (!p || size < HeaderSize || memcmp(p, "LYCAT1\0\0", 8) != 0) return false;
    const size_t titles = read32(p + 8), aliases = read32(p + 12), text = read32(p + 16);
    const size_t remaining = size - HeaderSize;
    if (!titles || titles > remaining / TitleSize || aliases > (remaining - titles * TitleSize) / AliasSize ||
        !text || text != remaining - titles * TitleSize - aliases * AliasSize)
        return false;
    const unsigned char *alias_data = p + HeaderSize + titles * TitleSize;
    *catalog = (GameCatalog){p + HeaderSize, alias_data, alias_data + aliases * AliasSize, titles, aliases, text};
    return true;
}

static const unsigned char *find_id(const unsigned char *table, size_t count, size_t stride, uint64_t id)
{
    if (!id || id == UINT64_MAX) return NULL;
    size_t lo = 0, hi = count;
    while (lo < hi) {
        const size_t mid = lo + (hi - lo) / 2;
        const unsigned char *row = table + mid * stride;
        const uint64_t current = read64(row);
        if (current == id) return row;
        if (current < id) lo = mid + 1;
        else hi = mid;
    }
    return NULL;
}

static const char *title_text(const GameCatalog *catalog, uint32_t offset)
{
    if (offset >= catalog->text_size || catalog->text[offset] == 0) return NULL;
    const unsigned char *s = catalog->text + offset;
    return memchr(s, 0, catalog->text_size - offset) ? (const char *)s : NULL;
}

static CatalogMatch by_application(const GameCatalog *catalog, uint64_t id, CatalogKind kind)
{
    const unsigned char *row = find_id(catalog->titles, catalog->title_count, TitleSize, id);
    if (!row) return (CatalogMatch){0};
    const char *en = title_text(catalog, read32(row + 8)), *zh = title_text(catalog, read32(row + 12));
    return en || zh ? (CatalogMatch){id, en, zh, kind} : (CatalogMatch){0};
}

CatalogMatch game_catalog_identify(const GameCatalog *catalog, uint64_t host_app_id, uint64_t lcid)
{
    if (!catalog) return (CatalogMatch){0};
    CatalogMatch explicit_id = by_application(catalog, host_app_id, CatalogApplication);
    if (explicit_id.kind) return explicit_id;
    const unsigned char *alias = find_id(catalog->aliases, catalog->alias_count, AliasSize, lcid);
    if (alias) {
        const uint64_t app_id = read64(alias + 8);
        if (app_id) return by_application(catalog, app_id, CatalogCommunication);
        return (CatalogMatch){0, title_text(catalog, read32(alias + 16)), title_text(catalog, read32(alias + 20)), CatalogShared};
    }
    /* Equal 64-bit values are only a display clue; NACP can use a different or shared LCID. */
    return by_application(catalog, lcid, CatalogEqualId);
}

const char *game_catalog_name(const CatalogMatch *match, bool chinese)
{
    if (!match) return NULL;
    return chinese ? (match->zh ? match->zh : match->en) : (match->en ? match->en : match->zh);
}
