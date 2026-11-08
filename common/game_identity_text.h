#pragma once
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* Portable text handling only. Titles sent over the network are host-supplied,
 * not authentication, installation evidence, or permission to launch an app. */
#define GAME_IDENTITY_TITLE_CAP 128
#define GAME_IDENTITY_NACP_ENTRY_SIZE 0x300
#define GAME_IDENTITY_NACP_NAME_SIZE 0x200
#define GAME_IDENTITY_NACP_MAX_ENTRIES 32

typedef struct {
    char english[GAME_IDENTITY_TITLE_CAP];
    char chinese[GAME_IDENTITY_TITLE_CAP];
} GameIdentityNames;

/* Strictly validate a complete UTF-8 name and truncate only at codepoint
 * boundaries. Reject control/bidi characters rather than silently displaying
 * spoofed content. n excludes the terminator and can describe untrusted bytes. */
static inline bool game_identity_safe_title(const uint8_t *src, size_t n, char *out, size_t cap)
{
    if (!out || !cap) return false;
    if (!src || cap < 2 || n > GAME_IDENTITY_NACP_NAME_SIZE) return out[0] = '\0', false;
    char cleaned[GAME_IDENTITY_TITLE_CAP];
    if (cap > sizeof(cleaned)) cap = sizeof(cleaned);
    while (n && *src == ' ') { ++src; --n; }
    while (n && src[n - 1] == ' ') --n;
    if (!n) return out[0] = '\0', false;
    size_t written = 0;
    bool truncated = false;
    for (size_t i = 0; i < n;) {
        uint32_t cp;
        const uint8_t first = src[i];
        size_t width;
        if (first < 0x80) { cp = first; width = 1; }
        else if (first >= 0xc2 && first <= 0xdf) { cp = first & 0x1f; width = 2; }
        else if (first >= 0xe0 && first <= 0xef) { cp = first & 0x0f; width = 3; }
        else if (first >= 0xf0 && first <= 0xf4) { cp = first & 0x07; width = 4; }
        else return out[0] = '\0', false;
        if (width > n - i) return out[0] = '\0', false;
        for (size_t j = 1; j < width; ++j) {
            if ((src[i+j] & 0xc0) != 0x80) return out[0] = '\0', false;
            cp = (cp << 6) | (src[i+j] & 0x3f);
        }
        if ((width == 2 && cp < 0x80) || (width == 3 && cp < 0x800) ||
            (width == 4 && cp < 0x10000) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ||
            cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || cp == 0x061c || cp == 0x200b ||
            cp == 0x200e || cp == 0x200f || (cp >= 0x2028 && cp <= 0x202e) ||
            (cp >= 0x2066 && cp <= 0x206f) || cp == 0xfeff)
            return out[0] = '\0', false;
        if (!truncated && width <= cap - 1 - written) {
            memcpy(cleaned + written, src + i, width);
            written += width;
        } else truncated = true;
        i += width;
    }
    while (written && cleaned[written-1] == ' ') --written;
    cleaned[written] = '\0';
    memcpy(out, cleaned, written + 1);
    return written != 0;
}

static inline bool game_identity_title_at(const uint8_t *titles, size_t count, size_t index,
                                          char out[GAME_IDENTITY_TITLE_CAP])
{
    if (!out) return false;
    out[0] = '\0';
    if (!titles || index >= count) return false;
    const uint8_t *name = titles + index * GAME_IDENTITY_NACP_ENTRY_SIZE;
    size_t n = 0;
    while (n < GAME_IDENTITY_NACP_NAME_SIZE && name[n]) ++n;
    if (n == GAME_IDENTITY_NACP_NAME_SIZE) return false;
    /* NACP titles may intentionally wrap. Normalize only CR/LF/Tab and their
     * adjacent spaces here; network-supplied metadata remains strictly checked. */
    uint8_t normalized[GAME_IDENTITY_NACP_NAME_SIZE];
    size_t used = 0;
    for (size_t i = 0; i < n; ++i) {
        const uint8_t c = name[i];
        if (c == '\r' || c == '\n' || c == '\t') {
            if (used && normalized[used - 1] != ' ') normalized[used++] = ' ';
            while (i + 1 < n && (name[i+1] == '\r' || name[i+1] == '\n' ||
                                  name[i+1] == '\t' || name[i+1] == ' ')) ++i;
        } else normalized[used++] = c;
    }
    return game_identity_safe_title(normalized, used, out, GAME_IDENTITY_TITLE_CAP);
}

/* Input is a decoded NACP language-entry array (including HOS 21+ DEFLATE
 * output). The caller owns decoding and supplies its actual byte count. */
static inline bool game_identity_select_names(const uint8_t *titles, size_t bytes, size_t count,
                                               GameIdentityNames *out)
{
    if (!out) return false;
    memset(out, 0, sizeof(*out));
    if (!titles || !count || count > GAME_IDENTITY_NACP_MAX_ENTRIES ||
        bytes < count * GAME_IDENTITY_NACP_ENTRY_SIZE) return false;
    const size_t en[] = {0, 1}, zh[] = {14, 13};
    for (size_t i = 0; i < sizeof(en)/sizeof(en[0]) && !out->english[0]; ++i)
        game_identity_title_at(titles, count, en[i], out->english);
    for (size_t i = 0; i < sizeof(zh)/sizeof(zh[0]) && !out->chinese[0]; ++i)
        game_identity_title_at(titles, count, zh[i], out->chinese);
    char fallback[GAME_IDENTITY_TITLE_CAP] = {0};
    if (!out->english[0] || !out->chinese[0]) {
        for (size_t i = 0; i < count && !fallback[0]; ++i)
            game_identity_title_at(titles, count, i, fallback);
    }
    if (!out->english[0] && fallback[0]) memcpy(out->english, fallback, sizeof(out->english));
    if (!out->chinese[0] && fallback[0]) memcpy(out->chinese, fallback, sizeof(out->chinese));
    return out->english[0] && out->chinese[0];
}
