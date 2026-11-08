#!/usr/bin/env bash
set -euo pipefail

build_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
source_dir=${1:-"$build_dir/../.."}
export DEVKITPRO=${DEVKITPRO:-"$build_dir/sysroot/opt/devkitpro"}
export DEVKITA64=${DEVKITA64:-"$DEVKITPRO/devkitA64"}
export PATH="$DEVKITA64/bin:$DEVKITPRO/tools/bin:$PATH"

if [[ ! -x "$DEVKITA64/bin/aarch64-none-elf-gcc" ]]; then
    printf 'Run python3 %s/prepare.py first.\n' "$build_dir" >&2
    exit 1
fi

export BUILD_JOBS=${BUILD_JOBS:-${LANYWHERE_BUILD_JOBS:-4}}
exec bash "$source_dir/scripts/build-macos.sh"
