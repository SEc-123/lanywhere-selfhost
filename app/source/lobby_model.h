#pragma once

#include <stddef.h>
#include <stdbool.h>
#include <stdint.h>
#include "../../common/list_status.h"

#define LANYWHERE_IPC_MAJOR 5
#define LANYWHERE_IPC_CAPABILITIES_COMMAND 10
#define LANYWHERE_IPC_LIST_PAGE_COMMAND 12
#define LOBBY_CAP_RESERVED_MATCH 1u
#define LOBBY_META_HOST 1u
#define LOBBY_META_LOCAL 2u
#define LOBBY_PROVIDER_COUNT 13
#define LOBBY_PAGE_SIZE 6
#define LOBBY_PAGE_END UINT32_MAX

typedef struct {
    char code[8];
    uint64_t game_id;
    uint64_t application_id, program_id;
    uint8_t players, max_players, metadata_flags;
    uint8_t padding[5];
    char host[40];
    char title_en[128], title_zh[128];
} LobbyGroup;
_Static_assert(sizeof(LobbyGroup) == 336 && offsetof(LobbyGroup,application_id)==16 &&
               offsetof(LobbyGroup,players)==32 && offsetof(LobbyGroup,host)==40 &&
               offsetof(LobbyGroup,title_en)==80 && offsetof(LobbyGroup,title_zh)==208, "GroupSummaryV2 IPC layout");

typedef struct {
    int32_t count;
    uint32_t next;
    uint32_t capabilities, reserved;
} LobbyPage;
_Static_assert(sizeof(LobbyPage) == 16, "ListGroupsPageV2 IPC size");

enum LobbyMode { LobbyManual, LobbyQuick, LobbyExact };
enum LobbyMatchState {
    MatchIdle, MatchWaitScan, MatchSearching, MatchAssigned, MatchJoining,
    MatchJoined, MatchExpired, MatchCancelled, MatchError,
};

typedef struct {
    uint64_t game_id;
    uint32_t ttl_seconds;
    uint8_t mode, state, players, target;
    char room[8];
    char error[64];
} LobbyMatch;
_Static_assert(sizeof(LobbyMatch) == 0x58, "MatchStatus IPC size");
_Static_assert(offsetof(LobbyMatch, room) == 16 && offsetof(LobbyMatch, error) == 24, "MatchStatus IPC field offsets");

typedef struct {
    char code[8];
    uint64_t game_id;
} LobbyRoomId;

LobbyRoomId lobby_room_id(const LobbyGroup *group);
int lobby_room_index(LobbyRoomId id, const LobbyGroup *groups, size_t count);
void lobby_sanitize_group(LobbyGroup *group);
bool lobby_application_matches(const LobbyGroup *group, uint64_t local_application_id, const uint64_t local_lcids[8]);
bool lobby_response_is_current(unsigned generation, uint32_t offset, const char *provider,
                               unsigned current_generation, uint32_t current_offset, const char *current_provider);
uint32_t lobby_query_delay_ms(int32_t count, uint32_t status, unsigned failures);
bool lobby_transport_error_is_stale(const char *message, int32_t lobby_count);
const char *lobby_provider_id(int index);
int lobby_provider_index(const char *provider);
bool lobby_provider_is_lanplay(const char *provider);
