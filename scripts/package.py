#!/usr/bin/env python3
"""Package compiled Switch Online files as an SD card ZIP."""

import argparse
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import stat
import struct
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parent.parent
TITLE_DIR = Path("atmosphere/contents/4200000000000010")
SD_ROOT = ROOT / "console/out/sd"
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]


def server_ipv4(value):
    try:
        address = ipaddress.IPv4Address(value)
    except ipaddress.AddressValueError as error:
        raise argparse.ArgumentTypeError("use the VPS public IPv4 address") from error
    if not address.is_global or address.is_multicast or address.is_reserved:
        raise argparse.ArgumentTypeError("use a public, unicast IPv4 address")
    return address


def relay_port(value):
    try:
        port = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("port must be a decimal integer") from error
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def valid_nro(data):
    if len(data) < 0x80 or data[0x10:0x14] != b"NRO0":
        return False
    size = struct.unpack_from("<I", data, 0x18)[0]
    return 0x80 <= size <= len(data)


def valid_exefs(data):
    if len(data) < 16 or data[:4] != b"PFS0":
        return False
    count, names_size = struct.unpack_from("<II", data, 4)
    names_start = 16 + count * 24
    data_start = names_start + names_size
    if count < 2 or data_start > len(data):
        return False

    expected = {b"main": b"NSO0", b"main.npdm": b"META"}
    for index in range(count):
        offset, size, name_offset = struct.unpack_from("<QQI", data, 16 + index * 24)
        start = data_start + offset
        if name_offset >= names_size or start + size > len(data):
            return False
        name_start = names_start + name_offset
        name_end = data.find(b"\0", name_start, data_start)
        if name_end == -1:
            return False
        name = data[name_start:name_end]
        if name in expected:
            if size < 4 or data[start:start + 4] != expected[name]:
                return False
            del expected[name]
    return not expected


def read_entry(path, check=None):
    if not path.is_file():
        raise ValueError(f"Missing {path.relative_to(ROOT)}. Build the app and sysmodule first.")
    data = path.read_bytes()
    if check is not None and not check(data):
        raise ValueError(f"Invalid Switch binary: {path.relative_to(ROOT)}")
    return data


def fixed_profile():
    profile = (ROOT / 'common/relay_profile.h').read_text(encoding='utf-8')
    if not re.search(r'^#define RELAY_PROFILE_FIXED\s+1$', profile, re.MULTILINE):
        return None
    address = re.search(r'^#define RELAY_PROFILE_IPV4\s+"([0-9.]+)"$', profile, re.MULTILINE)
    port = re.search(r'^#define RELAY_PROFILE_PORT\s+(\d+)$', profile, re.MULTILINE)
    if address is None or port is None:
        raise ValueError('Missing IPv4 or port in the fixed relay profile')
    return str(server_ipv4(address[1])), relay_port(port[1])


def optional_profile(name):
    profile = (ROOT / 'common/relay_profile.h').read_text(encoding='utf-8')
    address = re.search(rf'^#define RELAY_PROFILE_{name}_IPV4\s+"([^"]*)"$', profile, re.MULTILINE)
    if not address or not address[1]:
        return None
    port = re.search(rf'^#define RELAY_PROFILE_{name}_PORT\s+(\d+)$', profile, re.MULTILINE)
    if port is None:
        raise ValueError(f'Missing port in the {name} relay profile')
    return str(server_ipv4(address[1])), relay_port(port[1])


def package_files(version, server, port, embedded):
    entries = {
        (TITLE_DIR / "exefs.nsp").as_posix(): read_entry(SD_ROOT / TITLE_DIR / "exefs.nsp", valid_exefs),
        (TITLE_DIR / "flags/boot2.flag").as_posix(): read_entry(SD_ROOT / TITLE_DIR / "flags/boot2.flag"),
        (TITLE_DIR / "toolbox.json").as_posix(): read_entry(SD_ROOT / TITLE_DIR / "toolbox.json"),
        "switch/lanywhere.nro": read_entry(ROOT / "app/lanywhere.nro", valid_nro),
        "switch/.overlays/lanywhere.ovl": read_entry(SD_ROOT / "switch/.overlays/lanywhere.ovl", valid_nro),
        "lanywhere/licenses/LANywhere.txt": read_entry(ROOT / "LICENSE"),
        "lanywhere/licenses/Atmosphere-libs.txt": read_entry(ROOT / "console/Atmosphere-libs/LICENSE"),
        "lanywhere/licenses/TitleDB-MIT.txt": read_entry(ROOT / "compatibility/title-catalog/LICENSE.titledb"),
    }
    if embedded is not None:
        address, _ = embedded
        needle = address.encode('ascii') + b'\0'
        module = read_entry(ROOT / 'console/ldn_mitm/ldn_mitm.elf')
        if needle not in entries['switch/lanywhere.nro'] or needle not in module:
            raise ValueError('Rebuild both Switch binaries with the fixed relay profile before packaging')
        used_endpoints = {embedded}
        for key, label in [('EU', 'Europe'), ('COMMUNITY', 'community')]:
            endpoint = optional_profile(key)
            if endpoint is None:
                continue
            if endpoint in used_endpoints:
                raise ValueError(f'The {label} relay must use its own endpoint')
            used_endpoints.add(endpoint)
            needle = endpoint[0].encode('ascii') + b'\0'
            if needle not in entries['switch/lanywhere.nro'] or needle not in module:
                raise ValueError(f'Rebuild both Switch binaries with the {label} relay profile before packaging')
    elif optional_profile('EU') is not None:
        raise ValueError('Europe relay selection requires the managed fixed relay profile')
    elif server is not None:
        entries["lanywhere/config.ini"] = f"server={server}\nport={port}\npublic=1\n".encode("ascii")
    notices = ROOT / "third_party"
    if notices.is_dir():
        for notice in sorted(notices.rglob("*")):
            if notice.is_file():
                entries["lanywhere/third_party/" + notice.relative_to(notices).as_posix()] = notice.read_bytes()

    setup = "在应用中选择服务器设置，输入自有云服务器公网 IPv4 和端口。"
    if embedded is not None:
        setup = (
            "应用启动后会自动连接内置的联机服务器，显示大厅或连接状态。\n"
            "玩家无需填写 IP 或端口。原有昵称和网络设置会保留。"
        )
    elif server is not None:
        setup = f"打开应用，确认服务器显示为 {server}:{port}。"
    entries["lanywhere/INSTALL.zh-CN.txt"] = (
        f"Switch Online {version}（Beta，跨网真机验收待完成）\n\n"
        "安装：将包内文件合并到 SD 卡根目录，保留游戏、存档和 config.ini，重启进入虚拟系统。\n"
        "从相册打开 LANywhere Self-host。启动后显示约局，B 进入房间大厅。\n"
        f"{setup}\n"
        "按 RS 切换中英文，右下角可查看教程。\n"
        "大厅按 Y 选建房线路（默认自有网络），再到游戏的“本地无线”建房。\n"
        "大厅按 A 选房，打开游戏后搜索“本地无线”。连接跟随房间来源。\n"
        "社区 · LANywhere：双方直连公共节点，密码在游戏里用。\n"
        "Switch LAN Play：通过自有网络加入大厅里列出的房间。\n"
        "约局提醒和大厅密码分享请用自有网络。完整说明见根目录 README.txt。\n\n"
        "上游源码及作者信息 https://github.com/augustocco/lanywhere\n"
    ).encode("utf-8")
    if embedded is not None:
        connection_zh = "   服务器地址已内置，无需输入地址或端口。原有昵称和网络设置会保留。"
        connection_en = "   The server is built in; no address or port setup is needed. Existing preferences are kept."
    elif server is not None:
        connection_zh = "   服务器配置随包提供，复制时请留意保留已有昵称和偏好。"
        connection_en = "   Server configuration is included; preserve any existing nickname and preferences."
    else:
        connection_zh = "   请先在应用中设置服务器地址和端口。"
        connection_en = "   Configure a server address and port in the app first."
    player_readme = read_entry(ROOT / "docs/PLAYER-README.txt").decode("utf-8")
    entries["README.txt"] = player_readme.replace("@CONNECTION_ZH@", connection_zh).replace("@CONNECTION_EN@", connection_en).encode("utf-8")
    entries["GAMES.txt"] = read_entry(ROOT / "compatibility/PLAYER-GAMES.txt")
    return entries


def write_zip(path, entries):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".sd-package-", delete=False) as stream:
        staging = Path(stream.name)
    try:
        with zipfile.ZipFile(staging, "w") as archive:
            for name, data in sorted(entries.items()):
                info = zipfile.ZipInfo(name)
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | 0o644) << 16
                archive.writestr(info, data, zipfile.ZIP_DEFLATED, compresslevel=9)
        with zipfile.ZipFile(staging) as archive:
            invalid = archive.testzip()
            if invalid is not None:
                raise ValueError(f"ZIP checksum verification failed for {invalid}")
        staging.chmod(0o644)
        os.replace(staging, path)
    finally:
        staging.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    configuration = parser.add_mutually_exclusive_group(required=True)
    configuration.add_argument("--embedded", action="store_true", help="package binaries with the fixed relay profile compiled in")
    configuration.add_argument("--server", type=server_ipv4, help="preconfigure a public IPv4 address")
    configuration.add_argument("--unconfigured", action="store_true", help="leave the relay unset for first launch")
    parser.add_argument("--port", type=relay_port, help="relay port for --server (default: 11460)")
    parser.add_argument("--version", default=VERSION)
    parser.add_argument("--output", type=Path, help="SD card ZIP output path")
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", args.version):
        parser.error("version must use letters, digits, periods, underscores or hyphens")
    if args.server is None and args.port is not None:
        parser.error("--port requires --server")

    output = args.output or ROOT / "dist" / f"switch-online-{args.version}-sd.zip"
    try:
        embedded = fixed_profile()
        if args.embedded != (embedded is not None):
            parser.error('Use --embedded for a fixed relay build, or disable RELAY_PROFILE_FIXED and rebuild for a configurable package')
        write_zip(output, package_files(args.version, args.server, args.port or 11460, embedded))
        digest = hashlib.sha256(output.read_bytes()).hexdigest()
    except (OSError, ValueError, argparse.ArgumentTypeError, zipfile.BadZipFile) as error:
        parser.exit(1, f"{error}\n")
    print(f"{output}\nSHA-256 {digest}")


if __name__ == "__main__":
    main()
