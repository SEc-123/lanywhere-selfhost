#include "room_password.h"
#include "ui_text.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>

static Service g_service;
static unsigned reads, writes, unlocks, keyboard_opened, keyboard_closed;
static RoomPasswordView guest;
static const LobbyRoomId first = {.code = "ABCD23", .game_id = 1};
static const LobbyRoomId second = {.code = "ABCD23", .game_id = 2};
static RoomPasscodeLookup last_lookup;
static RoomPasscodeReply next_reply;
static RoomPasscodeChange last_write;
static RoomAccessChange last_access;
static RoomAccessUnlock last_unlock;
static const char *keyboard_header = "Edit game password";
static const char *keyboard_hint = "Visible to everyone. Leave blank to clear.";
static RoomPasscodeHost host = {.status = RoomPasscodeOk, .room = "ABCD23"};
static const char *keyboard_text = "";
static bool change_room_during_request, cancel_keyboard;
static u32 write_status, unlock_status;

void mutexInit(Mutex *lock) { lock->locked = false; }
void mutexLock(Mutex *lock) { assert(!lock->locked); lock->locked = true; }
void mutexUnlock(Mutex *lock) { assert(lock->locked); lock->locked = false; }
void ueventSignal(UEvent *wake) { ++wake->signals; }

Result mock_password_dispatch(Service *service, unsigned command, const void *input, size_t in_size,
                              void *output, size_t out_size)
{
    assert(service == &g_service);
    switch (command) {
    case ROOM_PASSCODE_IPC_GET:
        assert(in_size == sizeof(last_lookup) && out_size == sizeof(next_reply));
        memcpy(&last_lookup, input, in_size);
        memcpy(output, &next_reply, out_size);
        ++reads;
        if (change_room_during_request) assert(room_password_tick(&guest, second, false, 30000));
        return 0;
    case ROOM_PASSCODE_IPC_HOST:
        assert(!input && !in_size && out_size == sizeof(host));
        memcpy(output, &host, out_size);
        return 0;
    case ROOM_PASSCODE_IPC_SET:
        assert(in_size == sizeof(last_write) && out_size == sizeof(write_status));
        memcpy(&last_write, input, in_size);
        memcpy(output, &write_status, out_size);
        ++writes;
        return 0;
    case ROOM_ACCESS_IPC_SET:
        assert(in_size == sizeof(last_access) && out_size == sizeof(write_status));
        memcpy(&last_access, input, in_size);
        memcpy(output, &write_status, out_size);
        ++writes;
        return 0;
    case ROOM_ACCESS_IPC_UNLOCK:
        assert(in_size == sizeof(last_unlock) && out_size == sizeof(unlock_status));
        memcpy(&last_unlock, input, in_size);
        memcpy(output, &unlock_status, out_size);
        ++unlocks;
        return 0;
    default:
        assert(false);
        return 1;
    }
}

Result swkbdCreate(SwkbdConfig *keyboard, int flags)
{
    assert(!flags);
    *keyboard = (SwkbdConfig){0};
    ++keyboard_opened;
    return 0;
}
void swkbdConfigMakePresetPassword(SwkbdConfig *keyboard) { (void)keyboard; }
void swkbdConfigSetHeaderText(SwkbdConfig *keyboard, const char *header) { keyboard->header = header; }
void swkbdConfigSetSubText(SwkbdConfig *keyboard, const char *subtext) { keyboard->subtext = subtext; }
void swkbdConfigSetStringLenMax(SwkbdConfig *keyboard, unsigned limit) { keyboard->limit = limit; }
Result swkbdShow(SwkbdConfig *keyboard, char *out, size_t size)
{
    assert(keyboard->limit == ROOM_PASSCODE_MAX && size == ROOM_PASSCODE_MAX + 1);
    assert(!strcmp(keyboard->header, ui_text(keyboard_header)));
    assert(!strcmp(keyboard->subtext, ui_text(keyboard_hint)));
    snprintf(out, size, "%s", keyboard_text);
    return cancel_keyboard;
}
void swkbdClose(SwkbdConfig *keyboard) { (void)keyboard; ++keyboard_closed; }

int main(void)
{
    UEvent wake = {0};
    room_password_init(&wake);
    assert(!room_password_tick(&guest, (LobbyRoomId){0}, false, 0));
    assert(room_password_tick(&guest, first, false, 0) && guest.pending && wake.signals == 1);
    assert(room_password_worker_exchange(&g_service));
    assert(reads == 1 && last_lookup.game_id == first.game_id && !memcmp(last_lookup.room, first.code, 8));
    assert(room_password_tick(&guest, first, false, 100) && !guest.pending && !guest.failed && !guest.value[0]);
    assert(!room_password_tick(&guest, first, false, 5099));
    assert(room_password_tick(&guest, first, false, 5100) && guest.pending);

    next_reply = (RoomPasscodeReply){.length = 6, .passcode = "00aZ !"};
    assert(room_password_worker_exchange(&g_service));
    assert(room_password_tick(&guest, first, false, 5200) && !strcmp(guest.value, "00aZ !"));
    assert(room_password_tick(&guest, first, false, 10200) && guest.pending && !strcmp(guest.value, "00aZ !"));
    next_reply = (RoomPasscodeReply){.length = ROOM_PASSCODE_MAX};
    memcpy(next_reply.passcode, "0123456789ABCDEFGHIJKLMN", ROOM_PASSCODE_MAX);
    assert(room_password_worker_exchange(&g_service));
    assert(room_password_tick(&guest, first, false, 10300) && strlen(guest.value) == 24);
    assert(room_password_tick(&guest, first, false, 15300) && guest.pending);
    next_reply.passcode[0] = '\n';
    assert(room_password_worker_exchange(&g_service));
    assert(room_password_tick(&guest, first, false, 15400) && guest.failed && !guest.value[0]);
    assert(room_password_tick(&guest, first, false, 20400) && guest.pending);
    next_reply = (RoomPasscodeReply){.length = 2, .passcode = "12x"};
    assert(room_password_worker_exchange(&g_service));
    assert(room_password_tick(&guest, first, false, 20500) && guest.failed && !guest.value[0]);

    assert(room_password_tick(&guest, first, false, 25500) && guest.pending);
    next_reply = (RoomPasscodeReply){.length = 3, .passcode = "old"};
    change_room_during_request = true;
    assert(room_password_worker_exchange(&g_service));
    change_room_during_request = false;
    assert(guest.room.game_id == second.game_id && guest.pending && !guest.value[0]);
    assert(!room_password_tick(&guest, second, false, 30010));
    next_reply = (RoomPasscodeReply){.length = 3, .passcode = "new"};
    assert(room_password_worker_exchange(&g_service) && last_lookup.game_id == second.game_id);
    assert(room_password_tick(&guest, second, false, 30020) && !strcmp(guest.value, "new"));
    assert(room_password_tick(&guest, (LobbyRoomId){0}, false, 30030) && !guest.value[0]);
    assert(!room_password_worker_exchange(&g_service));

    // A hidden row is protected before the asynchronous lookup completes.
    assert(room_password_tick(&guest, first, true, 30100) && guest.locked && guest.pending);
    assert(!room_password_unlock(&g_service, &guest) && unlocks == 0);
    next_reply = (RoomPasscodeReply){.status = RoomPasscodeLocked};
    assert(room_password_worker_exchange(&g_service));
    assert(room_password_tick(&guest, first, true, 30120));
    assert(guest.locked && !guest.pending && !guest.value[0] && !guest.failed && !guest.unlocked);

    ui_set_language(false, false);
    keyboard_header = "Enter game password";
    keyboard_hint = "Ask the host for the password.";
    keyboard_text = "00aZ !";
    unlock_status = RoomPasscodeWrong;
    assert(!strcmp(room_password_unlock(&g_service, &guest), "Wrong game password. Try again."));
    assert(unlocks == 1 && !guest.unlocked && !guest.value[0]);
    assert(last_unlock.game_id == first.game_id && !memcmp(last_unlock.room, first.code, 8));
    assert(!strcmp(last_unlock.passcode, "00aZ !"));
    unlock_status = RoomPasscodeOk;
    assert(!strcmp(room_password_unlock(&g_service, &guest), "Room unlocked."));
    assert(unlocks == 2 && guest.unlocked && !guest.value[0]);
    assert(room_password_tick(&guest, first, true, 35120) && guest.pending);
    assert(room_password_worker_exchange(&g_service));
    assert(room_password_tick(&guest, first, true, 35140) && guest.unlocked && !guest.value[0]);
    next_reply = (RoomPasscodeReply){.status = RoomPasscodeLocked, .length = 1, .passcode = "x"};
    assert(room_password_tick(&guest, first, true, 40140) && room_password_worker_exchange(&g_service));
    assert(room_password_tick(&guest, first, true, 40160) && guest.failed && !guest.value[0]);
    assert(room_password_tick(&guest, second, false, 40180) && !guest.unlocked && !guest.locked && !guest.value[0]);

    RoomPasswordEdit edit = {0};
    const char wrong_room[8] = "ZZZZZZ";
    const unsigned previous_keyboards = keyboard_opened;
    assert(!strcmp(room_password_edit(&g_service, wrong_room, false, &edit), "Open a game room first."));
    assert(keyboard_opened == previous_keyboards && !writes);
    keyboard_header = "Edit game password";
    keyboard_hint = "Visible to everyone. Leave blank to clear.";
    assert(!strcmp(room_password_edit(&g_service, first.code, false, &edit), "Game password shared."));
    assert(writes == 1 && !edit.active && !memcmp(last_write.room, first.code, 8) &&
           !strcmp(last_write.passcode, "00aZ !"));
    cancel_keyboard = true;
    assert(!room_password_edit(&g_service, first.code, false, &edit) && writes == 1);
    cancel_keyboard = false;
    keyboard_text = "中文";
    assert(!strcmp(room_password_edit(&g_service, first.code, false, &edit), "Use up to 24 letters, numbers or symbols."));
    assert(writes == 1);

    keyboard_hint = "Enter the game password. Leave blank to clear.";
    keyboard_text = "New04";
    assert(!room_password_edit(&g_service, first.code, true, &edit) && edit.active && writes == 1);
    assert(!strcmp(room_password_apply(&g_service, &edit, true), "Game password hidden."));
    assert(!edit.active && writes == 2 && last_access.hidden == 1 && !last_access.reserved &&
           !memcmp(last_access.change.room, first.code, 8) && !strcmp(last_access.change.passcode, "New04"));
    assert(!room_password_edit(&g_service, first.code, true, &edit) && edit.active && writes == 2);
    assert(!strcmp(room_password_apply(&g_service, &edit, false), "Game password shared."));
    assert(!edit.active && writes == 3 && !last_access.hidden);

    ui_set_language(true, false);
    keyboard_text = "";
    assert(!strcmp(room_password_edit(&g_service, first.code, true, &edit), "已清除游戏密码。"));
    assert(!edit.active && writes == 4 && !last_access.change.passcode[0] && !last_access.hidden);
    write_status = RoomPasscodeRoomUnavailable;
    assert(!strcmp(room_password_edit(&g_service, first.code, true, &edit), "无法更新游戏密码。"));
    assert(!edit.active && writes == 5 && keyboard_opened == keyboard_closed);
    puts("Room password app IPC: hidden/shared/clear, owner check, unlock and wrong code, stale reply, exact text, and EN/ZH passed.");
}
