#!/usr/bin/env python3
"""Build the actual appointments presentation against a Switch IPC/time shim."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='lanywhere-appointments-') as temporary:
    directory = Path(temporary)
    executable = directory / 'appointment-ui'
    subprocess.run(shlex.split(os.environ.get('CC', 'cc')) + [
        '-std=c11', '-Wall', '-Wextra', '-Werror', '-Iapp/tests/appointments_mock', '-Iapp/source',
        'app/tests/appointments_view_test.c', 'app/source/appointments_view.c',
        'app/source/appointments_model.c', 'app/source/game_catalog.c',
        'app/source/ui_text.c', '-o', str(executable)
    ], cwd=root, check=True, timeout=30)
    subprocess.run([str(executable)], cwd=directory, check=True, timeout=10)
