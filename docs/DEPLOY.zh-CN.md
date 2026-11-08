# 自建中继

需要公网 Linux 主机和 Node.js 22+。Switch 与中继之间使用 TCP 和 UDP 11460。

```bash
npm start
```

也可用 [systemd 安装脚本](../deploy/install-systemd.sh) 持久运行。复制 [环境示例](../deploy/relay.env.example) 后按实际容量调整。管理端口 11461、11462 只绑定回环地址，公网仅开放游戏需要的端口。

玩家版服务器地址位于 [relay_profile.h](../common/relay_profile.h)。要连接自己的服务，修改 IPv4 和端口后，用固定容器一起重编应用与后台模块：

```bash
bash scripts/build-container.sh --embedded
```

解压生成的 SD 包到卡根目录，重启 Atmosphère，从相册打开 **LANywhere Self-host**。两台主机选择同一网络，在同版本游戏的本地无线模式中验证建房、加入和完整对局。

自建服不会同步公开实例的房间。对局协议目前未加密。
