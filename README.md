# LANywhere Self-host

[中文](#中文) · [Download](https://github.com/SEc-123/lanywhere-selfhost/releases/latest)

Play compatible Switch games' Local Wireless mode over the internet. The player build connects to a preset relay. No IP setup is needed.

1. On an Atmosphère Switch, merge the release ZIP into the SD root and restart. It replaces an existing ldn_mitm with the same module ID.
2. Open **LANywhere Self-host** from Album. Press **B** to enter the lobby, **R** for the guide or **RS** for Chinese.
3. Create or search for a room in your game's **Local Wireless** menu. See the guide for public rooms and friends codes.

With a compatible Tesla or Ultrahand setup, **LANywhere** also appears in the overlay menu. Use it to check the module and toggle local wireless interception while idle. Use the Album app for rooms. The ZIP does not install an overlay loader. [Pack and store integration](docs/distribution/INTEGRATORS.md).

Beta: see [game candidates](compatibility/PLAYER-GAMES.txt) and [validation scope](docs/distribution/VALIDATION.md). This project is independent of Nintendo.

## Build and self-host

- Switch: `bash scripts/build-container.sh --embedded` builds the app, sysmodule and overlay with the [pinned toolchain](scripts/toolchain/README.md).
- Server: Node.js 22+, `npm start`. Forward TCP and UDP 11460. [Deployment guide](docs/DEPLOY.zh-CN.md).
- To target your own relay, edit [the relay profile](common/relay_profile.h) before building. The live deployment's credentials and configuration are not part of this project.

## Credits

Based on [LANywhere by augustocco](https://github.com/augustocco/lanywhere) and [ldn_mitm](https://github.com/spacemeowx2/ldn_mitm), with [third-party notices](third_party/README.md). [GPL-2.0-only](LICENSE).

Development assisted by OpenAI Codex; portions of the code were AI-generated.

## 中文

从 [Releases](https://github.com/SEc-123/lanywhere-selfhost/releases/latest) 下载 SD 包，解压合并到 SD 卡根目录，重启后从相册打开 **LANywhere Self-host**。会替换同模块 ID 的旧版 ldn_mitm。默认英文，按 **RS** 切换中文，**R** 打开教程。服务器已内置，到游戏里选「本地无线」建房或找房。

已安装兼容 Tesla 或 Ultrahand 的主机，游戏内可打开 **LANywhere** 查看联机模块状态或在空闲时切换接管；房间操作在相册应用中完成。
