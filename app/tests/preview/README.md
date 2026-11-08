# Host UI preview

These scripts compile the actual `gfx.c` renderer. `render_guide.py` links the complete `guide.c`; `render_main.py` extracts unchanged drawing functions from `main.c` and supplies explicitly synthetic room/game data. Neither preview runs Switch services, a commercial game, or the full application event loop.

Requirements: C compiler, Python 3, pkg-config, FreeType, libpng, DejaVu Sans and Noto Sans CJK. On Debian the packages are `libfreetype-dev libpng-dev fonts-dejavu-core fonts-noto-cjk`. Override the two substitute font files with `GUIDE_FONT_LATIN` and `GUIDE_FONT_CJK`. These host fonts are never bundled in the Switch app; the app uses the console's shared fonts.

```sh
python3 app/tests/preview/render_guide.py --output /tmp/guide-preview
python3 app/tests/preview/render_main.py --output /tmp/main-preview
```

Guide checks cover every guide line's glyphs and width, all strings in `ui_text.c`, and page touch targets. Main checks cover touch target bounds and the startup error page's touch-to-exit route. PNGs use the actual draw functions and 1280 × 720 framebuffer. Reports record source and output hashes; the main report also retains the exact extracted drawing source. Visual review and real Switch acceptance remain separate checks.
