#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

enum { Normal, RenameFailure, Horizon, CommitFailure, RollbackFailure };
static int rename_mode, commit_attempts;
static bool sync_failure;

static int checked_rename(const char *old_path, const char *new_path)
{
    if (rename_mode == RenameFailure) { errno = EIO; return -1; }
    if (rename_mode >= Horizon && access(new_path, F_OK) == 0) { errno = EEXIST; return -1; }
    if (rename_mode >= CommitFailure && strstr(old_path, ".tmp") && ++commit_attempts == 1) {
        errno = EIO; return -1;
    }
    if (rename_mode == RollbackFailure && strstr(old_path, ".previous")) { errno = EIO; return -1; }
    return rename(old_path, new_path);
}
static int checked_fsync(int fd)
{
    if (sync_failure) { errno = EIO; return -1; }
    return fsync(fd);
}
#define rename checked_rename
#define fsync checked_fsync
#include "../source/ui_locale.c"
#undef rename
#undef fsync

static void write_text(const char *path, const char *text)
{
    FILE *file = fopen(path, "wb"); assert(file);
    assert(fputs(text, file) >= 0); assert(fclose(file) == 0);
}
static void contents(const char *path, const char *want)
{
    FILE *file = fopen(path, "rb"); assert(file);
    char text[256]; size_t n = fread(text, 1, sizeof(text), file);
    assert(!ferror(file)); assert(fclose(file) == 0);
    assert(n == strlen(want) && memcmp(text, want, n) == 0);
}
int main(void)
{
    char directory[] = "/tmp/lanywhere-locale-XXXXXX";
    assert(mkdtemp(directory));
    char path[128], previous[160], temporary[160], config[128];
    snprintf(path, sizeof(path), "%s/language.ini", directory);
    snprintf(previous, sizeof(previous), "%s.previous", path);
    snprintf(temporary, sizeof(temporary), "%s.tmp", path);
    snprintf(config, sizeof(config), "%s/config.ini", directory);
    write_text(config, "public=0\napodo=Keep Me\nserver=203.0.113.7\n");
    assert(!ui_locale_load(path) && !ui_locale_load(NULL) && !ui_locale_load(""));
    assert(ui_locale_save(path, true) && ui_locale_load(path));
    contents(path, "language=zh\n");
    assert(ui_locale_save(path, false) && !ui_locale_load(path));
    contents(path, "language=en\n");
    write_text(path, "language=zh\r\n"); assert(ui_locale_load(path));
    write_text(path, "language=zh"); assert(ui_locale_load(path));
    const char *invalid[] = { "", "language=es\n", "language=ZH\n", "zh\n", "language=zh\nlanguage=en\n", "language=zh\nextra=1\n" };
    for (unsigned i = 0; i < sizeof(invalid) / sizeof(invalid[0]); i++) {
        write_text(path, invalid[i]); assert(!ui_locale_load(path));
    }
    char oversized[80]; memset(oversized, 'z', sizeof(oversized) - 1); oversized[sizeof(oversized) - 1] = 0;
    write_text(path, oversized); assert(!ui_locale_load(path));
    assert(!ui_locale_save(directory, true)); // Never replace a directory.
    assert(ui_locale_save(path, true));
    sync_failure = true; assert(!ui_locale_save(path, false)); sync_failure = false;
    contents(path, "language=zh\n"); assert(access(temporary, F_OK) != 0);
    rename_mode = RenameFailure; assert(!ui_locale_save(path, false)); rename_mode = Normal;
    contents(path, "language=zh\n"); assert(access(temporary, F_OK) != 0);
    for (int mode = CommitFailure; mode <= RollbackFailure; mode++) {
        rename_mode = mode; commit_attempts = 0; assert(!ui_locale_save(path, false)); rename_mode = Normal;
        assert(ui_locale_load(path)); contents(path, "language=zh\n");
        assert(access(previous, F_OK) != 0 && access(temporary, F_OK) != 0);
    }
    rename_mode = Horizon; assert(ui_locale_save(path, false)); assert(ui_locale_save(path, true)); rename_mode = Normal;
    assert(ui_locale_load(path)); assert(access(previous, F_OK) != 0);
    assert(rename(path, previous) == 0); assert(ui_locale_load(path)); // Interrupted Horizon commit.
    assert(access(previous, F_OK) != 0);
    assert(mkdir(temporary, 0700) == 0); assert(!ui_locale_save(path, false));
    contents(path, "language=zh\n"); assert(rmdir(temporary) == 0);
    contents(config, "public=0\napodo=Keep Me\nserver=203.0.113.7\n");
    assert(remove(config) == 0 && remove(path) == 0 && rmdir(directory) == 0);
    puts("UI locale: English defaults, round trips, invalid input, write/rename rollback and relay-config isolation passed");
    return 0;
}
