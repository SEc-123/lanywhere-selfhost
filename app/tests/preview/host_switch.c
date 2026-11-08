#include <stdio.h>
#include <stdlib.h>
#include "switch.h"

static PlFontData fonts[2];
void *nwindowGetDefault(void) { return NULL; }
Result framebufferCreate(Framebuffer *fb, void *window, u32 w, u32 h, int format, int buffers)
{
    (void)window; (void)format; (void)buffers;
    fb->pixels = calloc((size_t)w * h, sizeof(u32)); fb->width = w;
    return fb->pixels ? 0 : 1;
}
Result framebufferMakeLinear(Framebuffer *fb) { (void)fb; return 0; }
void *framebufferBegin(Framebuffer *fb, u32 *stride) { *stride = fb->width * sizeof(u32); return fb->pixels; }
void framebufferEnd(Framebuffer *fb) { (void)fb; }
void framebufferClose(Framebuffer *fb) { free(fb->pixels); fb->pixels = NULL; }
Result plInitialize(int service) { (void)service; return 0; }
void plExit(void)
{
    for (unsigned i = 0; i < 2; i++) { free(fonts[i].address); fonts[i] = (PlFontData){0}; }
}
Result plGetSharedFontByType(PlFontData *font, PlSharedFontType type)
{
    if (type == PlSharedFontType_NintendoExt) return 1;
    const unsigned index = type == PlSharedFontType_Standard ? 0 : 1;
    if (!fonts[index].address) {
        const char *path = getenv(index ? "GUIDE_FONT_CJK" : "GUIDE_FONT_LATIN");
        if (!path) path = index ? "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc" :
                                  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
        FILE *file = fopen(path, "rb");
        if (!file) { perror(path); return 1; }
        if (fseek(file, 0, SEEK_END)) { fclose(file); return 1; }
        long size = ftell(file);
        if (size <= 0 || size > 100 * 1024 * 1024 || fseek(file, 0, SEEK_SET)) { fclose(file); return 1; }
        void *data = malloc((size_t)size);
        if (!data || fread(data, 1, (size_t)size, file) != (size_t)size) { free(data); fclose(file); return 1; }
        fclose(file);
        fonts[index] = (PlFontData){ .address = data, .size = (u32)size };
    }
    *font = fonts[index]; font->type = type;
    return 0;
}
