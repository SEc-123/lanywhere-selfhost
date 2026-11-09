/* Game password sharing in the LANywhere lobby. SPDX-License-Identifier: GPL-2.0-only */
#include "room_password.h"
#include "ui_text.h"
#include <string.h>

#define PASSWORD_REFRESH_MS 5000

static Mutex g_lock;
static UEvent *g_wake;
static unsigned g_generation;
static bool g_queued, g_ready;
static RoomPasscodeLookup g_lookup;
static RoomPasscodeReply g_reply;

void room_password_init(UEvent *wake)
{
    g_wake = wake;
    mutexInit(&g_lock);
}

bool room_password_worker_exchange(Service *service)
{
    mutexLock(&g_lock);
    if (!g_queued) {
        mutexUnlock(&g_lock);
        return false;
    }
    const RoomPasscodeLookup lookup = g_lookup;
    const unsigned generation = g_generation;
    g_queued = false;
    mutexUnlock(&g_lock);

    RoomPasscodeReply reply = {.status = RoomPasscodeUnavailable};
    if (R_FAILED(serviceDispatchInOut(service, ROOM_PASSCODE_IPC_GET, lookup, reply)))
        reply = (RoomPasscodeReply){.status = RoomPasscodeUnavailable};

    mutexLock(&g_lock);
    if (generation == g_generation) {
        g_reply = reply;
        g_ready = true;
    }
    mutexUnlock(&g_lock);
    return true;
}

static bool valid_password(const char *password, size_t length)
{
    if (length > ROOM_PASSCODE_MAX) return false;
    for (size_t i = 0; i < length; ++i)
        if ((unsigned char)password[i] < 0x20 || (unsigned char)password[i] > 0x7e) return false;
    return true;
}

static bool readable_reply(const RoomPasscodeReply *reply)
{
    if ((reply->status != RoomPasscodeOk && reply->status != RoomPasscodeLocked) ||
        (reply->status == RoomPasscodeLocked && reply->length) ||
        reply->reserved[0] || reply->reserved[1] || reply->reserved[2] ||
        !valid_password(reply->passcode, reply->length))
        return false;
    for (size_t i = reply->length; i < ROOM_PASSCODE_MAX; ++i)
        if (reply->passcode[i]) return false;
    return true;
}

bool room_password_tick(RoomPasswordView *view, LobbyRoomId target, bool known_locked, u64 now)
{
    if (!target.game_id && !view->room.game_id) return false;
    const bool changed = !lobby_room_equal(view->room, target);
    bool dirty = changed, wake = false;
    mutexLock(&g_lock);
    if (changed) {
        *view = (RoomPasswordView){.room = target, .locked = target.game_id && known_locked};
        ++g_generation;
        g_queued = g_ready = false;
        g_reply = (RoomPasscodeReply){0};
    }
    if (g_ready) {
        view->failed = !readable_reply(&g_reply);
        memset(view->value, 0, sizeof(view->value));
        if (!view->failed) {
            const bool locked = g_reply.status == RoomPasscodeLocked;
            if (locked != view->locked) view->unlocked = false;
            view->locked = locked;
            memcpy(view->value, g_reply.passcode, g_reply.length);
        }
        g_reply = (RoomPasscodeReply){0};
        g_ready = view->pending = false;
        view->refresh_at = now + PASSWORD_REFRESH_MS;
        dirty = true;
    }
    if (target.game_id && !view->pending && now >= view->refresh_at) {
        g_lookup = (RoomPasscodeLookup){.game_id = target.game_id};
        memcpy(g_lookup.room, target.code, sizeof(g_lookup.room));
        g_queued = view->pending = true;
        wake = dirty = true;
    }
    mutexUnlock(&g_lock);
    if (wake) ueventSignal(g_wake);
    return dirty;
}

static bool ask_password(char password[ROOM_PASSCODE_MAX + 1], const char *header, const char *hint)
{
    SwkbdConfig keyboard;
    if (R_FAILED(swkbdCreate(&keyboard, 0))) return false;
    swkbdConfigMakePresetPassword(&keyboard);
    swkbdConfigSetHeaderText(&keyboard, header);
    swkbdConfigSetSubText(&keyboard, hint);
    swkbdConfigSetStringLenMax(&keyboard, ROOM_PASSCODE_MAX);
    const Result input = swkbdShow(&keyboard, password, ROOM_PASSCODE_MAX + 1);
    swkbdClose(&keyboard);
    return R_SUCCEEDED(input);
}

static size_t password_length(const char password[ROOM_PASSCODE_MAX + 1])
{
    const char *end = memchr(password, '\0', ROOM_PASSCODE_MAX + 1);
    return end ? (size_t)(end - password) : ROOM_PASSCODE_MAX + 1;
}

const char *room_password_apply(Service *service, RoomPasswordEdit *edit, bool hidden)
{
    if (!edit->active) return NULL;
    const RoomAccessChange access = {.change = edit->change, .hidden = hidden};
    *edit = (RoomPasswordEdit){0};
    u32 status = RoomPasscodeUnavailable;
    if (R_FAILED(serviceDispatchInOut(service, ROOM_ACCESS_IPC_SET, access, status)) ||
        status != RoomPasscodeOk)
        return ui_text("Could not update the game password.");
    if (!access.change.passcode[0]) return ui_text("Game password cleared.");
    return hidden ? ui_text("Game password hidden.") : ui_text("Game password shared.");
}

const char *room_password_edit(Service *service, const char room[8], bool supports_hidden, RoomPasswordEdit *edit)
{
    *edit = (RoomPasswordEdit){0};
    RoomPasscodeHost host = {.status = RoomPasscodeUnavailable};
    if (R_FAILED(serviceDispatchOut(service, ROOM_PASSCODE_IPC_HOST, host)) ||
        host.status != RoomPasscodeOk || host.reserved || memcmp(host.room, room, sizeof(host.room)) != 0)
        return ui_text("Open a game room first.");

    char password[ROOM_PASSCODE_MAX + 1] = {0};
    const char *hint = supports_hidden ? ui_text("Enter the game password. Leave blank to clear.") :
                                        ui_text("Visible to everyone. Leave blank to clear.");
    if (!ask_password(password, ui_text("Edit game password"), hint)) return NULL;
    const size_t length = password_length(password);
    if (!valid_password(password, length)) return ui_text("Use up to 24 letters, numbers or symbols.");

    RoomPasscodeChange change = {0};
    memcpy(change.room, host.room, sizeof(change.room));
    memcpy(change.passcode, password, length);
    if (supports_hidden) {
        *edit = (RoomPasswordEdit){.change = change, .active = true};
        return length ? NULL : room_password_apply(service, edit, false);
    }

    u32 status = RoomPasscodeUnavailable;
    if (R_FAILED(serviceDispatchInOut(service, ROOM_PASSCODE_IPC_SET, change, status)) ||
        status != RoomPasscodeOk)
        return ui_text("Could not update the game password.");
    return length ? ui_text("Game password shared.") : ui_text("Game password cleared.");
}

const char *room_password_unlock(Service *service, RoomPasswordView *view)
{
    if (!view->locked || view->pending || !view->room.game_id) return NULL;
    char password[ROOM_PASSCODE_MAX + 1] = {0};
    if (!ask_password(password, ui_text("Enter game password"), ui_text("Ask the host for the password.")))
        return NULL;
    const size_t length = password_length(password);
    if (!length) return ui_text("Enter the room password.");
    if (!valid_password(password, length)) return ui_text("Use up to 24 letters, numbers or symbols.");

    RoomAccessUnlock unlock = {.game_id = view->room.game_id};
    memcpy(unlock.room, view->room.code, sizeof(unlock.room));
    memcpy(unlock.passcode, password, length);
    u32 status = RoomPasscodeUnavailable;
    view->unlocked = false;
    if (R_FAILED(serviceDispatchInOut(service, ROOM_ACCESS_IPC_UNLOCK, unlock, status)))
        return ui_text("Could not check the password. Try again.");
    if (status == RoomPasscodeWrong) return ui_text("Wrong game password. Try again.");
    if (status == RoomPasscodeRoomUnavailable) return ui_text("This game room is no longer available.");
    if (status != RoomPasscodeOk) return ui_text("Could not check the password. Try again.");
    view->unlocked = true;
    return ui_text("Room unlocked.");
}
