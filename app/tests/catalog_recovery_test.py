#!/usr/bin/env python3
"""Exercise the reported Olunira LCID and stale error through the actual app paths."""
import importlib.util
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'app/source'
spec = importlib.util.spec_from_file_location('routes', ROOT / 'app/tests/input_routing_test.py')
routes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routes)
main = (SOURCE / 'main.c').read_text()
game_type = re.search(r'typedef struct\s*\{[^}]*\}\s*GameInfo;', main).group()
status = main[main.index('typedef struct {\n    u8 state,'):main.index('static Service g_lanywhere;')]
view_at = main.index('typedef struct {\n    LanywhereStatus st;')
view = main[view_at:main.index('} View;', view_at) + len('} View;')]
code = '\n'.join(routes.function(main, 'static ' + name) for name in (
    'const GameInfo *local_game_info(', 'CatalogMatch room_catalog_match(', 'bool game_info_has_lcid(',
    'const char *room_title(', 'const char *room_title_note(', 'void poll_lanywhere(', 'bool show_room_notice(',
    'bool show_matching(', 'bool can_change_provider(',
))

harness = r'''
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "game_catalog.h"
#include "lobby_model.h"
#include "relay_config.h"
#include "ui_text.h"
#include "../../common/game_identity_text.h"
typedef uint8_t u8; typedef uint32_t u32; typedef uint64_t u64; typedef int32_t s32;
typedef struct { void *px; int w,h; } Image;
#define TR(es,en) ui_tr((es),(en))
#define R_SUCCEEDED(r) ((r)==0)
#define ROOM_NOTICE_MS 6000
''' + status + '\n' + game_type + '\n' + view + r'''
static GameCatalog g_catalog;
static GameInfo local;
static bool g_zh, have_local, ipc_ok=true;
static u64 queried, clock_ms;
static LanywhereStatus observed;
static u64 now_ms(void) { return clock_ms; }
static const GameInfo *game_info(u64 id) { queried=id; return have_local && id==local.id ? &local : NULL; }
static int lanywhere_status(LanywhereStatus *out) { *out=observed;return !ipc_ok; }
static int lanywhere_match_status(LobbyMatch *out) { *out=(LobbyMatch){0};return 0; }
''' + code + r'''
int main(int argc, char **argv)
{
    assert(argc==2);
    FILE *f=fopen(argv[1],"rb");assert(f && fseek(f,0,SEEK_END)==0);
    size_t size=(size_t)ftell(f); rewind(f);
    unsigned char *data=malloc(size); assert(data && fread(data,1,size,f)==size); fclose(f);
    assert(!game_catalog_open(&g_catalog,data,size-1));
    assert(game_catalog_open(&g_catalog,data,size));
    assert(g_catalog.title_count > 1000);
    const u64 sword=UINT64_C(0x0100ABF008968000);
    LobbyGroup room={.game_id=sword}; char fallback[128];
    CatalogMatch id=room_catalog_match(&room);
    assert(id.app_id==sword && (id.kind==CatalogEqualId || id.kind==CatalogCommunication));
    ui_set_language(false,false);
    assert(!strcmp(room_title(&room,fallback,sizeof(fallback)),"Pokémon™ Sword"));
    assert(!strcmp(room_title_note(&room),"Catalog match")); /* Inventory unavailable is not proof of absence. */
    have_local=true; local.id=sword;local.install_checked=true;
    assert(!strcmp(room_title_note(&room),"Not installed") && queried==sword);
    local.installed=true;
    strcpy(local.name,"Sword from local NS");
    assert(!strcmp(room_title(&room,fallback,sizeof(fallback)),"Pokémon™ Sword")); /* Still no NACP LCID proof. */
    local.lcids[0]=sword;
    assert(!strcmp(room_title(&room,fallback,sizeof(fallback)),"Sword from local NS"));
    assert(!room_title_note(&room));
    assert(!local_game_info(&room)); /* Catalog fallback does not confer launch permission. */
    local.installed=false; g_zh=true; ui_set_language(true,false);
    assert(!strcmp(room_title(&room,fallback,sizeof(fallback)),"宝可梦 剑"));
    assert(!strcmp(room_title_note(&room),"未安装"));
    room.game_id=UINT64_C(0x0100A3D008C5C000);
    assert(strstr(room_title(&room,fallback,sizeof(fallback)),"宝可梦 紫"));
    assert(!strcmp(room_title_note(&room),"共用游戏 ID"));
    room.game_id=UINT64_MAX;
    assert(!strcmp(room_title(&room,fallback,sizeof(fallback)),"房主未提供游戏名"));
    room.game_id=UINT64_C(0xDEADBEEFDEADBEEF);
    assert(strstr(room_title(&room,fallback,sizeof(fallback)),"DEADBEEFDEADBEEF"));

    View v={.count=1,.config_state=RelayConfigReady,.discovery=LobbyDiscoveryLegacy};
    observed.state=StateError;
    strcpy(observed.error,"se perdió la conexión con el servidor");
    poll_lanywhere(&v);
    assert(!show_room_notice(&v,clock_ms) && can_change_provider(&v));
    v.count=-1;
    assert(show_room_notice(&v,clock_ms));
    ipc_ok=false;
    poll_lanywhere(&v);
    assert(!show_room_notice(&v,clock_ms) && !can_change_provider(&v));
    ipc_ok=true;
    v.count=1;
    observed.state=StateConnecting;
    strcpy(observed.error,"Reconnecting to the room.");
    poll_lanywhere(&v);
    assert(show_room_notice(&v,12000) && !can_change_provider(&v)); /* Lobby online, game recovering. */
    clock_ms=12000;
    observed.state=StateInRoom;observed.error[0]=0;
    poll_lanywhere(&v);
    assert(!show_room_notice(&v,clock_ms));
    observed.state=StateError;
    strcpy(observed.error,"Room session expired. Rejoin from the game.");
    poll_lanywhere(&v);
    assert(show_room_notice(&v,clock_ms) && !show_room_notice(&v,clock_ms+6000));
    assert(lobby_query_delay_ms(-1,ListStatusNetwork,1)==1250);
    assert(lobby_query_delay_ms(-1,ListStatusTimeout,2)==2500);
    assert(lobby_query_delay_ms(-1,ListStatusBusy,400)==10000);
    assert(lobby_query_delay_ms(0,ListStatusOk,400)==5000);
    free(data);
    puts("Actual app paths: screenshot game, language, absent/unknown/installed distinction, session and lobby recovery, bounded retry");
}
'''

with tempfile.TemporaryDirectory(prefix='lanywhere-catalog-recovery-') as temporary:
    tmp = Path(temporary)
    source, exe, table = tmp / 'fixture.c', tmp / 'fixture', tmp / 'game_catalog.bin'
    source.write_text(harness)
    subprocess.run([sys.executable, str(ROOT / 'scripts/compile-title-catalog.py'), str(table)], check=True)
    cc = shlex.split(os.environ.get('CC', 'cc'))
    subprocess.run(cc + ['-std=c11', '-Wall', '-Wextra', '-Werror', '-I' + str(SOURCE), str(source),
                         str(SOURCE / 'game_catalog.c'), str(SOURCE / 'lobby_model.c'), str(SOURCE / 'ui_text.c'),
                         '-o', str(exe)], check=True)
    subprocess.run([str(exe), str(table)], check=True)
