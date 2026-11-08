#pragma once
#include <stdbool.h>

#define UI_LOCALE_PATH "sdmc:/lanywhere/language.ini"

// False means English, including missing, unreadable or invalid preferences.
bool ui_locale_load(const char *path);
// The caller creates the parent directory. Never writes the relay's config.ini.
bool ui_locale_save(const char *path, bool chinese);
