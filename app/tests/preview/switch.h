#pragma once
// Host-only shims for the actual gfx.c and guide.c renderer; never in app INCLUDES.
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
typedef uint8_t u8;
typedef uint16_t u16;
typedef uint32_t u32;
typedef uint64_t u64;
typedef int32_t s32;
typedef int Result;
#define R_FAILED(r) ((r) != 0)
#define R_SUCCEEDED(r) ((r) == 0)
enum { PIXEL_FORMAT_RGBA_8888 = 0, PlServiceType_User = 0 };
typedef enum {
    PlSharedFontType_Standard, PlSharedFontType_ChineseSimplified,
    PlSharedFontType_ExtChineseSimplified, PlSharedFontType_ChineseTraditional,
    PlSharedFontType_KO, PlSharedFontType_NintendoExt, PlSharedFontType_Total
} PlSharedFontType;
typedef struct { u32 type, offset, size; void *address; } PlFontData;
typedef struct { u32 *pixels; u32 width; } Framebuffer;
enum {
    HidNpadButton_A = 1u << 0, HidNpadButton_B = 1u << 1, HidNpadButton_X = 1u << 2,
    HidNpadButton_Y = 1u << 3, HidNpadButton_L = 1u << 6, HidNpadButton_R = 1u << 7,
    HidNpadButton_StickR = 1u << 5, HidNpadButton_StickL = 1u << 4,
    HidNpadButton_ZL = 1u << 8, HidNpadButton_ZR = 1u << 9,
    HidNpadButton_Plus = 1u << 10, HidNpadButton_Minus = 1u << 11
};
void *nwindowGetDefault(void);
Result framebufferCreate(Framebuffer *, void *, u32, u32, int, int);
Result framebufferMakeLinear(Framebuffer *);
void *framebufferBegin(Framebuffer *, u32 *);
void framebufferEnd(Framebuffer *);
void framebufferClose(Framebuffer *);
Result plInitialize(int);
void plExit(void);
Result plGetSharedFontByType(PlFontData *, PlSharedFontType);
