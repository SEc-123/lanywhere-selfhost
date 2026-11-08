#include "../../common/game_identity_text.h"
#include "../source/nacp_titles.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <zlib.h>

static unsigned char nacp[0x4000];
static unsigned char decoded[NACP_MAX_TITLES * NACP_TITLE_SIZE];
static unsigned char input[NACP_MAX_TITLES * NACP_TITLE_SIZE];

static void set_title(unsigned char *data, size_t index, const char *title)
{
    assert(strlen(title) < GAME_IDENTITY_NACP_NAME_SIZE);
    memcpy(data + index * NACP_TITLE_SIZE, title, strlen(title) + 1);
}

int main(void)
{
    GameIdentityNames names;
    set_title(nacp, 0, "Dying Light: Platinum Edition");
    set_title(nacp, 14, "消逝的光芒：白金版");
    int count = nacp_titles(nacp, sizeof(nacp), decoded);
    assert(count == 16 && game_identity_select_names(decoded, (size_t)count*NACP_TITLE_SIZE, count, &names));
    assert(strcmp(names.english, "Dying Light: Platinum Edition") == 0);
    assert(strcmp(names.chinese, "消逝的光芒：白金版") == 0);
    memset(nacp, 0, sizeof(nacp));
    set_title(nacp, 0, "Dying Light:\r\n\t Platinum Edition");
    set_title(nacp, 14, "消逝的光芒\n\t白金版");
    count = nacp_titles(nacp, sizeof(nacp), decoded);
    assert(count == 16 && game_identity_select_names(decoded, (size_t)count*NACP_TITLE_SIZE, count, &names));
    assert(strcmp(names.english, "Dying Light: Platinum Edition") == 0);
    assert(strcmp(names.chinese, "消逝的光芒 白金版") == 0);

    /* HOS 21+ NACP compressed titles: use the project's real DEFLATE decoder. */
    memset(nacp, 0, sizeof(nacp)); memset(input, 0, sizeof(input));
    set_title(input, 1, "Pokémon Violet");
    set_title(input, 14, "宝可梦 紫");
    z_stream stream = {0};
    assert(deflateInit2(&stream, Z_BEST_COMPRESSION, Z_DEFLATED, -15, 8, Z_DEFAULT_STRATEGY) == Z_OK);
    stream.next_in = input; stream.avail_in = sizeof(input);
    stream.next_out = nacp + 2; stream.avail_out = 16 * NACP_TITLE_SIZE - 2;
    assert(deflate(&stream, Z_FINISH) == Z_STREAM_END);
    size_t compressed = stream.total_out;
    assert(deflateEnd(&stream) == Z_OK && compressed > 0 && compressed <= 0xffff);
    nacp[0] = (unsigned char)compressed; nacp[1] = (unsigned char)(compressed >> 8);
    nacp[0x3215] = 1;
    count = nacp_titles(nacp, sizeof(nacp), decoded);
    assert(count == 32 && game_identity_select_names(decoded, (size_t)count*NACP_TITLE_SIZE, count, &names));
    assert(strcmp(names.english, "Pokémon Violet") == 0 && strcmp(names.chinese, "宝可梦 紫") == 0);

    /* Region fallback is a real NACP name, never a guessed ID or generic label. */
    memset(decoded, 0, sizeof(decoded)); set_title(decoded, 2, "日本語タイトル");
    assert(game_identity_select_names(decoded, 16*NACP_TITLE_SIZE, 16, &names));
    assert(strcmp(names.english, "日本語タイトル") == 0 && strcmp(names.chinese, "日本語タイトル") == 0);
    assert(!game_identity_select_names(decoded, 16*NACP_TITLE_SIZE - 1, 16, &names));
    assert(!game_identity_select_names(decoded, sizeof(decoded), 33, &names));

    char out[GAME_IDENTITY_TITLE_CAP];
    static const uint8_t bad_overlong[] = {0xc0,0x80};
    static const uint8_t bad_surrogate[] = {0xed,0xa0,0x80};
    static const uint8_t bad_bidi[] = {'A',0xe2,0x80,0xae,'B'};
    static const uint8_t bad_control[] = {'A','\n','B'};
    static const uint8_t bad_tab[] = {'A','\t','B'};
    assert(!game_identity_safe_title(bad_overlong, sizeof(bad_overlong), out, sizeof(out)));
    assert(!game_identity_safe_title(bad_surrogate, sizeof(bad_surrogate), out, sizeof(out)));
    assert(!game_identity_safe_title(bad_bidi, sizeof(bad_bidi), out, sizeof(out)));
    assert(!game_identity_safe_title(bad_control, sizeof(bad_control), out, sizeof(out)));
    assert(!game_identity_safe_title(bad_tab, sizeof(bad_tab), out, sizeof(out)));
    const char title[] = "  Pokémon™ Violet  ";
    assert(game_identity_safe_title((const uint8_t *)title, strlen(title), out, sizeof(out)));
    assert(strcmp(out, "Pokémon™ Violet") == 0);
    char inplace[] = "  Pokémon Violet  ";
    assert(game_identity_safe_title((const uint8_t *)inplace, strlen(inplace), inplace, sizeof(inplace)));
    assert(strcmp(inplace, "Pokémon Violet") == 0);
    const char chinese[] = "一二三四五";
    assert(game_identity_safe_title((const uint8_t *)chinese, strlen(chinese), out, 11));
    assert(strcmp(out, "一二三") == 0); /* never cut a UTF-8 character */
    unsigned char long_bad[200]; memset(long_bad, 'A', sizeof(long_bad)); long_bad[199] = 0xff;
    assert(!game_identity_safe_title(long_bad, sizeof(long_bad), out, sizeof(out))); /* validate after truncation */
    assert(!game_identity_safe_title((const uint8_t *)"   ", 3, out, sizeof(out)));
    out[0] = 'X';
    assert(!game_identity_safe_title(decoded, GAME_IDENTITY_NACP_NAME_SIZE + 1, out, sizeof(out)) && !out[0]);
    memset(decoded, 0, sizeof(decoded)); memset(decoded, 'A', GAME_IDENTITY_NACP_NAME_SIZE);
    assert(!game_identity_title_at(decoded, 1, 0, out)); /* no NUL in the 0x200-byte field */
    decoded[GAME_IDENTITY_NACP_NAME_SIZE - 1] = 0;
    assert(game_identity_title_at(decoded, 1, 0, out) && strlen(out) == GAME_IDENTITY_TITLE_CAP - 1);
    decoded[GAME_IDENTITY_NACP_NAME_SIZE - 2] = 0xc3; /* incomplete UTF-8 at the source boundary */
    assert(!game_identity_title_at(decoded, 1, 0, out));
    puts("Game identity: plain/compressed NACP, language fallback and UTF-8 safety passed");
}
