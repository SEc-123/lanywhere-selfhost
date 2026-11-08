// Explicitly synthetic preview data; no service or commercial game is exercised.
int main(int argc, char **argv)
{
    if (argc != 3 || !gfx_init()) return 2;
    FILE *table = fopen(argv[2], "rb");
    if (!table || fseek(table, 0, SEEK_END) != 0) return 2;
    const size_t bytes = (size_t)ftell(table);
    rewind(table);
    void *catalog = malloc(bytes);
    if (!catalog || fread(catalog, 1, bytes, table) != bytes || !game_catalog_open(&g_catalog, catalog, bytes))
        return 2;
    fclose(table);
    char clean[64];
    if (!clean_nickname("一二三四五六七八九十", clean, sizeof(clean)) ||
        !clean_nickname("一二三四五六七八九十A", clean, sizeof(clean)) ||
        clean_nickname("一二三四五六七八九十甲", clean, sizeof(clean)) ||
        clean_nickname("一二三四五六七八九十AB", clean, sizeof(clean))) {
        fprintf(stderr, "Nickname UTF-8 byte boundary failed\n"); failures++;
    }
    const char *scenes[] = { "empty-public", "empty-local", "populated", "selected", "friends-menu",
                             "friends-room", "public-room", "match-wait", "match-error", "offline",
                             "match-expired", "long-nickname", "six-rooms-message", "no-service", "wrong-version",
                             "connection-error-list-ready", "language-unsaved", "guide-unsaved", "no-service-unsaved",
                             "network-choice", "unknown-game", "external-confirm", "lanplay-main", "lanplay-private-guard",
                             "network-config-unreadable", "network-config-invalid", "local-match", "inventory-error", "external-offline",
                             "olunira-catalog-restored" };
    for (int zh = 0; zh < 2; zh++) {
        g_zh = zh != 0; ui_set_language(g_zh, false);
        snprintf(sample_games[0].name, sizeof(sample_games[0].name), "%s", zh ? "示例游戏：多人冒险与合作挑战" : "Sample game: multiplayer adventure");
        snprintf(sample_games[1].name, sizeof(sample_games[1].name), "%s", zh ? "示例竞速游戏：特别纪念版" : "Sample racing game: special edition");
        sample_games[0].installed = sample_games[1].installed = true;
        static u32 sample_icon[16 * 16];
        for (unsigned pixel = 0; pixel < 16 * 16; pixel++) sample_icon[pixel] = 0xFF529FD1;
        sample_games[0].icon = (Image){ .px = sample_icon, .w = 16, .h = 16 };
        if (gfx_text_width(20, network_offline_hint("lanplay-de-servegame")) > LIST_W - 56) {
            fprintf(stderr, "External offline hint exceeds visible width (language %d)\n", zh); failures++;
        }
        for (unsigned scene = 0; scene < sizeof(scenes) / sizeof(scenes[0]); scene++) {
            g_guide_open = false; g_language_save_failed = false;
            View v = {0};
            v.sel = -1; v.next_page = LOBBY_PAGE_END; v.config_state = RelayConfigReady;
            strcpy(v.config.provider, "self"); v.capabilities = LOBBY_CAP_RESERVED_MATCH;
            v.config.public_groups = true; v.match_available = true; v.status_valid = true; v.response_ms = 86;
            snprintf(v.nickname, sizeof(v.nickname), "%s", zh ? "示例玩家" : "SamplePlayer");
            if (scene == 1) v.config.public_groups = false;
            if (scene == 2 || scene == 3 || scene == 12) {
                v.count = LOBBY_PAGE_SIZE; v.next_page = LOBBY_PAGE_SIZE;
                for (int i = 0; i < LOBBY_PAGE_SIZE; i++) {
                    snprintf(v.groups[i].code, sizeof(v.groups[i].code), "ABCD%02d", i);
                    v.groups[i].game_id = 100 + i; v.groups[i].players = i + 1; v.groups[i].max_players = 8;
                    v.groups[i].application_id = 200 + i; v.groups[i].metadata_flags = LOBBY_META_HOST;
                    snprintf(v.groups[i].host, sizeof(v.groups[i].host), "%s", zh ? "这是一位房主的显示昵称" : "A longer host nickname");
                }
            }
            if (scene == 3) { v.sel = 2; v.selection = lobby_room_id(&v.groups[2]); }
            if (scene == 4) v.private_panel = true;
            if (scene == 5) {
                v.private_room = v.private_panel = true; v.st.state = StateInRoom;
                v.st.member_count = 8; snprintf(v.st.code, sizeof(v.st.code), "ABC234");
            }
            if (scene == 6) { v.st.state = StateInRoom; v.st.game_id = 100; v.st.member_count = 3; }
            if (scene == 7 || scene == 8) {
                v.match.mode = LobbyQuick; v.match.state = scene == 7 ? MatchWaitScan : MatchError;
                v.match.ttl_seconds = 90;
                if (scene == 8) snprintf(v.match.error, sizeof(v.match.error), "UDP offline; reconnect failed");
            }
            if (scene == 9) v.count = ListOffline;
            if (scene == 10) { v.match.mode = LobbyQuick; v.match.state = MatchExpired; }
            if (scene == 11) snprintf(v.nickname, sizeof(v.nickname), "%s", zh ? "这个中文昵称已经非常长" : "TwentyCharacterNameX");
            if (scene == 12) snprintf(v.message, sizeof(v.message), "%s", zh ? "选择的房间已关闭，请重新选择。" : "The selected room closed. Choose another room.");
            if (scene == 15) { v.st.state = StateError; v.room_notice_visible = true; snprintf(v.st.error, sizeof(v.st.error), "UDP offline; reconnect failed"); }
            if (scene >= 16 && scene <= 18) g_language_save_failed = true;
            if (scene == 17) { g_guide_open = true; g_guide_page = 0; }
            if (scene == 19) { v.provider_panel = true; v.provider_choice = 1; }
            if (scene == 20) {
                v.count = 1; strcpy(v.groups[0].code,"ABC234"); v.groups[0].game_id = 0x1122334455667788ULL;
            }
            if (scene == 21) {
                v.capabilities = 0; v.external_confirm = true; v.pinned.game_id = 100;
                v.pinned_group.game_id = 100; v.pinned_group.application_id = 200; v.pinned_group.metadata_flags = LOBBY_META_HOST;
                strcpy(v.message, "Room not reserved. Press A to open the game and search.");
            }
            if (scene == 22) strcpy(v.config.provider, "lanplay-nl");
            if (scene == 23) { strcpy(v.config.provider, "lanplay-br"); v.private_panel = true; }
            if (scene == 24) { v.config_state = RelayConfigFileError; v.count = ListOffline; }
            if (scene == 25) { v.config_state = RelayConfigInvalid; v.count = ListOffline; }
            if (scene == 26) {
                v.count = 1; strcpy(v.groups[0].code,"ABC234"); v.groups[0].game_id = 100;
                v.groups[0].application_id = 200; v.groups[0].metadata_flags = LOBBY_META_LOCAL;
                v.groups[0].players = 1; v.groups[0].max_players = 4;
                strcpy(v.groups[0].title_en,"Example local game"); strcpy(v.groups[0].title_zh,"示例本机游戏");
            }
            if (scene == 27) v.inventory_error = true;
            if (scene == 28) { v.count = ListOffline; strcpy(v.config.provider, "lanplay-de-servegame"); }
            if (scene == 29) {
                v.count = 1; v.sel = 0; v.capabilities = 0; v.st.state = StateError;
                strcpy(v.config.provider, "lanplay-cn-olunira");
                strcpy(v.st.error, "se perdió la conexión con el servidor");
                v.groups[0] = (LobbyGroup){.code="ABC234",.game_id=0x0100ABF008968000ULL,.players=1,.max_players=2,.host="Sample host"};
            }
            char path[1024];
            snprintf(path, sizeof(path), "%s/main-%s-%s.png", argv[1], zh ? "zh" : "en", scenes[scene]);
            output_path = path;
            if (scene == 13 || scene == 14 || scene == 18) {
                g_guide_open = true; // Actual startup state before service checks.
                draw_no_service(scene == 14); save_capture_if_requested();
                if (touch_action_at(GFX_W - 100, FOOTER_Y + 30) != HidNpadButton_Plus) {
                    fprintf(stderr, "No-service Exit touch is intercepted by the guide\n"); failures++;
                }
            }
            else draw(&v);
            if (scene == 19) {
                const int col_width = (LIST_W - 60) / 2;
                for (int i = 0; i < LOBBY_PROVIDER_COUNT; ++i) {
                    const int tx = MARGIN + 22 + (i % 2) * (col_width + 16) + 8;
                    const int ty = 174 + NETWORK_ROW_TOP + (i / 2) * NETWORK_ROW_STEP + 8;
                    if (174 + NETWORK_ROW_TOP + (i / 2) * NETWORK_ROW_STEP + NETWORK_ROW_HEIGHT > FOOTER_Y ||
                        gfx_text_width(18, provider_label(i)) > col_width - 100) {
                        fprintf(stderr, "Network option %d clips its label or footer in %s\n", i, path); failures++;
                    }
                    if (touch_action_at(tx, ty) != (TOUCH_NETWORK_CHOICE | (u64)i)) {
                        fprintf(stderr, "Network option %d is not touchable in %s\n", i, path); failures++;
                    }
                }
            }
            if (touch_action_at(1120, 62) != HidNpadButton_StickR) {
                fprintf(stderr, "Language touch is missing in %s\n", path); failures++;
            }
            for (int i = 0; i < g_zone_count; i++) {
                TouchZone z = g_zones[i];
                if (z.x < 0 || z.y < 0 || z.x + z.w > GFX_W || z.y + z.h > GFX_H) {
                    fprintf(stderr, "Offscreen touch zone in %s: %d,%d %dx%d\n", path, z.x,z.y,z.w,z.h); failures++;
                }
                if ((scene == 4 || scene == 5 || scene == 7 || scene == 8 || scene == 10) &&
                    z.x >= SIDE_X && z.y >= 128 && z.y < FOOTER_Y && z.button != HidNpadButton_R) {
                    fprintf(stderr, "Unrelated sidebar action remains in %s\n", path); failures++;
                }
                if (scene == 22 && (z.button == HidNpadButton_Y || z.button == HidNpadButton_L)) {
                    fprintf(stderr, "LAN Play exposed private/quick action in %s\n", path); failures++;
                }
                if (scene == 23 && (z.button == HidNpadButton_A || z.button == HidNpadButton_X)) {
                    fprintf(stderr, "LAN Play stale private panel exposed create/join in %s\n", path); failures++;
                }
                if ((scene == 24 || scene == 25) && (z.button == HidNpadButton_StickL || z.button == HidNpadButton_Y || z.button == HidNpadButton_X)) {
                    fprintf(stderr, "Invalid network config exposed provider/private controls in %s\n", path); failures++;
                }
            }
        }
    }
    gfx_exit();
    printf("Host main UI: %zu sample-state images; %u touch/capture failures. Not a full-app or Switch runtime test.\n", 2 * sizeof(scenes)/sizeof(*scenes), failures);
    return failures ? 1 : 0;
}
