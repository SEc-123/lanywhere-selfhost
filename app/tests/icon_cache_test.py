"""Run actual game_info with controlled NS and icon decoder responses."""
import importlib.util
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile
root=Path(__file__).resolve().parents[2]
source=(root/'app/source/main.c').read_text(encoding='utf-8')
spec=importlib.util.spec_from_file_location('routes',root/'app/tests/input_routing_test.py');routes=importlib.util.module_from_spec(spec);spec.loader.exec_module(routes)
game_type=re.search(r'typedef struct\s*\{[^}]*\}\s*GameInfo;',source).group()
function=routes.function(source,'static const GameInfo *game_info(')
harness=r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../common/game_identity_text.h"
typedef uint64_t u64;typedef unsigned Result;static u64 clock_ms;static u64 now_ms(void){return clock_ms;}
typedef struct {void *px;int w,h;} Image;
typedef struct { struct {u64 local_communication_id[8];} nacp; unsigned char icon[8]; } NsApplicationControlData;
enum {NsApplicationControlSource_Storage=1};
#define R_SUCCEEDED(x) ((x)==0)
static bool g_ns_ready=true,g_zh=false,g_es=false,query_ok,icon_available,decode_fails,install_fails;
static atomic_bool g_inventory_running;
static int query_calls,decode_calls;
static int nsGetApplicationControlData(int s,u64 id,NsApplicationControlData *out,size_t size,u64 *actual){
 (void)s;(void)id;(void)size;query_calls++;if(!query_ok)return 1;memset(out,0,sizeof(*out));
 out->nacp.local_communication_id[0]=0x222;*actual=sizeof(out->nacp)+(icon_available?sizeof(out->icon):0);return 0;
}
static int nsIsAnyApplicationEntityInstalled(u64 id,bool *out){(void)id;*out=true;return install_fails;}
static int nacp_name(const unsigned char *p,size_t n,const int *prefs,int pc,char *out,size_t cap){(void)p;(void)n;(void)prefs;(void)pc;snprintf(out,cap,"Game title");return 0;}
static void decode_icon(Image *i,const unsigned char *p,size_t n){(void)p;(void)n;decode_calls++;if(!decode_fails)i->px=malloc(1);}
static void record_icon_status(u64 id,unsigned a,unsigned long r,u64 n,const char *s,const Image *i,int installed){(void)id;(void)a;(void)r;(void)n;(void)s;(void)i;(void)installed;}
''' + game_type + r'''
static GameInfo g_games[24];static int g_game_count;static unsigned g_game_replace;
''' + function + r'''
int main(void){
 query_ok=false;const GameInfo *g=game_info(0x111);assert(g&&g->installed&&!g->lcids[0]&&query_calls==1);
 query_ok=true;icon_available=true;g=game_info(0x111);assert(g&&g->installed&&!g->icon.px&&query_calls==1);
 clock_ms=999;game_info(0x111);assert(query_calls==1);
 clock_ms=1000;atomic_store(&g_inventory_running,true);game_info(0x111);assert(query_calls==1);
 atomic_store(&g_inventory_running,false);g=game_info(0x111);assert(g->icon.px&&g->installed&&query_calls==2);
 free(g->icon.px);g_game_count=0;clock_ms=0;icon_available=false;
 g=game_info(0x222);assert(g->installed&&!g->icon.px&&query_calls==3);
 icon_available=true;game_info(0x222);assert(query_calls==3);
 clock_ms=1000;g=game_info(0x222);assert(g->icon.px&&query_calls==4);
 free(g->icon.px);g_game_count=0;query_ok=true;decode_fails=true;clock_ms=0;
 g=game_info(0x444);assert(g->installed&&!g->icon.px);decode_fails=false;
 clock_ms=1000;g=game_info(0x444);assert(g->icon.px);free(g->icon.px);
 g_game_count=0;clock_ms=0;icon_available=false;g=game_info(0x555);assert(g->installed);
 install_fails=true;clock_ms=1000;g=game_info(0x555);assert(!g->installed&&!g->install_checked);
 install_fails=false;clock_ms=6000;g=game_info(0x555);assert(g->installed);
 g_game_count=0;query_ok=false;clock_ms=0;
 game_info(0x333);clock_ms=1000;game_info(0x333);clock_ms=6000;game_info(0x333);
 int calls=query_calls;clock_ms=100000;game_info(0x333);assert(query_calls==calls);
 puts("Actual cache: bounded timed retries recover NS/missing JPEG and respect active inventory");
}
'''
with tempfile.TemporaryDirectory(prefix='switch-icon-cache-') as td:
    td=Path(td);c=td/'test.c';exe=td/'test';c.write_text(harness,encoding='utf-8')
    subprocess.run(shlex.split(os.environ.get('CC','cc'))+['-std=c11','-Wall','-Wextra','-Werror','-I'+str(root/'app/source'),str(c),'-o',str(exe)],check=True)
    subprocess.run([str(exe)],check=True)
