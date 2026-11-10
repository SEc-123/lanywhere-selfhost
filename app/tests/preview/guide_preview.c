#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "gfx.h"
#include "guide.h"

static unsigned failures, measured;
static void check_text(int x, int y, int size, const char *s)
{
    measured++;
    if (!gfx_text_has_glyphs(s) || x < 0 || x + gfx_text_width(size, s) > GFX_W - 48 ||
        y < 0 || y + size > GFX_H) {
        fprintf(stderr, "Missing glyph or text outside guide bounds: (%d,%d) %s\n", x, y, s);
        failures++;
    }
}
int preview_text(int x, int y, int size, u32 color, const char *s)
{
    check_text(x, y, size, s);
    return gfx_text(x, y, size, color, s);
}
int preview_button(int x, int y, const char *button, const char *label)
{
    int pill = gfx_text_width(18, button) + 14;
    if (pill < 30) pill = 30;
    check_text(x, y + 5, 18, button);
    check_text(x + pill + 10, y + 3, 22, label);
    return gfx_button(x, y, button, label);
}

int main(int argc, char **argv)
{
    if (argc != 2 && argc != 3) { fprintf(stderr, "Usage: guide-preview OUTPUT_DIRECTORY [GLYPH_INVENTORY]\n"); return 2; }
    if (!gfx_init()) { fprintf(stderr, "Cannot initialize host fonts/framebuffer\n"); return 1; }
    if (argc == 3) {
        FILE *file = fopen(argv[2], "rb");
        if (!file || fseek(file, 0, SEEK_END)) return 2;
        long size = ftell(file);
        if (size < 0 || size > 1024 * 1024 || fseek(file, 0, SEEK_SET)) return 2;
        char *inventory = calloc((size_t)size + 1, 1);
        if (!inventory || fread(inventory, 1, (size_t)size, file) != (size_t)size) return 2;
        fclose(file);
        if (!gfx_text_has_glyphs(inventory)) { fprintf(stderr, "Missing glyph in guide/ui_text inventory\n"); failures++; }
        free(inventory);
    }
    const int pages = guide_page_count();
    assert(pages == 6);
    for (int p = 0; p < pages; p++) {
        assert(guide_touch_action(60, 680, p) == (p ? HidNpadButton_ZL : 0));
        assert(guide_touch_action(900, 680, p) == (p + 1 < pages ? HidNpadButton_ZR : 0));
        assert(guide_touch_action(1120, 680, p) == HidNpadButton_B);
        assert(guide_touch_action(1120, 600, p) == 0);
        assert(guide_touch_action(1120, 62, p) == HidNpadButton_StickR);
        assert(guide_touch_action(1055, 62, p) == 0);
        assert(guide_touch_action(1224, 62, p) == 0);
        assert(guide_touch_action(1120, 84, p) == 0);
        for (int chinese = 0; chinese < 2; chinese++) {
            char path[1024];
            snprintf(path, sizeof(path), "%s/guide-%s-%d.png", argv[1], chinese ? "zh" : "en", p + 1);
            gfx_begin();
            guide_draw(p, chinese != 0, false);
            if (!gfx_save_png(path)) { perror(path); failures++; }
            gfx_end();
        }
    }
    // Spanish intentionally falls back to the English guide.
    gfx_begin(); guide_draw(0, false, true); gfx_end();
    gfx_exit();
    printf("Host guide: %u text checks, %u failures, %d rendered pages; not a Switch hardware capture.\n",
           measured, failures, 2 * pages);
    return failures ? 1 : 0;
}
