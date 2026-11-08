#!/usr/bin/env bash
set -euo pipefail

if (( EUID != 0 )); then
    printf '%s\n' 'Run this read-only preflight as root on the VPS.' >&2
    exit 1
fi
[[ $(uname -s) == Linux ]] || { printf '%s\n' 'This deployment requires Linux.' >&2; exit 1; }
if [[ -r /etc/os-release ]]; then source /etc/os-release; fi
printf 'System: %s\n' "${PRETTY_NAME:-Linux}"
test -d /run/systemd/system || { printf '%s\n' 'systemd is not running.' >&2; exit 1; }
for tool in bash install flock sha256sum ss systemctl systemd-analyze readlink df python3 tar mktemp mv ln cp rm chmod cut sed date; do
    command -v "$tool" >/dev/null || { printf 'Missing dependency: %s\n' "$tool" >&2; exit 1; }
done
systemctl show --property=Version --value >/dev/null || { printf '%s\n' 'Cannot contact the systemd service manager.' >&2; exit 1; }
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)' || {
    printf '%s\n' 'Python 3.8 or later is required for state backup and recovery.' >&2; exit 1;
}
node_bin=${SWITCH_ONLINE_NODE:-/usr/bin/node}
if [[ ! $node_bin =~ ^/[A-Za-z0-9_./-]+$ ]] || [[ ! -x $node_bin ]] ||
   ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    printf '%s\n' 'Set SWITCH_ONLINE_NODE to an absolute executable Node.js >=22 path. Existing application runtimes need not be changed.' >&2
    exit 1
fi
printf 'Dedicated runtime: %s\n' "$node_bin"
readlink -f -- "$node_bin" >/dev/null || { printf '%s\n' 'readlink must support canonical path resolution (-f).' >&2; exit 1; }
"$node_bin" --version
df -h / /opt /var
if command -v free >/dev/null; then free -m; fi
systemctl show switch-online.service --property=LoadState --property=ActiveState --property=SubState --property=MainPID --no-pager || true
if [[ -e /opt/switch-online/current || -L /opt/switch-online/current ]]; then
    readlink /opt/switch-online/current
fi
printf '%s\n' 'Review these socket owners before installing.'
ss -lntup
if command -v ip >/dev/null; then ip -4 -brief address; ip -4 route; fi
if command -v ufw >/dev/null; then ufw status verbose; fi
if command -v nft >/dev/null; then nft list ruleset; fi
printf '%s\n' 'Read-only preflight complete. Review port conflicts and cloud ingress separately.'
