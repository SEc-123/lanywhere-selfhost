# Integrating LANywhere Self-host

Use the tagged SD ZIP. Include `atmosphere/`, `switch/` and `lanywhere/`; `README.txt` and `GAMES.txt` at the root are for manual downloads.

| Path | Purpose |
| --- | --- |
| `switch/lanywhere.nro` | Album lobby |
| `switch/.overlays/lanywhere.ovl` | Tesla-compatible status and controls |
| `atmosphere/contents/4200000000000010/` | Required local wireless module and boot flag |
| `lanywhere/` | Help and licenses |

The module replaces ldn_mitm with the same program ID. Offer it as an alternative if the pack already includes a provider of that ID. Keep any existing overlay loader and menu; they are separate dependencies. Restart after installation.

Source is available under GPL-2.0-only; see the release for the exact project and linked-library sources.
