#!/usr/bin/env python3
"""Exercise the real password view worker and host keyboard against typed IPC mocks."""
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix="lanywhere-room-password-") as work:
    executable = Path(work) / "test"
    subprocess.run(shlex.split(os.environ.get("CC", "cc")) + [
        "-std=c11", "-Wall", "-Wextra", "-Werror",
        "-I" + str(root / "app/tests/room_password_mock"),
        "-I" + str(root / "app/source"),
        str(root / "app/tests/room_password_test.c"),
        str(root / "app/source/room_password.c"),
        str(root / "app/source/lobby_model.c"),
        str(root / "app/source/ui_text.c"),
        "-o", str(executable),
    ], check=True)
    subprocess.run([str(executable)], check=True)
