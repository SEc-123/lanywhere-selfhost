# LANywhere Self-host

[中文](#中文) · [Download](https://github.com/SEc-123/lanywhere-selfhost/releases/latest)

Play compatible Switch games' Local Wireless mode over the internet. Schedule a time and get a room alert when someone opens a room.

1. Merge the SD ZIP into the SD card root, restart Atmosphère, and open **LANywhere Self-host** from Album. The ZIP replaces an existing ldn_mitm with the same module ID.
2. **Host.** Press **B** for the lobby. The default is **My server**. When **Hosting line** appears, press **Y** to select **Community · LANywhere** before creating a room in the game's **Local Wireless** menu.
3. **Join.** Press **A** on a room. Use **Open game** when offered, or return to the game from HOME. Search in **Local Wireless**. The room's source determines the connection.

On **Community · LANywhere**, both consoles connect directly to the public node. Use the game's password. **My server** supports appointment alerts and lobby password sharing. You can join listed Switch LAN Play rooms through My server.

On **Appointments**, use **A** to join or leave, **L** to create, **Y** to mark Ready and **X** to find rooms. In-game room alerts require Ultrahand with API notifications enabled. Press **RS** to switch languages, or choose **View guide** for help.

[Game candidates](compatibility/PLAYER-GAMES.txt) · [Validation status](docs/distribution/VALIDATION.md) · [Pack and store integration](docs/distribution/INTEGRATORS.md)

## Build and self-host

- Run `bash scripts/build-container.sh --embedded` to build the Switch app, sysmodule and overlay with the [pinned toolchain](scripts/toolchain/README.md).
- Run `npm start` with Node.js 22 or later. Forward TCP and UDP 11460. [Deployment guide](docs/DEPLOY.zh-CN.md).
- To target your own relay, edit [the connection profile](common/relay_profile.h) before building. See [community and regional configuration](docs/distribution/REGIONAL-RELAYS.md).

## Credits

Based on [LANywhere by augustocco](https://github.com/augustocco/lanywhere) and [ldn_mitm](https://github.com/spacemeowx2/ldn_mitm). [Third-party notices](third_party/README.md) · [GPL-2.0-only](LICENSE).

Development assisted by OpenAI Codex. Portions of the code were AI-generated.

## 中文

通过兼容 Switch 游戏的「本地无线」跨网联机。可以提前约时间，有人开房时收提醒。

1. 将[发布页](https://github.com/SEc-123/lanywhere-selfhost/releases/latest)的 SD 包解压合并到卡根目录，重启 Atmosphère，从相册打开 **LANywhere Self-host**。安装会替换同模块 ID 的 ldn_mitm。
2. **建房。** 按 **B** 进大厅，默认用「自有网络」。如果显示「建房线路」，可在开房前按 **Y** 选「社区 · LANywhere」，再到游戏的「本地无线」里建房。
3. **加入。** 在大厅按 **A** 选房，再按提示打开游戏，或从 HOME 回到游戏。在「本地无线」里搜索。连接跟随房间来源。

「社区 · LANywhere」的双方直连同一个公共节点，密码在游戏里用。约局开房提醒和大厅密码分享用「自有网络」。大厅列出的 Switch LAN Play 房间可以通过自有网络加入。

约局首页按 **A** 参加或退出、**L** 发起、**Y** 准备、**X** 找房。游戏内提醒需要 Ultrahand 开启 API 通知。按 **RS** 切换中英文，右下角可「查看教程」。

[游戏候选清单](compatibility/PLAYER-GAMES.txt) · [验证记录](docs/distribution/VALIDATION.md)
