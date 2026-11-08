#!/usr/bin/env python3
"""Execute actual IPC-result parsing and UI text with a mocked service boundary."""
import importlib.util
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('routes', ROOT / 'app/tests/input_routing_test.py')
routes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routes)
source = (ROOT / 'app/source/main.c').read_text()
pieces = '\n'.join(routes.function(source, sig) for sig in (
    'static LobbyPage lanywhere_list_groups(', 'static const char *list_error_title(',
    'static const char *network_offline_hint(', 'static const char *list_error_hint('))
# The typed result is committed under the same provider/generation guard as the records.
thread = routes.function(source, 'static void list_thread(')
assert thread.index('lobby_response_is_current(') < thread.index('g_list_page = page;')
assert 'page.reserved != g_list_page.reserved' in thread
assert 'v.list_status = g_list_page.reserved;' in source
harness = r'''
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include "lobby_model.h"
#include "ui_text.h"
typedef uint32_t u32; typedef int32_t s32;
#define R_FAILED(r) ((r) != 0)
#define RELAY_PROFILE_FIXED 1
#define TR(es,en) ui_tr((es),(en))
static LobbyPage mock_page;
static int mock_result;
#define serviceDispatchInOut(service,command,offset,page,...) ((page)=mock_page,mock_result)
''' + pieces + r'''
int main(void) {
    LobbyGroup groups[6] = {0};
    assert(sizeof(LobbyPage)==16 && LANYWHERE_IPC_MAJOR==5);
    for(unsigned status=ListStatusNetwork; status<=ListStatusUpdate; ++status) {
        mock_page=(LobbyPage){.count=-1,.reserved=status,.next=3,.capabilities=123};
        LobbyPage out=lanywhere_list_groups(0,groups,6);
        assert(out.count==-1 && out.reserved==status && out.next==LOBBY_PAGE_END && out.capabilities==0);
        assert(strcmp(list_error_title(status),"Offline") || status==ListStatusNetwork);
        assert(list_error_hint(status,"lanplay-de-servegame")[0]);
    }
    mock_page=(LobbyPage){.count=-1};
    assert(lanywhere_list_groups(0,groups,6).reserved==ListStatusNetwork); // Old plugin failure.
    mock_page=(LobbyPage){.count=0,.next=LOBBY_PAGE_END};
    LobbyPage out=lanywhere_list_groups(0,groups,6);
    assert(out.count==0 && out.reserved==0); // Actual empty success, not an error.
    mock_page.reserved=ListStatusBusy;
    assert(lanywhere_list_groups(0,groups,6).reserved==ListStatusProtocol);
    mock_page=(LobbyPage){.count=-1,.reserved=UINT32_MAX};
    assert(lanywhere_list_groups(0,groups,6).reserved==ListStatusProtocol);
    mock_page=(LobbyPage){.count=-2};
    assert(lanywhere_list_groups(0,groups,6).reserved==ListStatusProtocol); // Pending is app-local only.
    mock_page=(LobbyPage){.count=7,.next=LOBBY_PAGE_END};
    assert(lanywhere_list_groups(0,groups,6).reserved==ListStatusProtocol);
    mock_page=(LobbyPage){.count=0,.next=1};
    assert(lanywhere_list_groups(0,groups,6).reserved==ListStatusProtocol);
    mock_result=1;mock_page=(LobbyPage){.count=0,.next=LOBBY_PAGE_END};
    assert(lanywhere_list_groups(0,groups,6).reserved==ListStatusNetwork);
    assert(lanywhere_list_error_status(7)==ListStatusBusy && lanywhere_list_error_status(11)==ListStatusUnavailable);
    assert(lanywhere_list_error_status(13)==ListStatusTimeout && lanywhere_list_error_status(6)==ListStatusPaused);
    ui_set_language(true,false);
    assert(!strcmp(list_error_title(ListStatusBusy),"网络繁忙"));
    assert(!strcmp(list_error_title(ListStatusTimeout),"网络响应超时"));
    assert(!strcmp(ui_text("No compatible rooms found"),"未找到兼容房间"));
    puts("Actual IPC status: valid errors preserved, old failure compatible, invalid pages rejected, empty success distinct; EN/ZH UI verified");
}
'''
with tempfile.TemporaryDirectory(prefix='switch-list-status-') as tmp:
    tmp=Path(tmp); c=tmp/'test.c'; exe=tmp/'test'; c.write_text(harness)
    subprocess.run(shlex.split(os.environ.get('CC','cc'))+['-std=c11','-Wall','-Wextra','-Werror',
        '-I'+str(ROOT/'app/source'),str(c),str(ROOT/'app/source/lobby_model.c'),
        str(ROOT/'app/source/ui_text.c'),'-o',str(exe)],check=True)
    subprocess.run([str(exe)],check=True)
