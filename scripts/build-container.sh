#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
image=$(python3 - "$root/scripts/toolchain/container-profile.json" <<'PY'
import json,re,sys
p=json.load(open(sys.argv[1]));image=p['image']
assert p['platform']=='linux/amd64' and re.fullmatch(r'devkitpro/devkita64@sha256:[a-f0-9]{64}',image)
print(image)
PY
)
docker run --rm --platform linux/amd64 --cpus "${BUILD_CPUS:-2}" --memory "${BUILD_MEMORY:-3g}" \
    --entrypoint /bin/bash -v "$root:/src" -w /src \
    -e BUILD_JOBS="${BUILD_JOBS:-2}" -e CLEAN_BUILD="${CLEAN_BUILD:-1}" "$image" scripts/toolchain/build-in-container.sh "$@"
