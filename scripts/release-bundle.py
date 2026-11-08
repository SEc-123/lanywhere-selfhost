#!/usr/bin/env python3
"""Make a reviewable delivery containing the SD ZIP, complete pinned source and evidence."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def git(*args):
    return subprocess.check_output(['git', '-C', str(ROOT), *args])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    version = json.loads((ROOT / 'package.json').read_text())['version']
    provenance = json.loads((ROOT / 'UPSTREAM.json').read_text())
    if provenance['derived_version'] != version:
        raise ValueError('Package and upstream provenance versions differ')
    if git('status', '--porcelain').strip():
        raise ValueError('Commit the validated changes before creating a release bundle')
    report = json.loads((ROOT / 'evidence/test-report.json').read_text())
    if report.get('status') != 'passed':
        raise ValueError('Tests must pass before packaging')
    source_files = git('ls-files', '--cached', '--recurse-submodules', '-z').decode().split('\0')
    entries = {}
    hashes = {}
    for name in filter(None, source_files):
        path = ROOT / name
        if path.is_symlink():
            raise ValueError(f'Source bundle cannot silently dereference a symlink: {name}')
        if not path.is_file():
            raise ValueError(f'Missing pinned source file: {name}')
        payload = path.read_bytes()
        entries[f'02_SOURCE/switch-online/{name}'] = (payload, path.stat().st_mode & 0o777)
        hashes[name] = hashlib.sha256(payload).hexdigest()
    sd_zip = ROOT / 'dist' / f'switch-online-{version}-sd.zip'
    with zipfile.ZipFile(sd_zip) as archive:
        if archive.testzip():
            raise ValueError('SD ZIP checksum failed')
        if 'lanywhere/config.ini' in archive.namelist():
            raise ValueError('General release must preserve existing user configuration')
        binaries = {
            'switch/lanywhere.nro': ROOT / 'app/lanywhere.nro',
            'switch/.overlays/lanywhere.ovl': ROOT / 'console/overlay/overlay.ovl',
            'atmosphere/contents/4200000000000010/exefs.nsp': ROOT / 'console/out/sd/atmosphere/contents/4200000000000010/exefs.nsp',
        }
        for name, path in binaries.items():
            if archive.read(name) != path.read_bytes():
                raise ValueError(f'Stale binary in SD ZIP: {name}')
    entries['01_SD_INSTALL/' + sd_zip.name] = (sd_zip.read_bytes(), 0o644)
    for directory, target in [('compatibility', '03_GAME_LIST'), ('evidence', '04_VERIFICATION')]:
        for name in sorted(hashes):
            path = Path(name)
            if path.parts[0] == directory:
                entries[f'{target}/{path.relative_to(directory).as_posix()}'] = ((ROOT / path).read_bytes(), 0o644)
    start = f'''# Switch 联机 {version}

安装用 `01_SD_INSTALL/{sd_zip.name}`，合并到 SD 根目录后重启虚拟系统。
SD ZIP 顶层 README.txt 是安装说明，GAMES.txt 是完整游戏候选名单。
打开相册 → LANywhere Self-host；首次默认英文，右上角或按 RS 切换中英文。B 进入大厅，R 查看教程。地址已内置，无需填写。LS 选择网络，默认自有网络。

- 公开房：大厅开启公开，再到游戏的本地无线建房。
- 加入公开房：自有网络大厅选房按 A，再回游戏搜索；外部网络按提示进游戏手动搜索，房间未预留。
- 好友私房：仅自有网络/公共社区，大厅 Y → 房主 A 创建／好友 X 输入码，再进游戏联机；LAN Play使用游戏内房间，无邀请码或预留匹配。

源码、许可证及运维文档位于 `02_SOURCE`；测试记录位于 `04_VERIFICATION`。
`SOURCE_SHA256.json` 记录源码提交及校验值。兼容清单是调查资料，不能视为全部真机通过。

服务及跨网络协议已测；名称识别使用本机NS/NACP并按可用性显示房主名称、本机候选或未知。用户已实机确认0.4.6自有网络的《消逝的光芒》和《宝可梦 紫》建房后名称与图标均正确。跨机元数据与双机完整对局仍待验收。实验外部线路不等于所有游戏、所有包大小稳定可用。仅针对兼容的本地无线游戏，不替代官方在线专属后端。
'''
    entries['00_START_HERE.zh-CN.md'] = (start.encode(), 0o644)
    manifest = {
        'version': version,
        'commit': git('rev-parse', 'HEAD').decode().strip(),
        'upstream': provenance,
        'sdZipSha256': hashlib.sha256(sd_zip.read_bytes()).hexdigest(),
        'sourceFiles': hashes,
    }
    entries['SOURCE_SHA256.json'] = ((json.dumps(manifest, ensure_ascii=False, indent=2) + '\n').encode(), 0o644)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=args.output.parent, prefix='.release-', delete=False) as stream:
        staged = Path(stream.name)
    try:
        with zipfile.ZipFile(staged, 'w') as archive:
            for name, (payload, mode) in sorted(entries.items()):
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | mode) << 16
                archive.writestr(info, payload, zipfile.ZIP_DEFLATED, compresslevel=9)
        with zipfile.ZipFile(staged) as archive:
            if archive.testzip():
                raise ValueError('Release ZIP checksum failed')
        staged.chmod(0o644)
        os.replace(staged, args.output)
    finally:
        staged.unlink(missing_ok=True)
    print(json.dumps({'path': str(args.output.resolve()), 'version': version,
        'sourceFiles': len(hashes), 'size': args.output.stat().st_size,
        'sha256': hashlib.sha256(args.output.read_bytes()).hexdigest()}, indent=2))


if __name__ == '__main__':
    main()
