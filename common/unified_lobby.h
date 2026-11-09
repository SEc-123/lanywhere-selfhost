/* Unified self-hosted and upstream game discovery. SPDX-License-Identifier: GPL-2.0-only */
#ifndef LANYWHERE_UNIFIED_LOBBY_H
#define LANYWHERE_UNIFIED_LOBBY_H

#include <stddef.h>
#include <stdint.h>

#define UNIFIED_LOBBY_CAPABILITY 2048u
#define UNIFIED_LOBBY_IPC_LIST 24
#define UNIFIED_LOBBY_IPC_SELECT 25
#define UNIFIED_LOBBY_REQUEST_TYPE 0x28
#define UNIFIED_LOBBY_RESPONSE_TYPE 0xa8
#define UNIFIED_LOBBY_PAGE_SIZE 6
#define UNIFIED_LOBBY_HEADER_SIZE 12
#define UNIFIED_LOBBY_GROUP_SIZE 376
#define UNIFIED_LOBBY_PROVIDER_SIZE 33
#define UNIFIED_LOBBY_END UINT32_MAX

enum UnifiedWireStatus { UnifiedWireOk, UnifiedWireStale };
enum UnifiedListStatus { UnifiedListStale = 9 };

typedef struct {
    uint32_t offset;
    uint32_t snapshot;
} UnifiedRoomsRequest;

typedef struct {
    int32_t count;
    uint32_t next;
    uint32_t snapshot;
    uint32_t available;
    uint32_t total;
    uint32_t status;
} UnifiedPage;

typedef struct {
    uint64_t game_id;
    char code[8];
    char provider[UNIFIED_LOBBY_PROVIDER_SIZE];
    uint8_t reserved[7];
} UnifiedRoomRequest;

#if defined(__cplusplus)
static_assert(sizeof(UnifiedRoomsRequest) == 8);
static_assert(sizeof(UnifiedPage) == 24);
static_assert(sizeof(UnifiedRoomRequest) == 56 && offsetof(UnifiedRoomRequest, provider) == 16);
#else
_Static_assert(sizeof(UnifiedRoomsRequest) == 8, "unified room list request");
_Static_assert(sizeof(UnifiedPage) == 24, "unified room list page");
_Static_assert(sizeof(UnifiedRoomRequest) == 56 && offsetof(UnifiedRoomRequest, provider) == 16, "unified room selection");
#endif

#endif
