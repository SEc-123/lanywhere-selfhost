#!/usr/bin/env bash
set -euo pipefail
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
cd "$root"
export DEVKITPRO=/opt/devkitpro
export DEVKITA64=$DEVKITPRO/devkitA64
export PATH="$DEVKITA64/bin:$DEVKITPRO/tools/bin:$PATH"
python3 - <<'PY'
import hashlib,json,pathlib,subprocess,sys
root=pathlib.Path.cwd();base=root/'scripts/toolchain'
p=json.loads((base/'container-profile.json').read_text());lock=json.loads((base/'packages.lock.json').read_text())
version=subprocess.check_output(['/opt/devkitpro/devkitA64/bin/aarch64-none-elf-gcc','-dumpfullversion'],text=True).strip()
assert version==p['gcc_version'], 'Unexpected container compiler'
assert lock['libnx_source']['commit']==p['libnx_commit']
sys.path.insert(0,str(base));import prepare
source=base/'libnx-upstream';installed=pathlib.Path('/opt/devkitpro/libnx')
def same(a,b):
    return a.is_file() and b.is_file() and hashlib.sha256(a.read_bytes()).digest()==hashlib.sha256(b.read_bytes()).digest()
prepared=False
if (source/'.git').exists():
    revision=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
    clean=not subprocess.check_output(['git','-C',str(source),'status','--porcelain']).strip()
    headers=[(q,installed/'include'/q.relative_to(folder)) for folder in [source/'nx/include',source/'nx/external/bsd/include'] for q in folder.rglob('*') if q.is_file()]
    prepared=(revision==p['libnx_commit'] and clean and bool(headers) and same(source/'nx/lib/libnx.a',installed/'lib/libnx.a') and all(same(a,b) for a,b in headers))
if prepared:
    print('Reusing byte-verified installed libnx from the pinned source',flush=True)
else:
    prepare.install_libnx(lock['libnx_source'],source,pathlib.Path('/opt/devkitpro'))
actual=subprocess.check_output(['git','-C',str(base/'libnx-upstream'),'rev-parse','HEAD'],text=True).strip()
assert actual==p['libnx_commit']
(root/'evidence/container-build-environment.json').write_text(json.dumps({'profile':p,'actual_gcc':version,'actual_libnx_commit':actual},indent=2)+'\n')
PY
if [[ ${CLEAN_BUILD:-1} == 1 ]]; then
    version=$(python3 -c 'import json; print(json.load(open("UPSTREAM.json"))["derived_version"])')
    make -C console/ldn_mitm clean "TARGET_VERSION=$version"
    make -C console/overlay clean "TARGET_VERSION=$version"
    make -C app clean
fi
bash scripts/build-macos.sh "$@"
