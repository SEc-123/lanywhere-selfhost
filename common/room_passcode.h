/* Game room password visibility and access. SPDX-License-Identifier: GPL-2.0-only */
#ifndef LANYWHERE_ROOM_PASSCODE_H
#define LANYWHERE_ROOM_PASSCODE_H

#include <stddef.h>
#include <stdint.h>

#define ROOM_PASSCODE_MAX 24
#define ROOM_PASSCODE_CAPABILITY 512u
#define ROOM_ACCESS_CAPABILITY 1024u
#define ROOM_ACCESS_GRANT_SIZE 16
#define ROOM_PASSCODE_REQUEST_TYPE 0x27
#define ROOM_PASSCODE_RESPONSE_TYPE 0xa7
#define ROOM_PASSCODE_IPC_SET 17
#define ROOM_PASSCODE_IPC_GET 18
#define ROOM_PASSCODE_IPC_HOST 19
#define ROOM_ACCESS_IPC_SET 20
#define ROOM_ACCESS_IPC_UNLOCK 21

enum RoomPasscodeStatus {
    RoomPasscodeOk,
    RoomPasscodeUnavailable,
    RoomPasscodeInvalid,
    RoomPasscodeRoomUnavailable,
    RoomPasscodeNotHost,
    RoomPasscodeBusy,
    RoomPasscodeLocked,
    RoomPasscodeWrong
};

enum RoomPasscodeOperation { RoomPasscodeRead = 1, RoomPasscodeWrite = 2, RoomPasscodeHide = 3, RoomPasscodeAuthorize = 4 };
enum RoomAccessMode { RoomAccessNone, RoomAccessShared, RoomAccessHidden };

typedef struct {
    char room[8];
    char passcode[ROOM_PASSCODE_MAX];
} RoomPasscodeChange;

typedef struct {
    uint64_t game_id;
    char room[8];
} RoomPasscodeLookup;

typedef struct {
    uint32_t status;
    uint32_t reserved;
    char room[8];
} RoomPasscodeHost;

typedef struct {
    uint32_t status;
    uint8_t length;
    uint8_t reserved[3];
    char passcode[ROOM_PASSCODE_MAX];
} RoomPasscodeReply;

typedef struct {
    RoomPasscodeChange change;
    uint32_t hidden;
    uint32_t reserved;
} RoomAccessChange;

typedef struct {
    uint64_t game_id;
    char room[8];
    char passcode[ROOM_PASSCODE_MAX];
} RoomAccessUnlock;

/* TCP uses little-endian integers. The relay room code is exactly six bytes. */
typedef struct {
    char room[6];
    uint8_t operation;
    uint8_t length;
    uint32_t host_token;
    uint32_t reserved;
    uint64_t game_id;
    char passcode[ROOM_PASSCODE_MAX];
} RoomPasscodeRequest;

#if defined(__cplusplus)
static_assert(sizeof(RoomPasscodeChange) == 32);
static_assert(sizeof(RoomAccessChange) == 40 && sizeof(RoomAccessUnlock) == 40);
static_assert(sizeof(RoomPasscodeLookup) == 16);
static_assert(sizeof(RoomPasscodeHost) == 16);
static_assert(sizeof(RoomPasscodeReply) == 32 && offsetof(RoomPasscodeReply, passcode) == 8);
static_assert(sizeof(RoomPasscodeRequest) == 48 && offsetof(RoomPasscodeRequest, game_id) == 16);
#else
_Static_assert(sizeof(RoomPasscodeChange) == 32, "room password change");
_Static_assert(sizeof(RoomAccessChange) == 40 && sizeof(RoomAccessUnlock) == 40, "room access IPC");
_Static_assert(sizeof(RoomPasscodeLookup) == 16, "room password lookup");
_Static_assert(sizeof(RoomPasscodeHost) == 16, "room password host");
_Static_assert(sizeof(RoomPasscodeReply) == 32 && offsetof(RoomPasscodeReply, passcode) == 8, "room password reply");
_Static_assert(sizeof(RoomPasscodeRequest) == 48 && offsetof(RoomPasscodeRequest, game_id) == 16, "room password request");
#endif

#endif
