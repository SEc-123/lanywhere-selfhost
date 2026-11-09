#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
if [[ ${1:-} == --help || ${1:-} == -h ]]; then
    printf '%s\n' 'Usage: bash scripts/build-macos.sh [package.py options]'
    printf '%s\n' 'With no options, builds the app, sysmodule and overlay without creating a ZIP.'
    printf '%s\n' 'Set DEVKITPRO, DEVKITA64, MAKE_BIN or BUILD_JOBS to override the build environment.'
    python3 "$root/scripts/package.py" --help
    exit 0
fi

export DEVKITPRO=${DEVKITPRO:-/opt/devkitpro}
export DEVKITA64=${DEVKITA64:-$DEVKITPRO/devkitA64}
export PATH="$DEVKITPRO/tools/bin:$DEVKITA64/bin:$PATH"

compiler=$DEVKITA64/bin/aarch64-none-elf-gcc
if [[ ! -x $compiler || ! -f $DEVKITPRO/libnx/switch_rules ]]; then
    printf '%s\n' 'Install the devkitPro macOS package manager, then install switch-dev switch-freetype switch-libjpeg-turbo.' >&2
    exit 1
fi
if ! grep -q fsStorageForBatchReadSetSize "$DEVKITPRO/libnx/include/switch/services/fs.h"; then
    printf '%s\n' 'This Atmosphere-libs revision needs the batch-read API missing from libnx 4.12.0.' >&2
    printf '%s\n' 'Build and install libnx b156b4774fb2df7b93402169509266da7547fc4c. See docs/DEPLOY.zh-CN.md.' >&2
    exit 1
fi
if ! compiler_version=$("$compiler" --version); then
    printf '%s\n' 'devkitA64 is installed but cannot run on this host. Check the architecture of the macOS toolchain.' >&2
    exit 1
fi

make_bin=${MAKE_BIN:-make}
jobs=${BUILD_JOBS:-4}
if [[ ! $jobs =~ ^[1-9][0-9]*$ ]]; then
    printf '%s\n' 'BUILD_JOBS must be a positive integer.' >&2
    exit 1
fi

provenance=$(python3 - "$root/UPSTREAM.json" <<'PY'
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as manifest:
    source = json.load(manifest)
version = source["derived_version"]
upstream = source["commit"]
atmosphere = source["submodules"]["console/Atmosphere-libs"]["commit"]
tesla = source["submodules"]["console/libtesla"]["commit"]
if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,63}", version) or not all(
    re.fullmatch(r"[a-f0-9]{40}", revision) for revision in (upstream, atmosphere, tesla)
):
    sys.exit("Invalid build provenance in UPSTREAM.json")
print(version, upstream, atmosphere, tesla)
PY
)
read -r version upstream atmosphere tesla <<< "$provenance"

for component in console/Atmosphere-libs console/libtesla; do
    gitlink=''
    # A container may see a linked worktree without its external Git directory.
    if [[ -e $root/.git ]] && git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        gitlink=$(git -C "$root" ls-files --stage -- "$component" | awk '$1 == "160000" {print $2}')
    fi
    if [[ -n $gitlink ]]; then
        git -C "$root" submodule update --init --recursive -- "$component"
        expected=$atmosphere
        if [[ $component == console/libtesla ]]; then expected=$tesla; fi
        if [[ $(git -C "$root/$component" rev-parse HEAD) != "$expected" ]]; then
            printf '%s\n' 'The checked-out submodules must match UPSTREAM.json.' >&2
            exit 1
        fi
    else
        # Release archives contain tracked source files, not gitlinks. A parent
        # repository HEAD is not the revision of those vendored components.
        python3 "$root/scripts/verify-vendored.py" "$component"
    fi
done
if [[ ! -f $root/console/Atmosphere-libs/config/templates/stratosphere.mk ||
      ! -f $root/console/Atmosphere-libs/libstratosphere/Makefile ||
      ! -f $root/console/libtesla/include/tesla.hpp ]]; then
    printf '%s\n' 'The source tree must contain the pinned Atmosphere-libs and libtesla files.' >&2
    exit 1
fi

printf '%s\n' "${compiler_version%%$'\n'*}" "LANywhere $upstream" \
    "Atmosphere-libs $atmosphere" "libtesla $tesla"

"$make_bin" -C "$root/console" -j "$jobs" "TARGET_VERSION=$version" "GITREV=${upstream:0:8}" \
    ATMOSPHERE_GIT_BRANCH=pinned "ATMOSPHERE_GIT_REVISION=pinned-${atmosphere:0:8}" \
    "ATMOSPHERE_GIT_HASH=${atmosphere:0:16}"
"$make_bin" -C "$root/app" -j "$jobs" "APP_VERSION=$version"
if (( $# > 0 )); then
    python3 "$root/scripts/package.py" "$@"
fi
