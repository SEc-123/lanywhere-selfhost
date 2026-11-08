#define _POSIX_C_SOURCE 200809L
#include "ui_locale.h"
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

enum { PathCapacity = 512, LocaleLimit = 64 };

static bool sibling(char *out, const char *path, const char *suffix)
{
    if (!path || !path[0]) return false;
    const int count = snprintf(out, PathCapacity, "%s%s", path, suffix);
    return count > 0 && count < PathCapacity;
}

static bool regular_file(const char *path)
{
    struct stat st;
    return stat(path, &st) == 0 && S_ISREG(st.st_mode);
}

bool ui_locale_load(const char *path)
{
    if (!path || !path[0]) return false;
    struct stat st;
    char previous[PathCapacity];
    const char *read_path = path;
    if (stat(path, &st) != 0) {
        if (errno != ENOENT || !sibling(previous, path, ".previous") || !regular_file(previous)) return false;
        // Horizon cannot overwrite a destination with rename. Recover the old
        // preference if interruption occurred between its two commit renames.
        if (rename(previous, path) != 0) read_path = previous;
        if (stat(read_path, &st) != 0) return false;
    }
    if (!S_ISREG(st.st_mode) || st.st_size < 0 || st.st_size >= LocaleLimit) return false;
    FILE *file = fopen(read_path, "rb");
    if (!file) return false;
    char text[LocaleLimit];
    const size_t length = fread(text, 1, sizeof(text), file);
    const bool valid = !ferror(file) && length < sizeof(text);
    const int closed = fclose(file);
    if (!valid || closed != 0 || memchr(text, '\0', length)) return false;
    size_t end = length;
    if (end && text[end - 1] == '\n') end--;
    if (end && text[end - 1] == '\r') end--;
    return end == strlen("language=zh") && memcmp(text, "language=zh", end) == 0;
}

bool ui_locale_save(const char *path, bool chinese)
{
    char temporary[PathCapacity], previous[PathCapacity];
    if (!sibling(temporary, path, ".tmp") || !sibling(previous, path, ".previous")) return false;
    // A prior interrupted commit may be the only intact preference. Restore it
    // before attempting a new write; do not discard recovery material on failure.
    struct stat st;
    if (stat(path, &st) != 0) {
        if (errno != ENOENT) return false;
        if (stat(previous, &st) == 0) {
            if (!S_ISREG(st.st_mode) || rename(previous, path) != 0) return false;
        } else if (errno != ENOENT) return false;
    } else if (!S_ISREG(st.st_mode)) return false;

    FILE *file = fopen(temporary, "wb");
    if (!file) return false;
    const char *value = chinese ? "language=zh\n" : "language=en\n";
    const size_t length = strlen(value);
    bool written = fwrite(value, 1, length, file) == length && fflush(file) == 0 && fsync(fileno(file)) == 0;
    if (fclose(file) != 0) written = false;
    if (written && rename(temporary, path) == 0) {
        if (regular_file(previous)) remove(previous);
        return true;
    }
    if (written && errno == EEXIST) {
        bool can_move = true;
        if (stat(previous, &st) == 0) can_move = S_ISREG(st.st_mode) && remove(previous) == 0;
        else if (errno != ENOENT) can_move = false;
        if (can_move && rename(path, previous) == 0) {
            if (rename(temporary, path) == 0) {
                remove(previous);
                return true;
            }
            // Keep .previous if even rollback is unavailable. load() can recover.
            rename(previous, path);
        }
    }
    remove(temporary);
    return false;
}
