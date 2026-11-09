"""Run unchanged actual main.c title/card functions with isolated NS and gfx stubs."""
import importlib.util
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

root=Path(__file__).resolve().parents[2]
source=(root/'app/source/main.c').read_text(encoding='utf-8')
spec=importlib.util.spec_from_file_location('routes',root/'app/tests/input_routing_test.py')
routes=importlib.util.module_from_spec(spec);spec.loader.exec_module(routes)
game_type=re.search(r'typedef struct\s*\{[^}]*\}\s*GameInfo;',source).group()
functions='\n\n'.join(routes.function(source,'static '+name) for name in (
    'const GameInfo *local_game_info(', 'CatalogMatch room_catalog_match(', 'bool game_info_has_lcid(', 'const char *room_title(', 'const GameInfo *display_game_icon(', 'const char *room_title_note(', 'const char *provider_label(', 'void group_card('))
harness=r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "lobby_model.h"
#include "game_catalog.h"
#include "ui_text.h"
#include "../../common/game_identity_text.h"
typedef uint64_t u64; typedef uint32_t u32;
typedef struct { void *px; int w,h; } Image;
#define TR(es,en) ui_tr((es),(en))
#define RGBA(r,g,b,a) 0
enum {C_ACCENT,C_BG_TOP,C_CARD,C_DIM,C_TEXT,C_OK,C_SEAT_OFF,C_WARN};
''' + game_type + r'''
static bool g_zh;
static GameCatalog g_catalog;static GameInfo fake;static int image_count,question_count;static char title[160];
static const GameInfo *game_info(u64 id) { assert(id==fake.id); return &fake; }
static void gfx_round_rect(int x,int y,int w,int h,int r,u32 c){(void)x;(void)y;(void)w;(void)h;(void)r;(void)c;}
static void gfx_text(int x,int y,int s,u32 c,const char *p){(void)x;(void)y;(void)s;(void)c;if(!strcmp(p,"?"))question_count++;}
static void gfx_text_fit(int x,int y,int s,u32 c,const char *p,int w){(void)x;(void)y;(void)s;(void)c;(void)w;if(!title[0])snprintf(title,sizeof(title),"%s",p);}
static int gfx_text_width(int s,const char *p){(void)s;(void)p;return 10;}
static void gfx_image(const Image *p,int x,int y,int w,int h){(void)p;(void)x;(void)y;(void)w;(void)h;image_count++;}
static void seats(int x,int y,int p,int m){(void)x;(void)y;(void)p;(void)m;}
''' + functions + r'''
int main(void){
    LobbyGroup room={.code="ABC234",.game_id=0x222,.application_id=0x111,.metadata_flags=LOBBY_META_HOST};
    strcpy(room.title_en,"Host title");fake.id=0x111;fake.installed=true;fake.icon.px=(void*)1;
    ui_set_language(false,false);
    strcpy(fake.name,"Local unrelated title");
    group_card(0,0,760,&room,NULL,false);
    assert(image_count==1&&!question_count&&!strcmp(title,"Host title")&&!local_game_info(&room));
    fake.lcids[0]=0x333;image_count=question_count=0;title[0]=0;group_card(0,0,760,&room,NULL,false);
    assert(image_count==1&&!question_count&&!strcmp(title,"Host title")&&!local_game_info(&room));
    fake.lcids[0]=0x222;image_count=question_count=0;title[0]=0;group_card(0,0,760,&room,NULL,false);
    assert(image_count==1&&!question_count&&local_game_info(&room));
    fake.installed=false;image_count=question_count=0;title[0]=0;group_card(0,0,760,&room,NULL,false);
    assert(image_count==1&&!question_count&&!strcmp(title,"Host title")&&!local_game_info(&room));
    room.metadata_flags=LOBBY_META_LOCAL;fake.install_checked=true;image_count=question_count=0;title[0]=0;
    group_card(0,0,760,&room,NULL,false);assert(image_count==1&&!question_count&&strstr(title,"Local match:")&&!local_game_info(&room));
    fake.install_checked=false;image_count=question_count=0;title[0]=0;
    group_card(0,0,760,&room,NULL,false);assert(image_count==1&&!question_count&&strstr(title,"Local match:")&&!local_game_info(&room));
    room.metadata_flags=LOBBY_META_HOST|LOBBY_META_LOCAL;image_count=question_count=0;title[0]=0;
    group_card(0,0,760,&room,NULL,false);assert(image_count==1&&!question_count&&strstr(title,"Local match:")&&!local_game_info(&room));
    fake.lcids[0]=0x333;image_count=question_count=0;title[0]=0;
    group_card(0,0,760,&room,NULL,false);assert(!image_count&&question_count==1&&strstr(title,"Local match:")&&!local_game_info(&room));
    fake.installed=true;fake.lcids[0]=0x222;image_count=question_count=0;title[0]=0;
    group_card(0,0,760,&room,NULL,false);assert(image_count==1&&strstr(title,"Local match:")&&local_game_info(&room));
    room.game_id=UINT64_MAX;fake.lcids[0]=UINT64_MAX;fake.installed=true;
    room.metadata_flags=LOBBY_META_LOCAL;image_count=question_count=0;title[0]=0;
    group_card(0,0,760,&room,NULL,false);assert(!image_count&&question_count==1&&!local_game_info(&room));
    room.metadata_flags=LOBBY_META_HOST;image_count=question_count=0;title[0]=0;
    group_card(0,0,760,&room,NULL,false);assert(image_count==1&&!question_count&&!local_game_info(&room));
    puts("Actual card: HOST and LOCAL display checks remain distinct from installed LCID launch gate");
}
'''
with tempfile.TemporaryDirectory(prefix='switch-icon-route-') as d:
    d=Path(d);c=d/'test.c';exe=d/'test';c.write_text(harness,encoding='utf-8')
    subprocess.run(shlex.split(os.environ.get('CC','cc'))+['-std=c11','-Wall','-Wextra','-Werror','-I'+str(root/'app/source'),str(c),str(root/'app/source/lobby_model.c'),str(root/'app/source/ui_text.c'),str(root/'app/source/game_catalog.c'),'-o',str(exe)],check=True)
    subprocess.run([str(exe)],check=True)
