/* Game password sharing in the LANywhere lobby. SPDX-License-Identifier: GPL-2.0-only */
#pragma once

#include <switch.h>
#include "lobby_model.h"

void room_password_init(UEvent *wake);
bool room_password_worker_exchange(Service *service);
bool room_password_tick(RoomPasswordView *view, LobbyRoomId target, bool known_locked, u64 now);
const char *room_password_edit(Service *service, const char room[8], bool supports_hidden, RoomPasswordEdit *edit);
const char *room_password_apply(Service *service, RoomPasswordEdit *edit, bool hidden);
const char *room_password_unlock(Service *service, RoomPasswordView *view);
