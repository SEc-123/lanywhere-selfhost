#!/usr/bin/env python3
"""Exercise player ZIP packaging in a temporary fixture without Switch hardware."""
import importlib.util
import json
import pathlib
import re
import shutil
import struct
import tempfile
import unicodedata
import zipfile

PROJECT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('package_player', PROJECT / 'scripts/package.py')
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


def fix_text(text):
    if any(c in text for c in 'âÃÂ'):
        try:
            return text.encode('latin1').decode('utf-8')
        except (UnicodeEncodeError, UnicodeDecodeError):
            pass
    return text


def key(text):
    text = fix_text(text).replace('™', '').replace('®', '').replace('©', '')
    text = unicodedata.normalize('NFKD', text).casefold()
    return ''.join(c for c in text if c.isalnum() and not unicodedata.combining(c))


def put(root, name, data):
    target = root / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(data)


def exefs():
    names = b'main\0main.npdm\0'
    return (b'PFS0' + struct.pack('<III', 2, len(names), 0) +
            struct.pack('<QQII', 0, 4, 0, 0) + struct.pack('<QQII', 4, 4, 5, 0) +
            names + b'NSO0META')


def main():
    game_text = (PROJECT / 'compatibility/PLAYER-GAMES.txt').read_text(encoding='utf-8')
    listed = {}
    for line in game_text.splitlines():
        match = re.fullmatch(r'(.+)  \[([NOX](?:/[NOX])*)\]', line)
        if match:
            title, origins = match.groups()
            assert key(title) not in listed, f'duplicate candidate: {title}'
            assert not re.search(r'\b(?:nintendo\s*)?switch\s*2\b', title, re.I)
            listed[key(title)] = set(origins.split('/'))
    xlink_source = PROJECT / 'compatibility/switch1-xlink-catalog.json'
    nt_source = PROJECT / 'compatibility/switch1-ntdeals-us-catalog.json'
    # The public source includes the attributed title list, without bulk third-party snapshots.
    assert xlink_source.exists() == nt_source.exists(), 'Incomplete local catalog fixtures'
    if xlink_source.exists():
        xlink = json.loads(xlink_source.read_text(encoding='utf-8'))['rows']
        nt = json.loads(nt_source.read_text(encoding='utf-8'))['products']
        expected = {}
        def add(title, origin): expected.setdefault(key(title), set()).add(origin)
        for row in xlink:
            if row['in_switch1_candidate_scope'] and row['reported_mode'] == 'local_wireless': add(row['title'], 'X')
        for row in nt:
            if ('local_wireless' in row['collection_pages'] and
                    not re.search(r'\b(?:nintendo\s*)?switch\s*2\b', fix_text(row['title']), re.I)):
                add(row['title'], 'N')
        add('Mario Kart 8 Deluxe', 'O')
        assert listed == expected, 'Candidate list is inconsistent with the stated evidence sources'
    assert f'Candidate titles: {len(listed)}' in game_text
    assert 'Games verified in real two-console matches with this plugin: 0' in game_text
    examples = ('Dying Light: Platinum Edition', 'Mario Kart 8 Deluxe', 'Monster Hunter Rise',
                'Monster Hunter Generations Ultimate', 'Animal Crossing: New Horizons', 'Super Smash Bros. Ultimate',
                'Stardew Valley', "Luigi's Mansion 3", 'Overcooked! 2', 'Diablo III: Eternal Collection',
                'Mario Party Superstars', 'Kirby Fighters 2', 'Pokémon Scarlet', 'Pokémon Violet',
                'Borderlands 2: Game of the Year Edition', 'Dragon Ball FighterZ')
    for name in examples:
        assert key(name) in listed

    with tempfile.TemporaryDirectory(prefix='switch-player-package-') as td:
        fixture = pathlib.Path(td)
        package.ROOT = fixture
        package.SD_ROOT = fixture / 'console/out/sd'
        for name in ('LICENSE', 'console/Atmosphere-libs/LICENSE', 'docs/PLAYER-README.txt',
                     'compatibility/PLAYER-GAMES.txt', 'compatibility/title-catalog/LICENSE.titledb'):
            put(fixture, name, (PROJECT / name).read_bytes())
        shutil.copytree(PROJECT / 'third_party', fixture / 'third_party')
        module = 'console/out/sd/atmosphere/contents/4200000000000010/'
        put(fixture, module + 'exefs.nsp', exefs())
        put(fixture, module + 'flags/boot2.flag', b'')
        put(fixture, module + 'toolbox.json', b'{}')
        nro = bytearray(0x80); nro[0x10:0x14] = b'NRO0'; struct.pack_into('<I', nro, 0x18, len(nro))
        address = '203.0.113.10'
        put(fixture, 'app/lanywhere.nro', nro + address.encode('ascii') + b'\0')
        overlay_path = 'switch/.overlays/lanywhere.ovl'
        put(fixture, 'console/out/sd/' + overlay_path, nro)
        put(fixture, 'console/ldn_mitm/ldn_mitm.elf', b'test\0' + address.encode('ascii') + b'\0')
        entries = package.package_files('fixture', None, 11460, (address, 11460))
        assert len(entries) == 23, f'expected 23 files, found {len(entries)}'
        assert entries[overlay_path] == nro
        assert 'README.txt' in entries and 'GAMES.txt' in entries
        assert 'lanywhere/config.ini' not in entries
        assert all(not name.startswith('/') and '..' not in pathlib.PurePosixPath(name).parts for name in entries)
        guide = entries['README.txt'].decode('utf-8')
        assert '@CONNECTION_' not in guide and '无需输入地址或端口' in guide
        assert 'do not delete or replace the whole existing atmosphere folder' in guide
        assert 'top-right language control' in guide
        assert 'right stick (RS)' in guide and 'selection is remembered' in guide
        assert all(name in guide for name in examples)
        assert entries['GAMES.txt'].decode('utf-8') == game_text
        archive = fixture / 'result/player.zip'
        package.write_zip(archive, entries)
        with zipfile.ZipFile(archive) as z:
            assert z.testzip() is None and set(z.namelist()) == set(entries)
            assert z.read('README.txt') == entries['README.txt']
            assert z.read('GAMES.txt') == entries['GAMES.txt']
            assert z.read(overlay_path) == nro
    print(f'Player package: 23 files including the overlay and catalog license, preserved config, CRC verified; {len(listed)} candidate titles')


if __name__ == '__main__':
    main()
