#!/usr/bin/env python3

import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location('state_backup', Path(__file__).with_name('state-backup.py'))
STATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(STATE)

INITIAL_ENV = b'LANYWHERE_CAP_GB=100\n'
LOCAL_ENV = b'LANYWHERE_CAP_GB=1\n'


def counter(month, count, encoding='utf-8'):
    return json.dumps({'month': month, 'bytes': count}).encode(encoding)


class StateBackupTest(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.files = self.root / 'state'
        self.files.mkdir()
        paths = {name: (self.files / name, limit) for name, (_, limit) in STATE.PATHS.items()}
        override = patch.object(STATE, 'PATHS', paths)
        override.start()
        self.addCleanup(override.stop)
        self.env = self.files / 'relay.env'
        self.traffic = self.files / 'traffic.json'
        self.month = STATE.current_month()
        self.env.write_bytes(INITIAL_ENV)
        self.traffic.write_bytes(counter(self.month, 100))

    def archive(self, filename, records):
        path = self.root / filename
        with tarfile.open(path, 'w:gz') as output:
            for name, data in records:
                entry = tarfile.TarInfo(name)
                entry.size = len(data)
                output.addfile(entry, io.BytesIO(data))
        return path

    def valid_backup(self):
        path = self.root / 'valid.tar.gz'
        STATE.backup(path)
        return path

    def test_round_trip_preserves_a_private_archive_and_restores_state(self):
        appointments = self.files / 'appointments.json'
        scheduled = b'{"version":2,"events":[{"id":"1","starts":"2000000040","game":"12","app":"34"}]}'
        appointments.write_bytes(scheduled)
        path = self.valid_backup()
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertEqual(STATE.read_archive(path)['traffic.json'], counter(self.month, 100))
        self.env.write_bytes(LOCAL_ENV)
        self.traffic.write_bytes(counter(self.month, 50))
        appointments.unlink()
        STATE.restore(path)
        self.assertEqual(self.env.read_bytes(), INITIAL_ENV)
        self.assertEqual(self.traffic.read_bytes(), counter(self.month, 100))
        self.assertEqual(appointments.read_bytes(), scheduled)

    def test_counter_cannot_move_backwards_or_replace_corrupt_current_state(self):
        path = self.valid_backup()
        old = self.archive('old.tar.gz', [('relay.env', INITIAL_ENV), ('traffic.json', counter('2000-01', 900))])
        self.env.write_bytes(LOCAL_ENV)
        self.traffic.write_bytes(counter(self.month, 120))
        for snapshot in [path, old]:
            with self.assertRaisesRegex(ValueError, 'would decrease'):
                STATE.restore(snapshot)
        self.assertEqual(self.env.read_bytes(), LOCAL_ENV)
        self.assertEqual(self.traffic.read_bytes(), counter(self.month, 120))

        corrupt = b'{"broken":'
        self.traffic.write_bytes(corrupt)
        with self.assertRaisesRegex(ValueError, 'Invalid UTF-8 JSON'):
            STATE.restore(path)
        self.assertEqual(self.env.read_bytes(), LOCAL_ENV)
        self.assertEqual(self.traffic.read_bytes(), corrupt)

    def test_hostile_archives_fail_validation(self):
        variants = {
            'duplicate': [('relay.env', INITIAL_ENV), ('relay.env', INITIAL_ENV)],
            'traversal': [('../relay.env', INITIAL_ENV)],
            'utf16': [('relay.env', INITIAL_ENV), ('traffic.json', counter(self.month, 3, 'utf-16'))],
            'nonfinite': [('relay.env', INITIAL_ENV), ('stats.json', b'{"value": NaN}')],
            'events-null': [('relay.env', INITIAL_ENV), ('stats.json', b'{"events":null}')],
            'days-null-record': [('relay.env', INITIAL_ENV), ('stats.json', b'{"days":[null]}')],
            'day-without-counters': [('relay.env', INITIAL_ENV), ('stats.json', json.dumps({'days': [{'date': self.month + '-01'}]}).encode())],
            'counters-array': [('relay.env', INITIAL_ENV), ('stats.json', b'{"counters":[]}')],
            'games-null': [('relay.env', INITIAL_ENV), ('games.json', b'null')],
            'games-nested': [('relay.env', INITIAL_ENV), ('games.json', b'{"0100000000abc000":{}}')],
        }
        for label, records in variants.items():
            with self.subTest(label=label), self.assertRaises(ValueError):
                STATE.read_archive(self.archive(f'{label}.tar.gz', records))
        symlink = self.root / 'symlink.tar.gz'
        symlink.symlink_to(self.valid_backup())
        with self.assertRaises(OSError):
            STATE.read_archive(symlink)
        inflated = self.root / 'inflated.tar.gz'
        with gzip.open(inflated, 'wb') as file:
            file.write(b'\0' * (STATE.MAX_TAR_BYTES + 1))
        with self.assertRaisesRegex(ValueError, 'Uncompressed backup exceeds'):
            STATE.read_archive(inflated)

    def test_current_dashboard_history_shape_is_preserved(self):
        history = {'counters': {'joins': 2}, 'minutes': [{'t': 123, 'online': 2, 'rooms': 1, 'groups': 1, 'bytes': 100}],
                   'days': [{'date': self.month + '-01', 'peakOnline': 2, 'bytes': 100, 'searchers': 2, 'appUsers': 1,
                             'counters': {'joins': 2}}], 'events': [{'t': 123, 'text': 'started'}]}
        contents = json.dumps(history).encode()
        archive = self.archive('history.tar.gz', [('relay.env', INITIAL_ENV), ('stats.json', contents),
                               ('games.json', b'{"0100000000abc000":"Example"}')])
        self.assertEqual(STATE.read_archive(archive)['stats.json'], contents)

    def test_failure_reverts_prior_writes_and_keeps_unrestored_recovery_files(self):
        path = self.valid_backup()
        real_replace = os.replace
        for fail_rollback in (False, True):
            with self.subTest(fail_rollback=fail_rollback):
                self.env.write_bytes(LOCAL_ENV)
                self.traffic.write_bytes(counter(self.month, 50))
                calls = 0

                def failing_replace(source, destination):
                    nonlocal calls
                    calls += 1
                    if calls == 2 or (fail_rollback and calls == 3):
                        raise OSError('injected replace failure')
                    return real_replace(source, destination)

                with patch.object(STATE.os, 'replace', side_effect=failing_replace):
                    with self.assertRaisesRegex(OSError, 'rollback needs attention' if fail_rollback else 'injected'):
                        STATE.restore(path)
                self.assertEqual(self.traffic.read_bytes(), counter(self.month, 50))
                self.assertEqual(self.env.read_bytes(), INITIAL_ENV if fail_rollback else LOCAL_ENV)
                staged = list(self.files.glob('.switch-online-restore-*'))
                self.assertEqual(len(staged), int(fail_rollback))
                if fail_rollback:
                    self.assertEqual(staged[0].read_bytes(), LOCAL_ENV)


if __name__ == '__main__':
    unittest.main(verbosity=2)
