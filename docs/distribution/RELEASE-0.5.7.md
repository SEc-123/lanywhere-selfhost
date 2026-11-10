- Get a room alert when a scheduled game opens a room or a seat frees up. Alerts use relay time and recover after a disconnect. Ultrahand API notifications are required for the on-screen alert.
- Fixed an invalid thread priority that could crash Atmosphère after joining an appointment and again on reboot. Booting into emuMMC, using the appointment buttons and rebooting passed on a physical Switch.
- In-game Local Wireless search now defaults to the same relay as automatic hosting. This covers games that pair from their own menu, such as Pokémon Link Trade. Relay tests passed. A physical two-console trade is still pending.

Merge the SD ZIP into the SD root and restart Atmosphère. The integrator ZIP contains only the install files. [Integration guide](https://github.com/SEc-123/lanywhere-selfhost/blob/v0.5.7/docs/distribution/INTEGRATORS.md)

- 约局开房或腾出空位时，服务器会主动推送提醒，断线重连后可补收。游戏内弹窗需要启用 Ultrahand 的 API 通知。
- 修复约局线程优先级错误引发的崩溃和重启循环。虚拟系统启动、约局按键和再次重启已通过实机验证。
- 游戏内搜索默认与自动建房使用同一服务器，适用于宝可梦连接交换这类游戏内配对。中继测试已通过，双机实测待确认。

将 SD 包解压合并到卡根目录后重启 Atmosphère。整合包可使用仅含安装文件的 ZIP。
