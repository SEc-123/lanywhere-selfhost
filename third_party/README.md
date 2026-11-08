# Included libraries and source references

The original LANywhere/ldn_mitm GPL-2.0 notice is preserved in the project root.
Atmosphere-libs and libtesla source, with their licenses, is included under `console/`.

The front end links the devkitPro builds of FreeType, HarfBuzz, libpng, bzip2, zlib,
libjpeg-turbo and libnx, together with the devkitA64 runtime. Packaged license notices
are retained in `licenses/`. FreeType is included under its GPLv2 option. The upstream
projects and exact package versions/hashes used for the build are recorded below and
in `scripts/toolchain/packages.lock.json`.

- Fork protocol reference: https://github.com/jieluojun/ldn_mitm at commit `1014c70d5f82b19bf774b00c851c237d805531ae`; its repository provides GPLv2 terms and documents exemptions for specific named projects. See `UPSTREAM.json`. The submitted archive's binary has not been reproduced from that source.
- libnx source revision is pinned in `UPSTREAM.json`: https://github.com/switchbrew/libnx
- devkitPro package build recipes: https://github.com/devkitPro/portlibs
- FreeType 2.13.3: https://gitlab.freedesktop.org/freetype/freetype
- HarfBuzz 10.0.1: https://github.com/harfbuzz/harfbuzz
- libpng 1.6.48: https://github.com/pnggroup/libpng
- bzip2 1.0.8: https://sourceware.org/bzip2/
- zlib 1.3.1: https://github.com/madler/zlib
- libjpeg-turbo 2.1.2: https://github.com/libjpeg-turbo/libjpeg-turbo
- devkitA64/GCC runtime build sources: https://github.com/devkitPro/buildscripts

This folder contains the notices supplied with the fetched SDK packages; it is not
a claim that the original console games, Nintendo system software, or their assets
are included. No games, ROMs, console keys or user credentials are in this delivery.

The supplied fork's Chinese title database and nx-ovlloader heap settings were not imported.
