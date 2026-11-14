#include "lobby_model.h"

#include <string.h>
#include "../../common/game_identity_text.h"

static void sanitize_text(char *text, size_t size)
{
    const char *end = memchr(text, '\0', size);
    char safe[GAME_IDENTITY_TITLE_CAP];
    if (!end || !game_identity_safe_title((const uint8_t *)text, (size_t)(end - text), safe, size)) {
        memset(text, 0, size);
        return;
    }
    memset(text, 0, size);
    memcpy(text, safe, strlen(safe));
}

void lobby_sanitize_group(LobbyGroup *group)
{
    if (!group) return;
    group->metadata_flags &= LOBBY_META_HOST | LOBBY_META_LOCAL;
    if (group->room_access > RoomAccessHidden) group->room_access = RoomAccessNone;
    sanitize_text(group->host, sizeof(group->host));
    sanitize_text(group->title_en, sizeof(group->title_en));
    sanitize_text(group->title_zh, sizeof(group->title_zh));
    if (!group->metadata_flags) {
        group->application_id = group->program_id = 0;
        memset(group->title_en, 0, sizeof(group->title_en));
        memset(group->title_zh, 0, sizeof(group->title_zh));
    }
}

bool lobby_application_matches(const LobbyGroup *group, uint64_t local_application_id, const uint64_t local_lcids[8])
{
    if (!group || !local_lcids || !group->metadata_flags || !group->application_id ||
        group->application_id != local_application_id || !group->game_id || group->game_id == UINT64_MAX) return false;
    for (size_t i = 0; i < 8; ++i)
        if (local_lcids[i] == group->game_id) return true;
    return false;
}

bool lobby_response_is_current(unsigned generation, uint32_t offset, const char *provider,
                               unsigned current_generation, uint32_t current_offset, const char *current_provider)
{
    return provider && current_provider && generation == current_generation && offset == current_offset &&
           strcmp(provider, current_provider) == 0;
}

uint32_t lobby_query_delay_ms(int32_t count, uint32_t status, unsigned failures)
{
    if (count >= 0) return 5000;
    if (status != ListStatusNetwork && status != ListStatusTimeout && status != ListStatusBusy) return 10000;
    const unsigned shift = failures > 4 ? 3 : failures ? failures - 1 : 0;
    return 1250u << shift;
}

bool lobby_transport_error_is_stale(const char *message, int32_t lobby_count)
{
    if (!message || lobby_count < 0) return false;
    return strcmp(message, "se perdió la conexión con el servidor") == 0 ||
           strcmp(message, "UDP offline; reconnect failed") == 0 ||
           strcmp(message, "no se pudo conectar con el servidor") == 0 ||
           strcmp(message, "el servidor no responde") == 0 ||
           strcmp(message, "el servidor no contestó") == 0;
}

static const char *const providers[LOBBY_PROVIDER_COUNT] = {
    "self", "lanywhere-public", "lanplay-nl", "lanplay-br", "lanplay-id",
    "lanplay-nl-jaysea-rust", "lanplay-nl-r3ps4j-rust", "lanplay-nl-r3ps4j-11452", "lanplay-de-servegame",
    "lanplay-cn-jax", "lanplay-cn-gugu", "lanplay-cn-olunira", "lanplay-cn-shanghai"
};

const char *lobby_provider_id(int index)
{
    return index >= 0 && index < LOBBY_PROVIDER_COUNT ? providers[index] : NULL;
}

int lobby_provider_index(const char *provider)
{
    if (!provider) return -1;
    for (int i=0; i<LOBBY_PROVIDER_COUNT; ++i) if (strcmp(provider, providers[i]) == 0) return i;
    return -1;
}

bool lobby_provider_is_lanplay(const char *provider)
{
    const int index = lobby_provider_index(provider);
    return index >= 2 && index < LOBBY_PROVIDER_COUNT;
}

bool lobby_provider_is_self_relay(const char *provider)
{
    return provider && (strcmp(provider, "self") == 0 || strcmp(provider, REGION_PROVIDER_EU) == 0);
}

LobbyRoomId lobby_room_id_on(const LobbyGroup *group, const char *provider)
{
    if (!group->game_id || group->code[6] != '\0')
        return (LobbyRoomId){0};
    for (int i = 0; i < 6; i++) {
        const char c = group->code[i];
        if (!(c >= 'A' && c <= 'Z' && c != 'I' && c != 'O') && !(c >= '2' && c <= '9'))
            return (LobbyRoomId){0};
    }
    LobbyRoomId id = {.game_id = group->game_id};
    memcpy(id.code, group->code, 6);
    if (provider && provider[0]) {
        size_t size = 0;
        while (size < sizeof(id.provider) && provider[size]) ++size;
        if (size == sizeof(id.provider) ||
            (lobby_provider_index(provider) < 0 && strcmp(provider, REGION_PROVIDER_EU) != 0 &&
             strcmp(provider, REGION_PROVIDER_COMMUNITY) != 0))
            return (LobbyRoomId){0};
        memcpy(id.provider, provider, size);
    }
    return id;
}

LobbyRoomId lobby_room_id(const LobbyGroup *group)
{
    return lobby_room_id_on(group, NULL);
}

bool lobby_room_equal(LobbyRoomId left, LobbyRoomId right)
{
    return left.game_id == right.game_id && memcmp(left.code, right.code, sizeof(left.code)) == 0 &&
        strcmp(left.provider, right.provider) == 0;
}

int lobby_room_index_on(LobbyRoomId id, const LobbyGroup *groups, const LobbySource *providers, size_t count)
{
    if (!id.code[0] || !id.game_id) return -1;
    for (size_t i = 0; i < count; i++) {
        if (lobby_room_equal(id, lobby_room_id_on(&groups[i], providers ? providers[i] : NULL)))
            return (int)i;
    }
    return -1;
}

int lobby_room_index(LobbyRoomId id, const LobbyGroup *groups, size_t count)
{
    return lobby_room_index_on(id, groups, NULL, count);
}

bool lobby_unified_page_valid(UnifiedPage page, UnifiedRoomsRequest request,
                              const LobbyUnifiedGroup *rows, size_t capacity, bool regional)
{
    if (page.count == -1)
        return page.next == UNIFIED_LOBBY_END &&
            (lanywhere_list_status_valid(page.status) || page.status == UnifiedListStale);
    if (page.count < 0 || (size_t)page.count > capacity || page.status != ListStatusOk || !page.snapshot ||
        (request.snapshot && request.snapshot != page.snapshot) || page.available > page.total ||
        page.total > (uint32_t)(LOBBY_PROVIDER_COUNT + regional) ||
        (page.next != UNIFIED_LOBBY_END && (!page.count || page.next <= request.offset ||
                                           page.next - request.offset != (uint32_t)page.count)))
        return false;
    for (int32_t i = 0; i < page.count; i++) {
        const LobbyUnifiedGroup *row = &rows[i];
        if (!row->provider[0] || !lobby_room_id_on(&row->group, row->provider).game_id ||
            (!regional && (strcmp(row->provider, REGION_PROVIDER_EU) == 0 ||
                           strcmp(row->provider, REGION_PROVIDER_COMMUNITY) == 0)) ||
            (strcmp(row->provider, REGION_PROVIDER_COMMUNITY) == 0 && row->group.room_access != RoomAccessNone))
            return false;
        for (size_t j = 0; j < sizeof(row->reserved); ++j)
            if (row->reserved[j]) return false;
    }
    return true;
}


bool lobby_room_full(const LobbyGroup *group)
{
    return group->max_players != 0 && group->players >= group->max_players;
}

int lobby_next_selectable_room(const LobbyGroup *groups, int count, int current, int direction)
{
    for (int i = current + direction; i >= 0 && i < count; i += direction)
        if (!lobby_room_full(&groups[i])) return i;
    return direction < 0 ? -1 : current;
}
