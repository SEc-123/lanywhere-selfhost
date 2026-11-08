#pragma once
#include <stdbool.h>

const char *ui_text(const char *english);
void ui_set_language(bool chinese, bool spanish);
bool ui_chinese(void);
bool ui_spanish(void);
const char *ui_tr(const char *spanish, const char *english);
