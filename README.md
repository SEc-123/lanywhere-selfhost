# LANywhere Self-host

[中文](#中文) · [Download](https://github.com/SEc-123/lanywhere-selfhost/releases/latest)

Play compatible Switch games' Local Wireless mode over the internet. Arrange a time in advance without staying online in an open room. Join several appointments, mark yourself Ready near the start, then look for a room or get an Ultrahand alert when one opens.

1. On an Atmosphère Switch, merge the release ZIP into the SD root and restart. It replaces an existing ldn_mitm with the same module ID.
2. Open **LANywhere Self-host** from Album. The app opens in Appointments. Press **A** to join or leave, **L** to create, **Y** to mark Ready and **X** to find rooms. Each appointment stays listed until two hours after its scheduled start.
3. Press **B** to open the unified room lobby. Each room shows its source. Choose one, then search in the game's **Local Wireless** menu. New rooms use My server. Hosts can share or hide their room password.

Press **RS** to switch between English and Chinese. Choose **View guide** in the app for the controls. The overlay requires a compatible Tesla or Ultrahand setup. In-game room alerts require Ultrahand with API notifications enabled. [Pack and store integration](docs/distribution/INTEGRATORS.md).

Beta. Physical Switch cross-network joining remains unverified. See the [game candidates](compatibility/PLAYER-GAMES.txt) and [validation scope](docs/distribution/VALIDATION.md). This project is independent of Nintendo.

## Build and self-host

- Run `bash scripts/build-container.sh --embedded` to build the Switch app, sysmodule and overlay with the [pinned toolchain](scripts/toolchain/README.md).
- Run `npm start` with Node.js 22 or later. Forward TCP and UDP 11460. [Deployment guide](docs/DEPLOY.zh-CN.md).
- To target your own relay, edit [the relay profile](common/relay_profile.h) before building.

## Credits

Based on [LANywhere by augustocco](https://github.com/augustocco/lanywhere) and [ldn_mitm](https://github.com/spacemeowx2/ldn_mitm). [Third-party notices](third_party/README.md) · [GPL-2.0-only](LICENSE).

Development assisted by OpenAI Codex. Portions of the code were AI-generated.

## 中文

支持兼容的 Switch 游戏通过「本地无线」跨网联机。玩家可以提前约时间，省去一直在线开房等人的麻烦。可同时参加多场约局，临近开场按 **Y** 标记准备，再按 **X** 找房。启用 Ultrahand 的 API 通知后，开房时可收到游戏内提醒。

将 [发布页](https://github.com/SEc-123/lanywhere-selfhost/releases/latest) 的 SD 包解压合并到卡根目录，重启 Atmosphère 后从相册打开 **LANywhere Self-host**。安装会替换同模块 ID 的 ldn_mitm。默认进入约局首页，按 **A** 加入或退出，按 **L** 发起，开场后保留两小时。按 **B** 进入统一大厅，每张房卡会标明来源。选房后回游戏用「本地无线」搜索。新房默认使用自有网络，房主可选择公开或隐藏密码。

按 **RS** 切换中英文，应用右下角可查看教程。兼容的 Tesla 或 Ultrahand 可显示 LANywhere 浮层。此版本为测试版，Switch 实机跨线路加入仍待验证。
