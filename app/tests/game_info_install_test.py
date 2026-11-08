"""Exercise actual game_info with cached NS control data and installation status."""
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
function = routes.function(source, 'static const GameInfo *game_info(')
harness = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "../../common/game_identity_text.h"
typedef uint64_t u64; typedef unsigned Result;
typedef struct { void *px; int w,h; } Image;
typedef struct { struct { u64 local_communication_id[8]; } nacp; unsigned char icon[8]; } NsApplicationControlData;
enum { NsApplicationControlSource_Storage=1 };
#define R_SUCCEEDED(x) ((x)==0)
static bool g_ns_ready=true, g_zh=false, g_es=false;
static u64 now_ms(void) { return 0; }
static atomic_bool g_inventory_running;
static bool installed, install_query_fails;
static int control_calls, install_calls;
static int nsGetApplicationControlData(int src,u64 id,NsApplicationControlData *out,size_t size,u64 *actual) {
    (void)src;(void)id;(void)size;control_calls++;out->nacp.local_communication_id[0]=0xabc;*actual=sizeof(out->nacp);return 0;
}
static int nsIsAnyApplicationEntityInstalled(u64 id,bool *out) { (void)id;install_calls++;*out=installed;return install_query_fails; }
static int nacp_name(const unsigned char *p,size_t n,const int *prefs,int pc,char *out,size_t cap) {
    (void)p;(void)n;(void)prefs;(void)pc;snprintf(out,cap,"Example game");return 0;
}
static void decode_icon(Image *i,const unsigned char *data,size_t n) { (void)i;(void)data;(void)n; }
static void record_icon_status(u64 id,unsigned attempt,unsigned long result,u64 n,const char *status,const Image *i,int installed) { (void)id;(void)attempt;(void)result;(void)n;(void)status;(void)i;(void)installed; }
''' + game_type + r'''
static GameInfo g_games[24];static int g_game_count;static unsigned g_game_replace;
''' + function + r'''
int main(void) {
    installed=false;
    const GameInfo *a=game_info(0x111);
    assert(a && !a->installed && a->lcids[0]==0xabc && control_calls==1 && install_calls==1);
    /* A cached control NACP is not proof the application is installed. */
    g_game_count=0; installed=true; install_query_fails=true;
    a=game_info(0x111);assert(a && !a->installed && install_calls==2);
    g_game_count=0; install_query_fails=false;
    a=game_info(0x111);assert(a && a->installed && install_calls==3);
    g_game_count=0; atomic_store(&g_inventory_running,true);
    assert(!game_info(0x111) && control_calls==3);
    puts("Actual game_info: cached NACP cannot enable launch without NS installed confirmation");
}
'''
with tempfile.TemporaryDirectory(prefix='switch-installed-check-') as temp:
    temp = Path(temp); cfile=temp/'test.c';exe=temp/'test';cfile.write_text(harness,encoding='utf-8')
    cc=shlex.split(os.environ.get('CC','cc'))
    subprocess.run(cc+['-std=c11','-Wall','-Wextra','-Werror','-I'+str(root/'app/source'),str(cfile),'-o',str(exe)],check=True)
    subprocess.run([str(exe)],check=True)
