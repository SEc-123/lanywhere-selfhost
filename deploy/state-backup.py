#!/usr/bin/env python3
"""Back up or restore the stopped Switch Online systemd service state."""

import argparse
from datetime import datetime, timezone
import fcntl
import gzip
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile
import tempfile
import zlib


STATE_DIR = Path('/var/lib/switch-online')
LOCK = Path('/opt/switch-online/.maintenance.lock')
PATHS = {
    'relay.env': (Path('/etc/switch-online/relay.env'), 65536),
    'traffic.json': (STATE_DIR / 'traffic.json', 256),
    'stats.json': (STATE_DIR / 'stats.json', 16 * 1024 * 1024),
    'games.json': (STATE_DIR / 'games.json', 2 * 1024 * 1024),
}
MAX_TAR_BYTES = sum(limit for _, limit in PATHS.values()) + 65536
MAX_ARCHIVE_BYTES = MAX_TAR_BYTES + 65536


def current_month():
    return datetime.now(timezone.utc).strftime('%Y-%m')


def read_optional(path, limit):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    with os.fdopen(fd, 'rb') as file:
        info = os.fstat(file.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
            raise ValueError(f'Invalid file type or size: {path.name}')
        content = file.read(limit + 1)
        if len(content) != info.st_size:
            raise ValueError(f'File changed during read: {path.name}')
    return content


def reject_nonfinite(_value):
    raise ValueError('Non-finite JSON number')


def parse_json(name, data):
    try:
        value = json.loads(data.decode('utf-8'), parse_constant=reject_nonfinite)
    except (UnicodeError, ValueError) as error:
        raise ValueError(f'Invalid UTF-8 JSON: {name}') from error
    if not isinstance(value, dict):
        raise ValueError(f'Expected an object in {name}')
    return value


def traffic_counter(data):
    value = parse_json('traffic.json', data)
    month, count = value.get('month'), value.get('bytes')
    if (not isinstance(month, str) or not re.fullmatch(r'[0-9]{4}-(0[1-9]|1[0-2])', month)
            or month > current_month() or type(count) is not int or not 0 <= count < 2 ** 53):
        raise ValueError('Invalid or future-dated monthly traffic counter')
    return month, count


def valid_count(value):
    return type(value) is int and 0 <= value < 2 ** 53


def validate_history(value):
    def counters(data):
        return isinstance(data, dict) and all(valid_count(count) for count in data.values())

    if 'counters' in value and not counters(value['counters']):
        raise ValueError('Invalid stats.json counters')
    for key, limit in [('minutes', 1440), ('days', 30), ('events', 100)]:
        if key not in value:
            continue
        records = value[key]
        if not isinstance(records, list) or len(records) > limit or any(not isinstance(item, dict) for item in records):
            raise ValueError(f'Invalid stats.json {key}')
        for item in records:
            if key == 'events':
                good = valid_count(item.get('t')) and isinstance(item.get('text'), str)
            elif key == 'minutes':
                good = all(valid_count(item.get(field)) for field in ['t', 'online', 'rooms', 'groups', 'bytes'])
            else:
                good = (isinstance(item.get('date'), str) and
                        re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', item['date']) and counters(item.get('counters')) and
                        all(valid_count(item.get(field)) for field in ['peakOnline', 'bytes', 'searchers', 'appUsers']))
            if not good:
                raise ValueError(f'Invalid stats.json {key} record')


def validate(entries):
    if 'relay.env' not in entries:
        raise ValueError('Backup requires relay.env')
    validator = Path(__file__).with_name('validate-config.cjs')
    result = subprocess.run([os.environ.get('SWITCH_ONLINE_NODE', 'node'), str(validator), '/dev/stdin'], input=entries['relay.env'],
                            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    if result.returncode:
        raise ValueError(result.stderr.decode('utf-8', errors='replace').strip())
    for name, data in entries.items():
        if name == 'traffic.json':
            traffic_counter(data)
        elif name == 'stats.json':
            validate_history(parse_json(name, data))
        elif name == 'games.json':
            names = parse_json(name, data)
            if any(not re.fullmatch(r'[0-9A-Fa-f]{16}', key) or not isinstance(name, str) for key, name in names.items()):
                raise ValueError('Invalid games.json title mapping')


def read_archive(path):
    compressed = read_optional(path, MAX_ARCHIVE_BYTES)
    if compressed is None:
        raise FileNotFoundError(f'Backup archive not found: {path}')
    try:
        with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as source:
            payload = source.read(MAX_TAR_BYTES + 1)
    except (EOFError, zlib.error) as error:
        raise ValueError('Invalid compressed backup archive') from error
    if len(payload) > MAX_TAR_BYTES:
        raise ValueError('Uncompressed backup exceeds allowed size')
    entries = {}
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:') as archive:
        for item in archive:
            if item.name not in PATHS or item.name in entries or not item.isfile():
                raise ValueError('Unexpected or duplicate backup entry')
            limit = PATHS[item.name][1]
            if item.size > limit:
                raise ValueError(f'Backup entry exceeds allowed size: {item.name}')
            with archive.extractfile(item) as file:
                data = file.read(limit + 1)
                if len(data) != item.size:
                    raise ValueError(f'Incomplete backup entry: {item.name}')
                entries[item.name] = data
    validate(entries)
    return entries


def backup(path):
    entries = {name: data for name, (file, limit) in PATHS.items()
               if (data := read_optional(file, limit)) is not None}
    validate(entries)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.switch-online-backup-', delete=False) as file:
            temporary = Path(file.name)
            with tarfile.open(fileobj=file, mode='w:gz') as archive:
                for name, data in entries.items():
                    entry = tarfile.TarInfo(name)
                    entry.size = len(data)
                    entry.mode = 0o600
                    archive.addfile(entry, io.BytesIO(data))
            file.flush()
            os.fsync(file.fileno())
        read_archive(temporary)
        os.link(temporary, path, follow_symlinks=False)
        fsync_directory(path.parent)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def fsync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def staged_file(path, content):
    directory = path.parent.stat()
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.switch-online-restore-', delete=False) as file:
        temporary = Path(file.name)
        try:
            file.write(content)
            file.flush()
            os.fchown(file.fileno(), directory.st_uid, directory.st_gid)
            os.fchmod(file.fileno(), 0o640)
            os.fsync(file.fileno())
        except BaseException:
            temporary.unlink(missing_ok=True)
            raise
    return temporary


def restore(archive):
    entries = read_archive(archive)
    changes = []
    committed = []
    preserve = set()
    try:
        for name, content in entries.items():
            path, limit = PATHS[name]
            previous = read_optional(path, limit)
            if name == 'traffic.json' and previous is not None:
                previous_month, previous_bytes = traffic_counter(previous)
                month, count = traffic_counter(content)
                if previous_month == current_month() and (month != previous_month or count < previous_bytes):
                    raise ValueError('Restore would decrease the current monthly traffic counter')
            new = staged_file(path, content)
            changes.append([path, new, None])
            if previous is not None:
                changes[-1][2] = staged_file(path, previous)
        for path, new, previous in changes:
            os.replace(new, path)
            committed.append((path, previous))
            fsync_directory(path.parent)
    except BaseException as error:
        preserve.update(previous for _, previous in committed if previous is not None)
        failures = []
        for path, previous in reversed(committed):
            try:
                if previous is None:
                    path.unlink(missing_ok=True)
                else:
                    os.replace(previous, path)
                fsync_directory(path.parent)
            except OSError as rollback_error:
                recovery = f', previous file kept at {previous}' if previous is not None and previous.exists() else ''
                failures.append(f'{path}: {rollback_error}{recovery}')
            else:
                preserve.discard(previous)
        if failures:
            raise OSError(f'Restore failed and rollback needs attention: {"; ".join(failures)}') from error
        raise
    finally:
        for _, new, previous in changes:
            new.unlink(missing_ok=True)
            if previous is not None and previous not in preserve:
                previous.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['backup', 'verify', 'restore'])
    parser.add_argument('archive', type=Path)
    args = parser.parse_args()
    try:
        if args.action == 'verify':
            read_archive(args.archive)
        else:
            if os.geteuid() != 0:
                raise ValueError('Run backup and restore as root on the VPS')
            with os.fdopen(os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), 'w') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                state = subprocess.check_output(['systemctl', 'show', '--property=ActiveState', '--value',
                                                 'switch-online.service'], text=True).strip()
                if state not in ('inactive', 'failed'):
                    raise ValueError('Stop switch-online.service before backup or restore')
                if args.action == 'backup':
                    backup(args.archive)
                else:
                    restore(args.archive)
        print(f'Switch Online state {args.action} succeeded')
    except (OSError, ValueError, tarfile.TarError, subprocess.CalledProcessError) as error:
        parser.exit(1, f'Switch Online state: {error}\n')


if __name__ == '__main__':
    main()
