#!/usr/bin/env python3
"""Compile unchanged drawing functions extracted from main.c with explicit sample data.

The extraction avoids emulating console services. It is not a full-app runtime test.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent.parent / 'source'
FUNCTIONS = ['tr_error', 'clean_nickname', 'button_mask', 'add_zone', 'draw_language_control', 'touch_action_at', 'show_matching', 'supports_reserved', 'is_self_network', 'can_enter_game_password', 'room_password_allows_launch', 'match_state_text', 'list_error_title', 'status_pill', 'seats',
             'local_game_info', 'room_catalog_match', 'game_info_has_lcid', 'room_title', 'display_game_icon', 'room_title_note', 'provider_label', 'region_label', 'group_card', 'matching_column', 'network_offline_hint', 'list_error_hint', 'groups_column', 'can_change_visibility', 'can_change_provider', 'can_change_host_region', 'is_self_room_context', 'can_share_game_password', 'provider_column', 'private_column',
             'appointment_entry_available', 'lobby_guide_available', 'side_column', 'draw_password_visibility', 'draw', 'draw_no_service']


def block_end(source, start):
    depth, quote, comment, escaped = 0, '', '', False
    i = start
    while i < len(source):
        c, pair = source[i], source[i:i + 2]
        if comment:
            if comment == '//' and c == '\n': comment = ''
            elif comment == '/*' and pair == '*/': comment = ''; i += 1
        elif quote:
            if escaped: escaped = False
            elif c == '\\': escaped = True
            elif c == quote: quote = ''
        elif pair in ('//', '/*'): comment = pair; i += 1
        elif c in ('"', "'"): quote = c
        elif c == '{': depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0: return i + 1
        i += 1
    raise ValueError('Unclosed source block')


def function(source, name):
    found = re.search(r'^static [^\n]*\b' + name + r'\s*\(', source, re.M)
    if not found: raise ValueError('Missing rendering function: ' + name)
    opening = source.index('{', found.start())
    return source[found.start():block_end(source, opening)]


def typedef(source, name):
    found = re.search(r'typedef struct\s*\{[^}]*\}\s*' + name + r';', source)
    if not found: raise ValueError('Missing type: ' + name)
    return found.group()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve(); output.mkdir(parents=True, exist_ok=True)
    main_source = (SOURCE / 'main.c').read_text()
    prefixes = ('C_', 'MARGIN', 'LIST_W', 'SIDE_X', 'SIDE_W', 'FOOTER_Y', 'TOUCH_', 'NETWORK_ROW_')
    defines = '\n'.join(line for line in main_source.splitlines()
                        if line.startswith('#define ') and line.split()[1].startswith(prefixes))
    extracted = '\n\n'.join(function(main_source, name) for name in FUNCTIONS)
    source = '''#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "gfx.h"
#include "guide.h"
#include "lobby_model.h"
#include "game_catalog.h"
static GameCatalog g_catalog;
#include "relay_config.h"
#include "ui_text.h"
#include "../../common/game_identity_text.h"
static bool g_es, g_zh, g_guide_open, g_language_save_failed;
static int g_guide_page;
#define TR(es,en) ui_tr((es),(en))
enum { StateIdle, StateConnecting, StateInRoom, StateError };
enum { ListUnavailable = -3, ListConnecting = -2, ListOffline = -1 };
''' + '\n'.join(typedef(main_source, name) for name in ['LanywhereStatus', 'GameInfo', 'TouchZone', 'View']) + '\n' + defines + '''
static TouchZone g_zones[24];
static int g_zone_count;
static LobbyRoomId g_rendered_rooms[LOBBY_PAGE_SIZE];
static GameInfo sample_games[2];
static const char *output_path;
static unsigned failures;
static bool appointments_active(void) { return false; }
static void appointments_draw(const GameCatalog *catalog, void (*touch)(int,int,int,int,u64)) { (void)catalog; (void)touch; }
static const GameInfo *game_info(u64 id) {
    if (!id) return NULL;
    if (id == 0x0100ABF008968000ULL) {
        static GameInfo sword = { .id = 0x0100ABF008968000ULL, .install_checked = true };
        return &sword;
    }
    GameInfo *g = &sample_games[id % 2]; g->id = id; g->lcids[0] = id - 100;
    return g;
}
static void save_capture_if_requested(void) { if (!gfx_save_png(output_path)) failures++; }
''' + extracted + '\n' + (HERE / 'main_fixture.inc').read_text()
    flags = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', 'freetype2', 'libpng'], text=True))
    with tempfile.TemporaryDirectory(prefix='main-preview-') as temporary:
        build = Path(temporary); generated = build / 'main_render.c'; generated.write_text(source)
        command = [os.environ.get('CC', 'cc'), '-std=c11', '-Wall', '-Wextra', '-Werror', '-DRELAY_PROFILE_FIXED=1',
                   '-I' + str(HERE), '-I' + str(SOURCE), str(generated), str(SOURCE / 'gfx.c'), str(SOURCE / 'guide.c'),
                   str(SOURCE / 'ui_text.c'), str(SOURCE / 'lobby_model.c'), str(SOURCE / 'game_catalog.c'), str(HERE / 'host_switch.c'),
                   '-o', str(build / 'main-preview')] + flags + ['-lm']
        subprocess.run(command, check=True)
        catalog = build / 'game-catalog.bin'
        subprocess.run([sys.executable, str(SOURCE.parents[1] / 'scripts/compile-title-catalog.py'), str(catalog)], check=True)
        result = subprocess.run([str(build / 'main-preview'), str(output), str(catalog)], check=True, capture_output=True, text=True)
        (output / 'extracted-main-render.c').write_text(source)
    print(result.stdout, end='')
    paths = [SOURCE / name for name in ['main.c', 'gfx.c', 'gfx.h', 'ui_text.c', 'ui_text.h', 'guide.c', 'guide.h',
                                       'lobby_model.c', 'lobby_model.h', 'game_catalog.c', 'game_catalog.h', 'relay_config.h']]
    paths += [SOURCE.parent.parent / 'common' / name for name in ['relay_profile.h', 'regional_relay.h']]
    paths += [HERE / 'main_fixture.inc', HERE / 'render_main.py', HERE / 'host_switch.c', HERE / 'switch.h']
    report = {
        'scope': 'Unchanged main.c drawing functions plus actual gfx.c/ui_text.c, with declared sample rooms and game metadata',
        'switch_hardware_capture': False, 'full_app_runtime_test': False,
        'functions': FUNCTIONS, 'checks': result.stdout.strip(),
        'source_sha256': {os.path.relpath(path, SOURCE.parent): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths},
        'extracted_render_sha256': hashlib.sha256(source.encode()).hexdigest(),
        'images': [path.name for path in sorted(output.glob('main-*.png'))],
        'image_sha256': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(output.glob('main-*.png'))},
    }
    (output / 'preview-report.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__': main()
