#!/usr/bin/env bash
set -euo pipefail

if (( EUID != 0 )); then
    printf '%s\n' 'Run this installer as root on the Linux VPS (sudo bash deploy/install-systemd.sh).' >&2
    exit 1
fi

node_bin=${SWITCH_ONLINE_NODE:-/usr/bin/node}
if [[ ! $node_bin =~ ^/[A-Za-z0-9_./-]+$ ]] || [[ ! -x $node_bin ]] ||
   ! "$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    printf '%s\n' 'Set SWITCH_ONLINE_NODE to an absolute executable Node.js >=22 path. The installer does not change other runtimes.' >&2
    exit 1
fi
node_bin=$(readlink -f -- "$node_bin")
[[ $node_bin =~ ^/[A-Za-z0-9_./-]+$ ]] || { printf '%s\n' 'Resolved Node.js path is not supported.' >&2; exit 1; }

if [[ ! -d /run/systemd/system ]]; then
    printf '%s\n' 'This installer requires a Linux VPS with systemd running.' >&2
    exit 1
fi

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
app_dir=/opt/switch-online
env_dir=/etc/switch-online
unit=switch-online.service
unit_path=/etc/systemd/system/$unit

install -d -m 0755 "$app_dir"
exec 9>"$app_dir/.maintenance.lock"
if ! flock -n 9; then
    printf '%s\n' 'Another Switch Online installation is already running.' >&2
    exit 1
fi

install -d -m 0755 "$app_dir/releases"
install -d -m 0750 "$env_dir"
stage=$(mktemp -d "$app_dir/releases/.stage.XXXXXXXX")
backup=$(mktemp -d "$app_dir/.rollback.XXXXXXXX")
unit_stage=$(mktemp /etc/systemd/system/.switch-online.XXXXXXXX)
next_link=$app_dir/.current.$$
keep_backup=0
cleanup() {
    rm -rf -- "$stage"
    if (( ! keep_backup )); then rm -rf -- "$backup"; fi
    rm -f -- "$next_link" "$unit_stage"
}
trap cleanup EXIT

relay_files=(server.js stats.js public.js lanplay.js lanplay-fork.js lanplay-fork-tcp.js dashboard.html operations.js traffic-store.js appointments.js appointment-push.js matchmaking.js group-page.js unified-lobby.js regional-directory.js udp-fragments.js upstream-gateway.js room-metadata.js lanplay-providers.js lanplay-realms.js tcp-stream-protocol.js tcp-streams.js inbound-deadline.js)
ops_files=(healthcheck.cjs validate-config.cjs metrics.cjs smoke-relay.cjs smoke-relay-v2.cjs)
for file in "${relay_files[@]}"; do
    install -m 0644 "$root/server/relay/$file" "$stage/$file"
done
for file in "${ops_files[@]}"; do
    install -m 0644 "$root/deploy/$file" "$stage/$file"
done
install -m 0644 "$root/LICENSE" "$stage/LICENSE"
sed "s|/usr/bin/node|$node_bin|g" "$root/deploy/$unit" > "$stage/$unit"
chmod 0755 "$stage"

release_id=$(cd "$stage" && sha256sum -- "${relay_files[@]}" "${ops_files[@]}" LICENSE "$unit" | sha256sum | cut -c 1-24)
release=$app_dir/releases/$release_id
if [[ ! -d $release ]]; then
    mv -T -- "$stage" "$release"
fi

if [[ -L $env_dir/relay.env || -L $unit_path || ( -e $app_dir/current && ! -L $app_dir/current ) ]]; then
    printf '%s\n' 'Unexpected managed filesystem layout. Inspect the unit, relay.env and release pointer.' >&2
    exit 1
fi
if [[ ! -e $env_dir/relay.env ]]; then
    install -m 0640 "$root/deploy/relay.env.example" "$env_dir/relay.env"
fi
"$node_bin" "$release/validate-config.cjs" "$env_dir/relay.env"
systemd-analyze verify "$release/$unit"

previous=$(readlink "$app_dir/current" || true)
if [[ -n $previous && ( $previous != "$app_dir/releases/"* || ! -d $previous ) ]]; then
    printf '%s\n' 'Existing release pointer is invalid. Restore it before upgrading.' >&2
    exit 1
fi
if [[ -f $unit_path ]]; then
    cp -p -- "$unit_path" "$backup/unit"
fi
previous_active=0
if systemctl is-active --quiet "$unit"; then
    previous_active=1
    printf '%s\n' 'Stopping the previous release. A drain-aware server waits for active rooms within its grace period.'
    systemctl stop "$unit"
fi

switch_release() {
    ln -s -- "$1" "$next_link" && mv -Tf -- "$next_link" "$app_dir/current"
}

install_unit() {
    install -m 0644 "$1" "$unit_stage" && mv -Tf -- "$unit_stage" "$unit_path"
}

if ! { install_unit "$release/$unit" && switch_release "$release" && systemctl daemon-reload &&
       systemctl start "$unit" && "$node_bin" "$app_dir/current/healthcheck.cjs" --once --allow-paused && systemctl enable "$unit"; }; then
    systemctl stop "$unit" || true
    rollback_ok=1
    if [[ -f $backup/unit ]]; then
        install_unit "$backup/unit" || rollback_ok=0
    else
        systemctl disable "$unit" >/dev/null 2>&1 || true
        rm -f -- "$unit_path" || rollback_ok=0
    fi
    if [[ -n $previous ]]; then
        rm -f -- "$next_link"
        switch_release "$previous" || rollback_ok=0
    else
        rm -f -- "$app_dir/current" || rollback_ok=0
    fi
    systemctl daemon-reload || rollback_ok=0
    if (( previous_active && rollback_ok )); then
        systemctl start "$unit" || rollback_ok=0
    fi
    printf '%s\n' "Startup failed. Inspect: journalctl -u $unit -n 50 --no-pager" >&2
    if (( ! rollback_ok )); then
        keep_backup=1
        printf '%s\n' "Automatic rollback needs attention. Recovery files retained at: $backup" >&2
        printf '%s\n' 'Verify the unit and release pointer before starting the service.' >&2
    fi
    exit 1
fi

printf '%s\n' 'Service started. Allow TCP and UDP 11460 at your firewalls. Dashboard 11461 and operations 11462 are local only.'
