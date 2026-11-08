#!/usr/bin/env python3
"""Render the actual guide.c + gfx.c using a host framebuffer and substitute fonts."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
SOURCE = HERE.parent.parent / 'source'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    glyph_sources = [SOURCE / 'guide.c', SOURCE / 'ui_text.c', SOURCE / 'main.c']
    inventory = ' '.join(json.loads(match.group()) for path in glyph_sources if path.exists()
                         for match in re.finditer(r'"(?:[^"\\]|\\.)*"', path.read_text()))
    inventory_path = output / 'glyph-inventory.txt'
    inventory_path.write_text(inventory.replace('\n', ' ').replace('\r', ' '))
    flags = shlex.split(subprocess.check_output(['pkg-config', '--cflags', '--libs', 'freetype2', 'libpng'], text=True))
    compiler = os.environ.get('CC', 'cc')
    common = [compiler, '-std=c11', '-Wall', '-Wextra', '-Werror', '-I' + str(HERE), '-I' + str(SOURCE)]
    with tempfile.TemporaryDirectory(prefix='guide-preview-') as temporary:
        build = Path(temporary)
        subprocess.run(common + ['-Dgfx_text=preview_text', '-Dgfx_button=preview_button',
                                '-c', str(SOURCE / 'guide.c'), '-o', str(build / 'guide.o')], check=True)
        subprocess.run(common + [str(SOURCE / 'gfx.c'), str(HERE / 'host_switch.c'), str(HERE / 'guide_preview.c'),
                                str(build / 'guide.o'), '-o', str(build / 'guide-preview')] + flags + ['-lm'], check=True)
        result = subprocess.run([str(build / 'guide-preview'), str(output), str(inventory_path)], check=True, capture_output=True, text=True)
    print(result.stdout, end='')
    paths = [SOURCE / name for name in ['guide.c', 'guide.h', 'gfx.c', 'gfx.h']]
    paths += [path for path in glyph_sources if path not in paths and path.exists()]
    paths += sorted(HERE.glob('*.c')) + [HERE / 'switch.h', HERE / 'render_guide.py']
    report = {
        'scope': 'Actual guide.c and gfx.c rendered with host framebuffer shims and substitute host fonts',
        'switch_hardware_capture': False,
        'fonts_bundled_in_product': False,
        'checks': result.stdout.strip(),
        'source_sha256': {str(path.relative_to(SOURCE.parent)): hashlib.sha256(path.read_bytes()).hexdigest() for path in paths},
        'images': [path.name for path in sorted(output.glob('guide-*.png'))],
        'image_sha256': {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in sorted(output.glob('guide-*.png'))},
    }
    (output / 'preview-report.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
