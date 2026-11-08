#!/usr/bin/env python3
"""Download and extract the pinned Linux SDK beside this script."""
import concurrent.futures
import hashlib
import json
import os
import pathlib
import platform
import subprocess


def checksum(path):
    with path.open('rb') as file:
        return hashlib.file_digest(file, 'sha256').hexdigest()


def fetch(package, cache):
    path = cache / package['filename']
    if path.is_file() and checksum(path) == package['sha256']:
        return path
    partial = cache / (path.name + '.partial')
    subprocess.run([
        'curl', '--fail', '--location', '--silent', '--show-error',
        '--connect-timeout', '15', '--max-time', '120', '--retry', '2',
        '--output', str(partial), package['url'],
    ], check=True)
    if checksum(partial) != package['sha256']:
        raise RuntimeError(f'SHA-256 mismatch for {path.name}')
    os.replace(partial, path)
    return path


def install_libnx(source, source_dir, devkitpro):
    if not source_dir.exists():
        subprocess.run(['git', 'init', str(source_dir)], check=True)
        subprocess.run([
            'git', '-C', str(source_dir), 'fetch', '--depth', '1', source['url'], source['commit'],
        ], check=True)
        subprocess.run(['git', '-C', str(source_dir), 'checkout', '--detach', 'FETCH_HEAD'], check=True)
    actual = subprocess.check_output(['git', '-C', str(source_dir), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != source['commit']:
        raise RuntimeError(f'{source_dir} has unexpected revision {actual}')
    devkita64 = devkitpro / 'devkitA64'
    environment = os.environ.copy()
    environment['DEVKITPRO'] = str(devkitpro)
    environment['DEVKITA64'] = str(devkita64)
    environment['PATH'] = os.pathsep.join([
        str(devkita64 / 'bin'), str(devkitpro / 'tools' / 'bin'), environment.get('PATH', ''),
    ])
    jobs = os.environ.get('LANYWHERE_BUILD_JOBS', '4')
    subprocess.run(['make', '-C', str(source_dir), f'-j{jobs}'], env=environment, check=True)
    subprocess.run(['make', '-C', str(source_dir), 'install'], env=environment, check=True)


def main():
    if platform.system() != 'Linux' or platform.machine() != 'x86_64':
        raise SystemExit('This package list targets Linux x86_64 only.')
    base = pathlib.Path(__file__).resolve().parent
    manifest = json.loads((base / 'packages.lock.json').read_text())
    packages = manifest['packages']
    cache = base / 'downloads'
    sysroot = base / 'sysroot'
    cache.mkdir(exist_ok=True)
    sysroot.mkdir(exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as workers:
        paths = list(workers.map(lambda package: fetch(package, cache), packages))
    for path in paths:
        subprocess.run([
            'tar', '-xf', str(path), '-C', str(sysroot), '--no-same-owner',
            '--exclude=.PKGINFO', '--exclude=.MTREE', '--exclude=.BUILDINFO', '--exclude=.INSTALL',
        ], check=True)
    devkitpro = sysroot / 'opt/devkitpro'
    install_libnx(manifest['libnx_source'], base / 'libnx-upstream', devkitpro)
    print(devkitpro)


if __name__ == '__main__':
    main()
