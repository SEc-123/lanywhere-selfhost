#!/usr/bin/env python3
"""Compile the offline application names and observed LCID aliases into a bounded table."""
import argparse
import json
from pathlib import Path
import re
import struct
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
MAX_TITLE = 240
MAX_TABLE = 8 * 1024 * 1024


def identity(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-fA-F]{16}', value):
        raise ValueError('Invalid 16-digit ID')
    key = int(value, 16)
    if key in (0, (1 << 64) - 1):
        raise ValueError('Reserved game ID')
    return key


def clean(text):
    text = unicodedata.normalize('NFC', text or '')
    # Keep printable Unicode, collapse whitespace, omit controls/bidi directives.
    text = ' '.join(''.join(c for c in text if not unicodedata.category(c).startswith('C')).split())
    if len(text.encode('utf-8')) > MAX_TITLE:
        text = text.encode('utf-8')[:MAX_TITLE].decode('utf-8', errors='ignore').rstrip()
    return text


def records(path, key):
    data = json.loads(path.read_text(encoding='utf-8'))
    return data if isinstance(data, list) else data[key]


def compile_catalog(source):
    text = bytearray(b'\0')
    offsets = {'': 0}

    def put(value):
        if value not in offsets:
            offsets[value] = len(text)
            text.extend(value.encode('utf-8') + b'\0')
        return offsets[value]

    names = {}
    for row in records(source / 'catalog.json', 'records'):
        key = identity(row['appid'])
        if key in names:
            raise ValueError(f'Duplicate application: {key:016X}')
        en, zh = clean(row.get('en')), clean(row.get('zh'))
        if en or zh:
            names[key] = en, zh
    if not names or len(names) > 100000:
        raise ValueError('Invalid application record count')
    title_table = b''.join(struct.pack('<QII', key, put(en), put(zh)) for key, (en, zh) in sorted(names.items()))

    aliases = {}
    for row in records(source / 'lcid-mappings.json', 'mappings'):
        lcid = identity(row['lcid'])
        app_ids = sorted({identity(value) for value in row['appids']})
        if lcid in aliases or not app_ids or any(key not in names for key in app_ids):
            raise ValueError(f'Invalid or duplicate LCID mapping: {lcid:016X}')
        ambiguous = row.get('ambiguous', False) or len(app_ids) > 1
        if not ambiguous:
            aliases[lcid] = app_ids[0], 0, 0
        else:
            candidates = {identity(value) for value in row.get('raw_appid_catalog_candidates', [])}
            app_ids = sorted(set(app_ids) | (candidates & names.keys()))
            def label(lang):
                values = [names[key][lang] or names[key][0] or names[key][1] for key in app_ids]
                return clean(' / '.join(dict.fromkeys(values)))
            aliases[lcid] = 0, put(label(0)), put(label(1))
    alias_table = b''.join(struct.pack('<QQII', key, *values) for key, values in sorted(aliases.items()))
    data = struct.pack('<8sIII', b'LYCAT1\0\0', len(names), len(aliases), len(text)) + title_table + alias_table + text
    if len(data) > MAX_TABLE:
        raise ValueError('Game catalogue exceeds the embedded size limit')
    return data


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('output', type=Path)
    parser.add_argument('--source', type=Path, default=ROOT / 'compatibility/title-catalog')
    args = parser.parse_args()
    data = compile_catalog(args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_bytes(data)
