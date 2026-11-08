/* Modified by LANywhere Self-host, 2026-11-07 to 2026-11-08. */
// Dibujo sencillo sobre el framebuffer de libnx (1280x720 RGBA) con la fuente del sistema (pl + FreeType).
#pragma once
#include <stdbool.h>
#include <switch.h>

#define GFX_W 1280
#define GFX_H 720

// Colores 0xAARRGGBB.
#define RGBA(r, g, b, a) ((u32)(a) << 24 | (u32)(r) << 16 | (u32)(g) << 8 | (u32)(b))

typedef struct {
    int w, h;
    u32 *px;  // 0xAARRGGBB
} Image;

bool gfx_init(void);
void gfx_exit(void);

void gfx_begin(void);  // empieza un fotograma
void gfx_end(void);    // lo muestra
// Guarda el fotograma en curso (entre gfx_begin y gfx_end) como PNG.
bool gfx_save_png(const char *path);

void gfx_clear_gradient(u32 top, u32 bottom);
void gfx_rect(int x, int y, int w, int h, u32 color);  // con mezcla alfa
void gfx_round_rect(int x, int y, int w, int h, int radius, u32 color);
void gfx_image(const Image *img, int x, int y, int w, int h);  // escalado al tamaño pedido

// UTF-8 with system Standard, Chinese and Nintendo glyph fallback. y is the text top.
int gfx_text(int x, int y, int size, u32 color, const char *utf8);
int gfx_text_width(int size, const char *utf8);
bool gfx_text_has_glyphs(const char *utf8);
// Recorta con "..." para que quepa en max_w.
void gfx_text_fit(int x, int y, int size, u32 color, const char *utf8, int max_w);

// Botón del mando (círculo con la letra) seguido de su acción; devuelve el ancho total.
int gfx_button(int x, int y, const char *button, const char *label);
