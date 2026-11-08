"""Exercise the actual UI error translator against live server/client error strings."""
import ctypes
import os
from pathlib import Path
import re
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
main = (root / 'app/source/main.c').read_text(encoding='utf-8')
server = (root / 'server/relay/server.js').read_text(encoding='utf-8')
native = (root / 'console/ldn_mitm/source/lanywhere_relay.cpp').read_text(encoding='utf-8')

begin = main.index('static const char *tr_error(')
end = main.index('// --- servicio', begin)
function = main[begin:end]
static_server = set(re.findall(r"sendError\([^,\n]+,\s*E\.\w+,\s*'([^']*)'\)", server))
paused = re.search(r"const PAUSED_TEXT\s*=\s*'([^']+)'", server).group(1)
static_server.add(paused)
native_errors = set(re.findall(r'\*err\s*=\s*"([^\"]+)"', native))
for expression in re.findall(r'\*err\s*=\s*(.*?);', native, re.S):
    native_errors.update(re.findall(r'"([^\"]+)"', expression))
native_errors.update(s for s in re.findall(r'return fail\("([^\"]+)"\)', native)
                     if any(part in s for part in ('servidor', 'respuesta')))
native_errors.update(re.findall(r'SetError\("([^\"]*(?:servidor|conexión)[^\"]*)"\)', native))
native_errors.update(re.findall(r'Strlcpy\(g_error,\s*"([^\"]*servidor[^\"]*)"', native))
# These newer wire errors are already English. Keep a narrow explicit set;
# treating arbitrary ASCII as English would silently accept Spanish regressions.
fixed_english = {
    'stream requires room membership', 'game stream traffic limit reached', 'invalid game stream frame',
    'selected network does not support game TCP streams', 'invalid game stream destination',
    'upstream game stream rate exceeded', 'invalid upstream game stream', 'upstream game stream budget exceeded',
    'Fork network supports UDP payloads up to 1472 bytes', 'Fork network data queue is full',
    'Game TCP is unavailable on this network.', 'Legacy game TCP is unconfirmed.',
    'Reopen LANywhere to read game information.', 'Game network ID is not allowed.',
}
upstream = (root / 'server/relay/upstream-gateway.js').read_text(encoding='utf-8')
fork = (root / 'server/relay/lanplay.js').read_text(encoding='utf-8')
actual_stream_errors = {message for message in re.findall(
    r"(?:sendError|error|fail|dataUnsupported)\([^;\n]*?'([^'\n]*)'", server+'\n'+upstream+'\n'+fork)
    if re.search(r'\bstream\b|\bTCP\b|^Fork network', message)}
assert actual_stream_errors <= fixed_english, f'New stream error needs explicit translation coverage: {actual_stream_errors-fixed_english}'
assert len(static_server) >= 30 and len(native_errors) >= 5, 'Source extraction unexpectedly missed errors'

with tempfile.TemporaryDirectory(prefix='switch-error-i18n-') as directory:
    directory = Path(directory)
    harness = directory / 'errors.c'
    harness.write_text('#include <stdbool.h>\n#include <stddef.h>\n#include <string.h>\n'
                       '#include "ui_text.h"\nstatic bool g_es;\n'
                       '#define RELAY_PROFILE_FIXED 1\n#define TR(es,en) ui_tr((es),(en))\n' + function +
                       '\nconst char *test_error(const char *s) { return tr_error(s); }\n'
                       'void test_language(bool zh, bool es) { g_es=es; ui_set_language(zh,es); }\n', encoding='utf-8')
    library = directory / 'errors.so'
    subprocess.run([os.environ.get('CC', 'cc'), '-std=c11', '-Wall', '-Wextra', '-Werror', '-shared', '-fPIC',
                    '-I' + str(root / 'app/source'), str(harness), str(root / 'app/source/ui_text.c'), '-o', str(library)], check=True)
    lib = ctypes.CDLL(str(library))
    lib.test_language.argtypes = [ctypes.c_bool, ctypes.c_bool]
    lib.test_error.argtypes = [ctypes.c_char_p]
    lib.test_error.restype = ctypes.c_char_p
    def translated(s): return lib.test_error(s.encode('utf-8')).decode('utf-8')

    for source in sorted(static_server | native_errors | fixed_english):
        lib.test_language(False, False)
        english = translated(source)
        already_english = source in fixed_english or (source in native_errors and source[0].isupper())
        assert english.isascii() and (already_english or english != source), f'untranslated English error: {source!r} -> {english!r}'
        lib.test_language(True, False)
        chinese = translated(source)
        assert chinese != source and not chinese.isascii(), f'untranslated Chinese error: {source!r} -> {chinese!r}'
        lib.test_language(False, True)
        assert translated(source) == source, f'Spanish original changed: {source!r}'

    prefix = 'el servidor llegó a su límite de este mes'
    for source in (prefix, paused.encode('utf-8')[:63].decode('utf-8', 'ignore')):
        lib.test_language(False, False)
        assert translated(source) == 'the server reached its monthly limit'
        lib.test_language(True, False)
        assert translated(source) == '服务器本月流量已用完'
    lib.test_language(False, False)
    assert translated('tipo 42 desconocido') == 'unknown server message type'
    assert translated('tipo unexpected desconocido') == 'tipo unexpected desconocido'
    assert translated('An unknown English error') == 'An unknown English error'

print(f'Localized {len(static_server)} server errors, {len(native_errors)} native errors and {len(fixed_english)} fixed stream messages in English and Chinese')
