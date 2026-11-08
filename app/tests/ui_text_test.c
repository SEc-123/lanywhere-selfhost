#include <assert.h>
#include <stdio.h>
#include <string.h>
/* Include the implementation to verify every dictionary entry, including future additions. */
#include "../source/ui_text.c"

static const char *next_format(const char *p, char *out, size_t cap)
{
    for (;;) {
        p = strchr(p, '%');
        if (!p) return NULL;
        if (p[1] == '%') { p += 2; continue; }
        break;
    }
    const char *begin = p++;
    while (*p && strchr("-+ #0'", *p)) p++;
    while (*p && ((*p >= '0' && *p <= '9') || *p == '.' || *p == '*')) p++;
    while (*p && strchr("hljztL", *p)) p++;
    assert(*p && strchr("diouxXfFeEgGaAcspn", *p));
    p++;
    size_t n = (size_t)(p - begin);
    assert(n < cap);
    memcpy(out, begin, n); out[n] = '\0';
    return p;
}

static void assert_formats_equal(const char *en, const char *zh)
{
    char a[64], b[64];
    for (;;) {
        const char *next_en = next_format(en, a, sizeof(a));
        const char *next_zh = next_format(zh, b, sizeof(b));
        assert((next_en == NULL) == (next_zh == NULL));
        if (!next_en) return;
        assert(strcmp(a, b) == 0);
        en = next_en; zh = next_zh;
    }
}

int main(void)
{
    assert(!ui_chinese() && !ui_spanish());
    assert(strcmp(ui_tr("Hola", "Hello"), "Hello") == 0);
    ui_set_language(false, true);
    assert(ui_spanish() && !ui_chinese());
    assert(strcmp(ui_tr("Hola", "Hello"), "Hola") == 0);
    ui_set_language(true, true);
    assert(ui_chinese() && !ui_spanish());
    assert(strcmp(ui_tr("Amigos", "Friends room"), "好友私房") == 0);
    assert(strcmp(ui_text("Public rooms"), "公开房间") == 0);
    assert(strcmp(ui_text("Some players cannot receive this game datagram."), "部分玩家无法接收游戏数据。") == 0);
    assert(strcmp(ui_text("Invalid server or network settings"), "服务器或网络设置无效") == 0);
    const char *unknown = "new untranslated text";
    assert(ui_text(unknown) == unknown && ui_text(NULL) == NULL);
    for (size_t i = 0; i < sizeof(translations) / sizeof(translations[0]); ++i) {
        assert(translations[i].en[0] && translations[i].zh[0]);
        assert(strcmp(ui_text(translations[i].en), translations[i].zh) == 0);
        assert_formats_equal(translations[i].en, translations[i].zh);
        for (size_t j = 0; j < i; ++j) assert(strcmp(translations[i].en, translations[j].en) != 0);
    }
    char formatted[128];
    snprintf(formatted, sizeof(formatted), ui_text("Joined %s. Open the game."), "ABC123");
    assert(strcmp(formatted, "已加入 ABC123，请打开游戏。") == 0);
    ui_set_language(false, false);
    assert(strcmp(ui_text("Friends room"), "Friends room") == 0);
    puts("UI translation, fallback and format tests passed");
    return 0;
}
