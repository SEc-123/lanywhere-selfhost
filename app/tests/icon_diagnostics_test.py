"""Run actual bounded icon diagnostic writer and unavailable-network text selection."""
import importlib.util
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
root=Path(__file__).resolve().parents[2]
s=(root/'app/source/main.c').read_text(encoding='utf-8')
spec=importlib.util.spec_from_file_location('routes',root/'app/tests/input_routing_test.py');routes=importlib.util.module_from_spec(spec);spec.loader.exec_module(routes)
writer=routes.function(s,'static void record_icon_status(')
init=routes.function(s,'static bool init_ns_with_diagnostic(')
assert 'g_ns_ready = init_ns_with_diagnostic();' in s
hint=routes.function(s,'static const char *network_offline_hint(')
harness=r'''
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdint.h>
#include <string.h>
typedef uint64_t u64; typedef uint32_t Result; typedef struct {void *px;int w,h;} Image;
static Result fake_ns_result; static unsigned ns_calls;
static Result nsInitialize(void) { ns_calls++; return fake_ns_result; }
#define R_FAILED(x) ((x)!=0)
#define RELAY_PROFILE_FIXED 1
#define TR(es,en) (en)
''' + writer + '\n' + init + '\n' + hint + r'''
int main(void) {
  Image icon={.w=4,.h=3};
  record_icon_status(0x123,2,0x4,5,"decoded",&icon,0);
  FILE *f=fopen("sdmc:/lanywhere/icon-status.log","r");assert(f);char line[256];assert(fgets(line,sizeof(line),f));fclose(f);
  assert(strstr(line,"app=0000000000000123")&&strstr(line,"attempt=2")&&strstr(line,"ns=00000004")&&strstr(line,"bytes=5")&&strstr(line,"icon=decoded")&&strstr(line,"size=4x3")&&strstr(line,"installed=no"));
  f=fopen("sdmc:/lanywhere/icon-status.log","w");assert(f);for(int i=0;i<17000;i++)fputc('X',f);fclose(f);
  record_icon_status(0x123,3,0,0,"missing",&icon,-1);f=fopen("sdmc:/lanywhere/icon-status.log","r");assert(f);assert(fgets(line,sizeof(line),f));assert(strstr(line,"attempt=3")&&strstr(line,"installed=unavailable"));assert(!fgets(line,sizeof(line),f));fclose(f);
  fake_ns_result=0;assert(init_ns_with_diagnostic());assert(ns_calls==1);
  f=fopen("sdmc:/lanywhere/icon-status.log","r");assert(f);assert(fgets(line,sizeof(line),f));assert(!fgets(line,sizeof(line),f));fclose(f);
  fake_ns_result=0x1234;assert(!init_ns_with_diagnostic());assert(ns_calls==2);
  f=fopen("sdmc:/lanywhere/icon-status.log","r");assert(f);assert(fgets(line,sizeof(line),f));assert(fgets(line,sizeof(line),f));assert(strstr(line,"app=0000000000000000")&&strstr(line,"attempt=0")&&strstr(line,"ns=00001234")&&strstr(line,"ns-init-failed"));assert(!fgets(line,sizeof(line),f));fclose(f);
  assert(strstr(network_offline_hint("lanywhere-public"),"Choose another with LS"));
  assert(strstr(network_offline_hint("lanplay-de-servegame"),"Choose another with LS"));
  assert(strstr(network_offline_hint("self"),"internet connection"));
  puts("Actual icon diagnostic: bounded fields, rollover and one-time NS initialization failure; external offline hint");
}
'''
with tempfile.TemporaryDirectory(prefix='switch-icon-diagnostics-') as tmp:
    tmp=Path(tmp);(tmp/'sdmc:'/'lanywhere').mkdir(parents=True);c=tmp/'test.c';exe=tmp/'test';c.write_text(harness)
    subprocess.run(shlex.split(os.environ.get('CC','cc'))+['-std=c11','-Wall','-Wextra','-Werror',str(c),'-o',str(exe)],check=True)
    subprocess.run([str(exe)],cwd=tmp,check=True)
