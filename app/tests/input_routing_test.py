#!/usr/bin/env python3
"""Compile exact current main.c input slices with host-only effect counters.

No Switch SDK, device, network or renderer is used. Source anchors deliberately
fail closed if main.c is refactored; the routing decisions are never duplicated
in this fixture. CC may select the same native compiler used by other app tests.
"""
import hashlib
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'app/source/main.c'


def between(source, start, stop, after=0):
    begin = source.index(start, after)
    end = source.index(stop, begin + len(start))
    return source[begin:end]


def function(source, signature):
    start = source.index(signature)
    # Mask literals/comments without changing offsets, so translated strings and
    # comments containing braces cannot corrupt the extracted function body.
    masked = re.sub(r'//[^\n]*|/\*.*?\*/|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'',
                    lambda match: ' ' * len(match.group()), source, flags=re.S)
    opening = masked.index('{', start)
    depth = 0
    for pos in range(opening, len(masked)):
        depth += (masked[pos] == '{') - (masked[pos] == '}')
        if depth == 0:
            return source[start:pos + 1]
    raise ValueError('Unclosed source function: ' + signature)


def main():
    source = SOURCE.read_text(encoding='utf-8')
    loop = source.index('int main(int argc, char **argv)')
    status = between(source, 'typedef struct {\n    u8 state,', '//', source.index('// --- servicio'))
    # Keep only the declaration and state enum, not following IPC helpers.
    status = status[:status.index('enum { StateIdle') + len(status[status.index('enum { StateIdle'):].split(';', 1)[0]) + 1]
    view_start = source.index('typedef struct {\n    LanywhereStatus st;')
    view = source[view_start:source.index('} View;', view_start) + len('} View;')]
    pieces = {
        'STATUS': status,
        'VIEW': view,
        'PREDICATES': '\n'.join(function(source, signature) for signature in (
            'static bool show_matching(', 'static bool supports_reserved(', 'static bool is_self_network(',
            'static bool is_self_room_context(', 'static bool can_change_visibility(', 'static bool can_change_provider(', 'static bool can_change_host_region(', 'static bool can_share_game_password(',
             'static LobbyRoomId room_password_target(', 'static bool can_enter_game_password(',
            'static bool appointment_entry_available(', 'static bool lobby_guide_available(')),
        'CLEAN_NICKNAME': function(source, 'static bool clean_nickname('),
        'PLUS': between(source, '        if (down & HidNpadButton_Plus)', '        u64 now = now_ms();', loop),
        'GUIDE_INPUT': function(source, 'static bool guide_input('),
        'FIND_APPOINTMENT_ROOMS': function(source, 'static void open_appointment_rooms('),
        'SELECT_ROOM': function(source, 'static void select_room('),
        'START_SCREEN': between(source, '    if (appointment_entry_available(&v)) appointments_open(thread_ok, false);',
                                '    View last = {0};', loop),
        'GUIDE': between(source, '        if (guide_input(&v, down)) {', '        if (appointments_active()) {', loop) +
                 between(source, '        if (v.provider_panel) {', '        const int shown =', loop),
        'SELECTION': between(source, '        const int shown =', '#if !RELAY_PROFILE_FIXED', loop),
        'BUSINESS': between(source, '        if (v.external_confirm) {',
                            '        if (down & (HidNpadButton_A | HidNpadButton_X | HidNpadButton_Y | HidNpadButton_B))', loop),
        'TOUCH': function(source, 'static void add_zone(') + '\n' + function(source, 'static u64 touch_action_at('),
        'NO_SERVICE': function(source, 'static void draw_no_service(') + '\n' + function(source, 'static void no_service('),
        'LANG_CONTROL': function(source, 'static void draw_language_control('),
        'PAGE_LIMIT': re.search(r'^#define MAX_PAGE_HISTORY\s+\d+$', source, re.M).group(),
    }
    template = Path(__file__).with_name('input_routing_harness.c.in').read_text(encoding='utf-8')
    for name, content in pieces.items():
        marker = '/* SOURCE_' + name + ' */'
        if template.count(marker) != 1:
            raise ValueError('Missing/duplicate fixture marker: ' + marker)
        template = template.replace(marker, content)
    if '/* SOURCE_' in template:
        raise ValueError('Unreplaced source marker')
    with tempfile.TemporaryDirectory(prefix='lanywhere-input-routing-') as temporary:
        directory = Path(temporary)
        generated = directory / 'input-routing.c'
        binary = directory / 'input-routing'
        generated.write_text(template, encoding='utf-8')
        compiler = shlex.split(os.environ.get('CC', 'cc'))
        if not compiler:
            raise ValueError('CC is empty')
        subprocess.run(compiler + ['-std=c11', '-Wall', '-Wextra', '-Werror',
                       '-I' + str(ROOT / 'app/tests/preview'), '-I' + str(ROOT / 'app/source'),
                       str(generated), str(ROOT / 'app/source/lobby_model.c'), '-o', str(binary)], check=True, timeout=30)
        subprocess.run([str(binary)], check=True, timeout=10)
    print('Input source snapshot SHA-256:', hashlib.sha256(source.encode()).hexdigest())
    print('Host input routing only; no Switch hardware, graphics acceptance, or network test.')


if __name__ == '__main__':
    main()
