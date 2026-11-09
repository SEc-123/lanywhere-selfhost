"""Verify literal UI keys in the current main source have Chinese translations."""
import ast
import pathlib
import re

root = pathlib.Path(__file__).resolve().parents[2]
main = '\n'.join((root / 'app/source' / name).read_text(encoding='utf-8')
                 for name in ('main.c', 'room_password.c'))
dictionary = (root / 'app/source/ui_text.c').read_text(encoding='utf-8')
literal = r'"(?:\\.|[^"\\])*"'
tr = re.findall(r'TR\(\s*' + literal + r'\s*,\s*(' + literal + r')\s*\)', main, re.S)
direct = re.findall(r'ui_text\(\s*(' + literal + r')\s*\)', main, re.S)
keys = {ast.literal_eval(item) for item in tr + direct}
translated = {ast.literal_eval(item) for item in re.findall(r'\{\s*(' + literal + r')\s*,\s*' + literal + r'\s*\}', dictionary)}
missing = sorted(keys - translated)
if missing:
    raise SystemExit('Missing Chinese UI keys:\n' + '\n'.join(missing))
print(f'Chinese dictionary covers {len(keys)} literal UI keys')
