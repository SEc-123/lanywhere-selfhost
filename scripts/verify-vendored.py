#!/usr/bin/env python3
"""Check vendored SDK sources against the imported, verified source snapshot."""
import hashlib
import json
from pathlib import Path, PurePosixPath
import sys

root = Path(__file__).resolve().parent.parent
allowed = {'console/Atmosphere-libs', 'console/libtesla'}
requested = set(sys.argv[1:]) or allowed
if not requested <= allowed:
    raise SystemExit('Unknown vendored component')
manifest = json.loads((root / 'evidence/vendor-source-sha256.json').read_text())['files']
count = 0
for name, expected in manifest.items():
    if not any(name.startswith(component + '/') for component in requested):
        continue
    relative = PurePosixPath(name)
    if relative.is_absolute() or '..' in relative.parts:
        raise SystemExit('Unsafe vendor manifest path')
    path = root / name
    if path.is_symlink() or not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != expected:
        raise SystemExit('Vendored source differs from imported snapshot: ' + name)
    count += 1
if not count:
    raise SystemExit('Empty vendor snapshot')
print(f'Verified {count} vendored source files against the imported snapshot')
