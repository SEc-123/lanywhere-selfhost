- Update the Atmosphère-libs startup version table for HOS 23.5.0. On compatible Atmosphère, LANywhere 0.5.7 would stop before registering its services.
- The host startup test accepts 23.5.0 after this update. Switch hardware boot and two-console play on this firmware still need verification.

For HOS 23.5.0 use an appropriate Atmosphère 1.12.2 boot chain. Merge the matched LANywhere package into the SD root and restart. [Compatibility details](HOS-COMPATIBILITY.md)

- 更新后台模块内置的 Atmosphère-libs 固件识别表。0.5.7 在 HOS 23.5.0 会在注册服务前中止。
- 主机启动测试已验证新版通过 23.5.0 的版本检查。实机启动及双机联机仍需验证。

HOS 23.5.0 请使用支持该固件的 Atmosphère 1.12.2 启动环境。将同一版本的 LANywhere 安装包合并到 SD 卡根目录后重启。
