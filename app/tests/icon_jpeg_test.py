"""Exercise the actual decoder using a real libjpeg-turbo encoder and decoder."""
import importlib.util
import os
from pathlib import Path
import shlex
import subprocess
import tempfile

root = Path(__file__).resolve().parents[2]
source = (root / 'app/source/main.c').read_text(encoding='utf-8')
spec = importlib.util.spec_from_file_location('routes', root / 'app/tests/input_routing_test.py')
routes = importlib.util.module_from_spec(spec); spec.loader.exec_module(routes)
decode = routes.function(source, 'static void decode_icon(')
flags = os.environ.get('TURBOJPEG_TEST_FLAGS')
if not flags:
    probe = subprocess.run(['pkg-config', '--cflags', '--libs', 'libturbojpeg'], capture_output=True, text=True) if subprocess.run(['sh', '-c', 'command -v pkg-config'], capture_output=True).returncode == 0 else None
    flags = probe.stdout if probe and probe.returncode == 0 else ''
if not flags:
    raise SystemExit('Real JPEG test requires a host libturbojpeg development library; set TURBOJPEG_TEST_FLAGS')
harness = r'''
#include <assert.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <turbojpeg.h>
typedef struct { uint32_t *px; int w,h; } Image;
static bool fail_malloc;
static void *test_malloc(size_t n) { return fail_malloc ? NULL : malloc(n); }
#define malloc test_malloc
''' + decode + r'''
#undef malloc
static unsigned char *make_jpeg(int w,int h,unsigned long *n) {
    unsigned char *pixels=malloc((size_t)w*h*3),*jpeg=NULL;
    assert(pixels); for (int i=0;i<w*h;i++){pixels[i*3]=230;pixels[i*3+1]=40;pixels[i*3+2]=15;}
    tjhandle encoder=tjInitCompress();assert(encoder);
    assert(tjCompress2(encoder,pixels,w,0,h,TJPF_RGB,&jpeg,n,TJSAMP_444,95,0)==0);
    tjDestroy(encoder);free(pixels);return jpeg;
}
int main(void) {
    unsigned long n=0; unsigned char *jpeg=make_jpeg(4,3,&n); Image image={0};
    decode_icon(&image,jpeg,n);assert(image.px&&image.w==4&&image.h==3);
    assert(((image.px[0]>>16)&255)>180 && (image.px[0]&255)<80);free(image.px);
    image=(Image){0};fail_malloc=true;decode_icon(&image,jpeg,n);assert(!image.px);fail_malloc=false;
    image=(Image){0};decode_icon(&image,jpeg,3);assert(!image.px);
    unsigned char corrupt[]={0x12,0x34,0x56,0x78};image=(Image){0};decode_icon(&image,corrupt,sizeof(corrupt));assert(!image.px);
    tjFree(jpeg);jpeg=make_jpeg(1025,1,&n);image=(Image){0};decode_icon(&image,jpeg,n);assert(!image.px);tjFree(jpeg);
    puts("Actual decode_icon + real libjpeg-turbo: valid BGRA, truncated/corrupt, oversized, allocation failure passed");
}
'''
with tempfile.TemporaryDirectory(prefix='switch-icon-jpeg-') as tmp:
    tmp = Path(tmp); c = tmp / 'test.c'; exe = tmp / 'test'; c.write_text(harness)
    subprocess.run(shlex.split(os.environ.get('CC', 'cc')) + ['-std=c11', '-Wall', '-Wextra', '-Werror', str(c), '-o', str(exe)] + shlex.split(flags) + ['-lm'], check=True)
    subprocess.run([str(exe)], check=True)
