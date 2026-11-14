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
    'static bool unified_ipc_missing(', 'static bool unified_list_requires_fallback(', 'static LobbyPage lanywhere_list_unified(', 'static const char *list_error_title(',
    'static const char *network_offline_hint(', 'static const char *list_error_hint('))
pieces = source[source.index('enum LobbyDirectory {'):source.index('static LobbyPage lanywhere_list_unified(')] + pieces
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
static int mock_regional_result, regional_calls;
static UnifiedPage mock_regional;
static int mock_community_result, community_calls;
static UnifiedPage mock_community;
static UnifiedRoomsRequest last_unified;

static Result dispatch(unsigned command, const void *request, size_t request_size,
                       void *response, size_t response_size, Dispatch io)
{
    assert(io.buffer_attrs[0] == (SfBufferAttr_HipcMapAlias | SfBufferAttr_Out));
    if (command == UNIFIED_LOBBY_IPC_LIST || command == REGIONAL_LOBBY_IPC_LIST || command == COMMUNITY_LOBBY_IPC_LIST) {
        assert(request_size == sizeof(last_unified) && response_size == sizeof(mock_unified));
        assert(io.buffers[0].size == sizeof(mock_rows));
        memcpy(&last_unified, request, sizeof(last_unified));
        memcpy(io.buffers[0].pointer, mock_rows, sizeof(mock_rows));
        if (command == COMMUNITY_LOBBY_IPC_LIST) {
            memcpy(response, &mock_community, sizeof(mock_community));
            ++community_calls;
            return mock_community_result;
        }
        if (command == REGIONAL_LOBBY_IPC_LIST) {
            memcpy(response, &mock_regional, sizeof(mock_regional));
            ++regional_calls;
            return mock_regional_result;
        }
        memcpy(response, &mock_unified, sizeof(mock_unified));
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
    enum LobbyDirectory regional=LobbyDirectoryUnified;
    int before=legacy_calls;
    mock_unified_result=MAKERESULT(3, 221); // Same description, different module. No fallback.
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional).reserved==ListStatusNetwork);
    assert(legacy_calls==before && discovery==LobbyDiscoveryUnknown);

    mock_unified_result=0;
    mock_unified=(UnifiedPage){.count=-1,.next=UNIFIED_LOBBY_END,.status=ListStatusTimeout};
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional).reserved==ListStatusTimeout);
    assert(legacy_calls==before && discovery==LobbyDiscoveryUnified);
    mock_unified.status=UnifiedListStale;
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional).reserved==UnifiedListStale);
    assert(legacy_calls==before && discovery==LobbyDiscoveryUnified);

    mock_unified=(UnifiedPage){.count=2,.next=8,.snapshot=91,.available=3,.total=13};
    mock_rows[0]=(LobbyUnifiedGroup){.group={.code="ABC234",.game_id=42},.provider="self"};
    mock_rows[1]=(LobbyUnifiedGroup){.group={.code="ABC234",.game_id=42},.provider="lanplay-nl"};
    out=lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional);
    assert(out.count==2 && out.next==8 && out.capabilities&UNIFIED_LOBBY_CAPABILITY);
    assert(info.available==3 && info.total==13 && info.snapshot==91);
    assert(last_unified.offset==6 && last_unified.snapshot==91);
    assert(!strcmp(sources[0],"self") && !strcmp(sources[1],"lanplay-nl"));
    assert(lobby_room_index_on(lobby_room_id_on(&groups[0],"lanplay-nl"),groups,sources,2)==1);
    mock_unified.snapshot=92;
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional).reserved==ListStatusProtocol);
    mock_unified.snapshot=91;
    strcpy(mock_rows[1].provider,"unknown");
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional).reserved==ListStatusProtocol);
    assert(legacy_calls==before && discovery==LobbyDiscoveryUnified);

    const UnifiedRoomsRequest first={0};
    strcpy(mock_rows[1].provider, REGION_PROVIDER_EU);
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional).reserved==ListStatusProtocol);
    regional=LobbyDirectoryRegional;
    mock_regional=(UnifiedPage){.count=2,.next=UNIFIED_LOBBY_END,.snapshot=91,.available=4,.total=14};
    out=lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional);
    assert(out.count==2 && out.capabilities&REGIONAL_LOBBY_CAPABILITY && info.total==14);
    assert(!strcmp(sources[0],"self") && !strcmp(sources[1],REGION_PROVIDER_EU));
    assert(lobby_room_index_on(lobby_room_id_on(&groups[0],REGION_PROVIDER_EU),groups,sources,2)==1);
    assert(regional_calls==1 && regional);
    strcpy(mock_rows[1].provider,REGION_PROVIDER_COMMUNITY);
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional).reserved==ListStatusProtocol);
    regional=LobbyDirectoryCommunity;
    mock_community=mock_regional;
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional).count==2 && community_calls==1);
    assert(!strcmp(sources[1],REGION_PROVIDER_COMMUNITY));
    mock_rows[1].group.room_access=RoomAccessHidden;
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional).reserved==ListStatusProtocol);
    mock_rows[1].group.room_access=RoomAccessNone;
    enum LobbyDirectory legacy_directory=LobbyDirectoryUnified;
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery,&legacy_directory).reserved==ListStatusProtocol);
    mock_community_result=MAKERESULT(10,221);
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional).reserved==UnifiedListStale);
    assert(regional==LobbyDirectoryRegional);
    mock_regional_result=MAKERESULT(3,221);
    int before_unified=unified_calls;
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional).reserved==ListStatusNetwork);
    assert(regional && unified_calls==before_unified);
    mock_regional_result=MAKERESULT(10,221);
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional).reserved==UnifiedListStale);
    assert(!regional && unified_calls==before_unified);
    regional=LobbyDirectoryRegional;
    mock_regional_result=0;
    mock_regional=(UnifiedPage){.count=-1,.next=UNIFIED_LOBBY_END,.status=ListStatusUpdate};
    mock_unified=(UnifiedPage){.count=0,.next=UNIFIED_LOBBY_END,.snapshot=92,.available=1,.total=13};
    out=lanywhere_list_unified(first,groups,sources,&info,&discovery,&regional);
    assert(out.count==0 && !(out.capabilities&REGIONAL_LOBBY_CAPABILITY) && info.snapshot==92);
    assert(!regional && discovery==LobbyDiscoveryUnified && unified_calls==before_unified+1);

    mock_unified=(UnifiedPage){.count=-1,.next=UNIFIED_LOBBY_END,.status=ListStatusUpdate};
    assert(lanywhere_list_unified(request,groups,sources,&info,&discovery,&regional).reserved==UnifiedListStale);
    assert(legacy_calls==before && discovery==LobbyDiscoveryLegacy);
    assert(lanywhere_list_unified(first,groups,sources,&info,&discovery,&regional).count==0);
    assert(legacy_calls==before+1 && discovery==LobbyDiscoveryLegacy);
    mock_unified_result=MAKERESULT(10,221);
    assert(lanywhere_list_unified(first,groups,sources,&info,&discovery,&regional).count==0);
    assert(legacy_calls==before+2 && discovery==LobbyDiscoveryLegacy);
    puts("Actual IPC status: regional and unified identities, snapshot reset, explicit-only fallback, and EN/ZH passed.");
}
'''
with tempfile.TemporaryDirectory(prefix='switch-list-status-') as tmp:
    tmp=Path(tmp); c=tmp/'test.c'; exe=tmp/'test'; c.write_text(harness)
    subprocess.run(shlex.split(os.environ.get('CC','cc'))+['-std=c11','-Wall','-Wextra','-Werror',
        '-I'+str(ROOT/'app/source'),str(c),str(ROOT/'app/source/lobby_model.c'),
        str(ROOT/'app/source/ui_text.c'),'-o',str(exe)],check=True)
    subprocess.run([str(exe)],check=True)
