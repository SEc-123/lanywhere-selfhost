#pragma once
#include <stdbool.h>
#include <switch.h>

enum { GuideAppointmentsPage = 3 };
int guide_page_count(void);
// Shared top-right language control. The caller handles StickR and persistence.
void guide_draw_language(bool chinese);
// Draw within the caller's gfx_begin()/gfx_end() frame. Spanish uses English.
void guide_draw(int page, bool chinese, bool spanish);
// Call on touch release. Navigation uses ZL/ZR/B; the language button uses StickR.
u64 guide_touch_action(int x, int y, int page);
