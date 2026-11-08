"""Run actual title/launch functions with a simulated local NS result."""
import importlib.util
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
source = (root / 'app/source/main.c').read_text(encoding='utf-8')
spec = importlib.util.spec_from_file_location('routes', root / 'app/tests/input_routing_test.py')
routes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routes)
game_type = re.search(r'typedef struct\s*\{[^}]*\}\s*GameInfo;', source).group()
functions = '\n\n'.join(routes.function(source, 'static ' + name) for name in
    ('const GameInfo *local_game_info(', 'CatalogMatch room_catalog_match(', 'bool game_info_has_lcid(', 'const char *room_title(', 'bool open_selected_game('))
harness = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "lobby_model.h"
#include "game_catalog.h"
#include "ui_text.h"
#include "../../common/game_identity_text.h"
typedef uint64_t u64;
typedef struct { void *px; int w,h; } Image;
#define TR(es,en) ui_tr((es),(en))
#define R_FAILED(x) ((x)!=0)
''' + game_type + r'''
typedef struct { LobbyRoomId pinned; LobbyGroup pinned_group; char message[128]; } View;
static bool g_zh, installed;
static GameCatalog g_catalog;
static GameInfo fake;
static u64 last_query;
static int launches;
static const GameInfo *game_info(u64 id) { last_query=id; return installed ? &fake : NULL; }
static void draw_busy(const char *s) { (void)s; }
static int appletRequestLaunchApplication(u64 id, const void *p) { (void)p; assert(id==fake.id); launches++; return 0; }
''' + functions + r'''
int main(void) {
    char fallback[96];
    LobbyGroup room={.code="ABC234",.game_id=0x222,.application_id=0x111,.metadata_flags=LOBBY_META_HOST};
    strcpy(room.title_en,"Host game"); strcpy(room.title_zh,"房主游戏");
    fake.id=0x111; fake.installed=true; fake.lcids[0]=0x222; strcpy(fake.name,"Local game");
    installed=true; ui_set_language(false,false);
    assert(!strcmp(room_title(&room,fallback,sizeof(fallback)),"Local game") && last_query==0x111);
    View v={0};v.pinned.game_id=room.game_id;v.pinned_group=room;
    assert(open_selected_game(&v) && launches==1);
    fake.lcids[0]=0x333; launches=0;
    assert(!strcmp(room_title(&room,fallback,sizeof(fallback)),"Host game"));
    assert(!open_selected_game(&v) && launches==0); /* claimed ID does not match local LCID */
    room.game_id=UINT64_MAX;fake.lcids[0]=UINT64_MAX;v.pinned.game_id=UINT64_MAX;v.pinned_group=room;
    assert(!open_selected_game(&v) && launches==0); /* sentinel is not proof, even if NACP contains it */
    room.game_id=0x222;fake.lcids[0]=0x333;v.pinned.game_id=room.game_id;v.pinned_group=room;
    installed=false; last_query=0;
    assert(!strcmp(room_title(&room,fallback,sizeof(fallback)),"Host game") && last_query==0x111);
    assert(!open_selected_game(&v) && launches==0); /* remote title must not launch uninstalled game */
    g_zh=true;ui_set_language(true,false);
    assert(!strcmp(room_title(&room,fallback,sizeof(fallback)),"房主游戏"));
    /* An older upstream may host Violet while only Scarlet is installed here;
       the shared LCID can identify a local candidate, never the remote title. */
    room.metadata_flags=LOBBY_META_LOCAL;strcpy(room.title_en,"Pokémon Scarlet");strcpy(room.title_zh,"宝可梦 朱");
    fake.lcids[0]=0x222;strcpy(fake.name,"Pokémon Scarlet");installed=true;
    g_zh=false;ui_set_language(false,false);
    assert(!strcmp(room_title(&room,fallback,sizeof(fallback)),"Local match: Pokémon Scarlet"));
    installed=false;
    assert(!strcmp(room_title(&room,fallback,sizeof(fallback)),"Local match: Pokémon Scarlet"));
    room.metadata_flags=LOBBY_META_HOST|LOBBY_META_LOCAL;
    g_zh=true;ui_set_language(true,false);
    assert(!strcmp(room_title(&room,fallback,sizeof(fallback)),"本机可匹配：宝可梦 朱"));
    room.metadata_flags=0;room.application_id=0;room.title_en[0]=room.title_zh[0]=0;last_query=0;
    assert(strstr(room_title(&room,fallback,sizeof(fallback)),"0000000000000222") && last_query==0);
    puts("Actual UI identity: local verification, host fallback, unknown LCID and launch gate passed");
}
'''
with tempfile.TemporaryDirectory(prefix='switch-identity-ui-') as temp:
    temp = Path(temp); cfile=temp/'test.c'; exe=temp/'test';cfile.write_text(harness,encoding='utf-8')
    cc=shlex.split(os.environ.get('CC','cc'))
    subprocess.run(cc + ['-std=c11','-Wall','-Wextra','-Werror','-I'+str(root/'app/source'),str(cfile),
                         str(root/'app/source/lobby_model.c'),str(root/'app/source/ui_text.c'),str(root/'app/source/game_catalog.c'),'-o',str(exe)],check=True)
    subprocess.run([str(exe)],check=True)
