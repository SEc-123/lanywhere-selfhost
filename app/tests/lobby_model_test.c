#include "lobby_model.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

int main(void)
{
    LobbyGroup initial[] = {
        { .code = "ABC234", .game_id = 2 },
        { .code = "DEF567", .game_id = 3 },
        { .code = "BAD", .game_id = 2 },
        { .code = "BAD\n55", .game_id = 3 },
        { .code = "BAD222", .game_id = 0 },
        { .code = "ABCDI0", .game_id = 4 },
    };
    LobbyRoomId selected = lobby_room_id(&initial[1]);
    assert(strcmp(selected.code, "DEF567") == 0);
    assert(lobby_room_index(selected, initial, 6) == 1);
    for (size_t i = 2; i < 6; i++)
        assert(lobby_room_index(lobby_room_id(&initial[i]), initial, 6) == -1);

    LobbyGroup refreshed[] = {
        { .code = "DEF567", .game_id = 4 },
        { .code = "GHJ789", .game_id = 5 },
        { .code = "DEF567", .game_id = 3, .players = 3, .max_players = 4 },
    };
    assert(lobby_room_index(selected, refreshed, 3) == 2);
    assert(lobby_room_index(selected, refreshed, 2) == -1);
    assert(lobby_room_index(selected, refreshed, 0) == -1);
    LobbyGroup hosted = { .code = "ABC234", .game_id = 0x987, .application_id = 0x123,
                          .program_id = 0x456, .metadata_flags = LOBBY_META_HOST };
    strcpy(hosted.title_en, "Pokémon Violet"); strcpy(hosted.title_zh, "宝可梦 紫");
    const uint64_t compatible[8] = {0,0x987};
    const uint64_t incompatible[8] = {0x123,0};
    lobby_sanitize_group(&hosted);
    assert(!strcmp(hosted.title_en, "Pokémon Violet") && !strcmp(hosted.title_zh, "宝可梦 紫"));
    assert(lobby_application_matches(&hosted, 0x123, compatible));
    assert(!lobby_application_matches(&hosted, 0x123, incompatible));
    assert(!lobby_application_matches(&hosted, 0x987, compatible)); /* LCID is not an application ID */
    assert(!lobby_application_matches(&hosted, 0, compatible));
    const uint64_t sentinel_record[8] = {UINT64_MAX};
    hosted.game_id = UINT64_MAX;
    assert(!lobby_application_matches(&hosted, 0x123, sentinel_record));
    hosted.game_id = 0x987;
    strcpy(hosted.title_en, "Host\342\200\256fake"); /* U+202E bidi override */
    lobby_sanitize_group(&hosted);
    assert(hosted.title_en[0] == '\0' && hosted.title_zh[0]);
    memset(hosted.title_en, 'A', sizeof(hosted.title_en)); /* missing terminator */
    lobby_sanitize_group(&hosted);
    assert(!hosted.title_en[0]);
    hosted.metadata_flags = 0;
    lobby_sanitize_group(&hosted);
    assert(!hosted.application_id && !hosted.program_id && !hosted.title_zh[0]);
    assert(lobby_response_is_current(9, 6, "self", 9, 6, "self"));
    assert(!lobby_response_is_current(8, 6, "self", 9, 6, "self"));
    assert(!lobby_response_is_current(9, 6, "self", 9, 0, "self"));
    assert(!lobby_response_is_current(9, 6, "self", 9, 6, "lanywhere-public"));
    for (int i=0;i<LOBBY_PROVIDER_COUNT;i++) assert(lobby_provider_index(lobby_provider_id(i))==i);
    assert(lobby_provider_index("unknown")==-1 && lobby_provider_id(LOBBY_PROVIDER_COUNT)==NULL);
    assert(!lobby_provider_is_lanplay("self") && !lobby_provider_is_lanplay("lanywhere-public"));
    assert(lobby_provider_is_lanplay("lanplay-nl") && lobby_provider_is_lanplay("lanplay-br") && lobby_provider_is_lanplay("lanplay-id"));
    assert(lobby_provider_is_lanplay("lanplay-nl-jaysea-rust") && lobby_provider_is_lanplay("lanplay-nl-r3ps4j-rust") && lobby_provider_is_lanplay("lanplay-nl-r3ps4j-11452"));
    assert(lobby_provider_is_lanplay("lanplay-de-servegame"));
    assert(!strcmp(lobby_provider_id(9),"lanplay-cn-jax") && !strcmp(lobby_provider_id(10),"lanplay-cn-gugu"));
    assert(!strcmp(lobby_provider_id(11),"lanplay-cn-olunira") && !strcmp(lobby_provider_id(12),"lanplay-cn-shanghai"));
    for (int i=9;i<=12;i++) assert(lobby_provider_is_lanplay(lobby_provider_id(i)));
    assert(!lobby_provider_is_lanplay("lanplay-unknown"));
    puts("LANywhere lobby selection tests passed");
    return 0;
}
