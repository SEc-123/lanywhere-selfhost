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
    'static LobbyPage validate_group_page(', 'static LobbyPage lanywhere_list_groups(',
    'static bool unified_ipc_missing(', 'static LobbyPage lanywhere_list_unified(', 'static const char *list_error_title(',
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
typedef int Result;
#define R_FAILED(r) ((r) != 0)
#define R_SUCCEEDED(r) ((r) == 0)
#define MAKERESULT(module, description) ((module) | ((description) << 9))
#define RELAY_PROFILE_FIXED 1
#define TR(es,en) ui_tr((es),(en))
enum { SfBufferAttr_HipcMapAlias = 1, SfBufferAttr_Out = 2 };
typedef struct { unsigned buffer_attrs[1]; struct { void *pointer; size_t size; } buffers[1]; } Dispatch;
static LobbyPage mock_page;
static UnifiedPage mock_unified;
static LobbyUnifiedGroup mock_rows[LOBBY_PAGE_SIZE];
static int mock_result, mock_unified_result, legacy_calls, unified_calls;
static UnifiedRoomsRequest last_unified;

static Result dispatch(unsigned command, const void *request, size_t request_size,
                       void *response, size_t response_size, Dispatch io)
{
    assert(io.buffer_attrs[0] == (SfBufferAttr_HipcMapAlias | SfBufferAttr_Out));
    if (command == UNIFIED_LOBBY_IPC_LIST) {
        assert(request_size == sizeof(last_unified) && response_size == sizeof(mock_unified));
        assert(io.buffers[0].size == sizeof(mock_rows));
        memcpy(&last_unified, request, sizeof(last_unified));
        memcpy(response, &mock_unified, sizeof(mock_unified));
        memcpy(io.buffers[0].pointer, mock_rows, sizeof(mock_rows));
        ++unified_calls;
        return mock_unified_result;
    }
    assert(command == LANYWHERE_IPC_LIST_PAGE_COMMAND && request_size == sizeof(u32));
    assert(response_size == sizeof(mock_page));
    memcpy(response, &mock_page, sizeof(mock_page));
    ++legacy_calls;
    return mock_result;
}
#define serviceDispatchInOut(service,command,request,page,...) \
    dispatch(command, &(request), sizeof(request), &(page), sizeof(page), (Dispatch){__VA_ARGS__})
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
    mock_result=0; mock_page=(LobbyPage){.count=0,.next=LOBBY_PAGE_END};
    enum LobbyDiscovery discovery=LobbyDiscoveryUnknown;
    UnifiedPage info={0};
    LobbySource sources[LOBBY_PAGE_SIZE]={{0}};
    const UnifiedRoomsRequest request={.offset=6,.snapshot=91};
    int before=legacy_calls;
    mock_unified_result=MAKERESULT(3, 221); // Same description, different module. No fallback.
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery).reserved==ListStatusNetwork);
    assert(legacy_calls==before && discovery==LobbyDiscoveryUnknown);

    mock_unified_result=0;
    mock_unified=(UnifiedPage){.count=-1,.next=UNIFIED_LOBBY_END,.status=ListStatusTimeout};
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery).reserved==ListStatusTimeout);
    assert(legacy_calls==before && discovery==LobbyDiscoveryUnified);
    mock_unified.status=UnifiedListStale;
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery).reserved==UnifiedListStale);
    assert(legacy_calls==before && discovery==LobbyDiscoveryUnified);

    mock_unified=(UnifiedPage){.count=2,.next=8,.snapshot=91,.available=3,.total=13};
    mock_rows[0]=(LobbyUnifiedGroup){.group={.code="ABC234",.game_id=42},.provider="self"};
    mock_rows[1]=(LobbyUnifiedGroup){.group={.code="ABC234",.game_id=42},.provider="lanplay-nl"};
    out=lanywhere_list_unified(request,groups,sources,&info,&discovery);
    assert(out.count==2 && out.next==8 && out.capabilities&UNIFIED_LOBBY_CAPABILITY);
    assert(info.available==3 && info.total==13 && info.snapshot==91);
    assert(last_unified.offset==6 && last_unified.snapshot==91);
    assert(!strcmp(sources[0],"self") && !strcmp(sources[1],"lanplay-nl"));
    assert(lobby_room_index_on(lobby_room_id_on(&groups[0],"lanplay-nl"),groups,sources,2)==1);
    mock_unified.snapshot=92;
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery).reserved==ListStatusProtocol);
    mock_unified.snapshot=91;
    strcpy(mock_rows[1].provider,"unknown");
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery).reserved==ListStatusProtocol);
    assert(legacy_calls==before && discovery==LobbyDiscoveryUnified);

    mock_unified=(UnifiedPage){.count=-1,.next=UNIFIED_LOBBY_END,.status=ListStatusUpdate};
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery).count==0);
    assert(legacy_calls==before+1 && discovery==LobbyDiscoveryLegacy);
    mock_unified_result=MAKERESULT(10,221);
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery).count==0);
    assert(legacy_calls==before+2 && discovery==LobbyDiscoveryLegacy && unified_calls==8);
    puts("Actual IPC status: unified identities and snapshot, partial sources, explicit-only legacy fallback and EN/ZH passed.");
}
'''
with tempfile.TemporaryDirectory(prefix='switch-list-status-') as tmp:
    tmp=Path(tmp); c=tmp/'test.c'; exe=tmp/'test'; c.write_text(harness)
    subprocess.run(shlex.split(os.environ.get('CC','cc'))+['-std=c11','-Wall','-Wextra','-Werror',
        '-I'+str(ROOT/'app/source'),str(c),str(ROOT/'app/source/lobby_model.c'),
        str(ROOT/'app/source/ui_text.c'),'-o',str(exe)],check=True)
    subprocess.run([str(exe)],check=True)
