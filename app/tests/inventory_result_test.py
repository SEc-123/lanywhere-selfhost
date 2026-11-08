"""Test the actual main.c inventory-completion consumer without Switch services."""
import importlib.util
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
source = (root / 'app/source/main.c').read_text(encoding='utf-8')
spec = importlib.util.spec_from_file_location('routes', root / 'app/tests/input_routing_test.py')
routes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(routes)
function = routes.function(source, 'static bool consume_inventory_result(')
harness = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>
#include "ui_text.h"
#define TR(es,en) ui_tr((es),(en))
typedef struct { bool inventory_error; } View;
static atomic_bool g_inventory_finished, g_inventory_success;
static int cleared;
static void clear_game_cache(void) { ++cleared; }
''' + function + r'''
int main(void) {
    View v={0};
    assert(!consume_inventory_result(&v) && !v.inventory_error && cleared==0);
    atomic_store(&g_inventory_success,false);atomic_store(&g_inventory_finished,true);
    assert(consume_inventory_result(&v) && v.inventory_error && cleared==1);
    assert(!consume_inventory_result(&v) && v.inventory_error && cleared==1);
    atomic_store(&g_inventory_success,true);atomic_store(&g_inventory_finished,true);
    assert(consume_inventory_result(&v) && !v.inventory_error && cleared==2);
    puts("Actual inventory result consumer: failure visible, success clears warning, consumed once");
}
'''
with tempfile.TemporaryDirectory(prefix='switch-inventory-ui-') as temporary:
    temp=Path(temporary);source_file=temp/'test.c';binary=temp/'test';source_file.write_text(harness,encoding='utf-8')
    subprocess.run(shlex.split(os.environ.get('CC','cc')) + ['-std=c11','-Wall','-Wextra','-Werror',
                   '-I'+str(root/'app/source'),str(source_file),'-o',str(binary)],check=True)
    subprocess.run([str(binary)],check=True)
