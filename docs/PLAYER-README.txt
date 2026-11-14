Switch Online — 玩家安装与使用 / Player Guide

安装前：需要已配置并可启动的 Atmosphère 环境。请确认当前固件与 Atmosphère 兼容。

1. 解压后，将 atmosphere、switch、lanywhere 三个文件夹合并到 SD 卡根目录。
   同名文件选择覆盖；不要删除或整体替换原有 atmosphere 文件夹。
   本包会替换相同模块 ID 的旧版 ldn_mitm。
   不要把解压出来的外层文件夹直接复制进 SD 卡。
2. 重启主机，进入原有 Atmosphère 环境，从相册打开 LANywhere Self-host。
   已安装兼容的 Tesla Menu 或 Ultrahand？从其菜单打开 LANywhere 查看或切换本地无线接管。找房仍用相册应用。
3. 首次默认英文。点右上角或按右摇杆 RS 切换中英文。
   启动后显示约局。按 B 看房间大厅，右下角「查看教程」可随时打开。
@CONNECTION_ZH@
   房间名称优先读取本机或房主资料，缺少时查离线目录；不依赖 GAMES.txt 白名单。
   房间大厅汇总自有网络和各外部来源，每张房卡会标明线路。
4. 在游戏中用「本地无线」建房。新房默认使用自有网络，并自动列在大厅。
   房主可在 LANywhere 主应用或浮层设置游戏密码，并选择公开或隐藏。
   公开时大厅显示密码。隐藏时房间仍可见，访客须先输入正确密码。
   加入时在大厅选房，线路会随房间选定。回游戏用本地无线搜索，再按游戏提示加入。
5. 外部房间使用来源服务器的联机规则。需要密码的自有房可在大厅先验证。
   只和附近主机联机时，可以在浮层关闭本地无线接管。

大厅显示「建房线路」时，可在进游戏前按 Y 选择「自有网络」或可用的社区线路。
选「社区 · LANywhere」开房后，双方 Switch 直连该节点。密码在游戏内使用。
约局开房提醒和大厅共享密码用「自有网络」。

宝可梦「连接交换」等双人搜索从游戏内发起。两台都开启 LANywhere 接管，
使用本地通信，在游戏内输入相同连接码并开始寻找。双机交换仍待实测。

在首页直接点约局右侧「参加」，或按 A 参加选中的一场。可以参加多场，再点一次即可取消。
按 L 发起约局，进入选游戏和时间的页面。时间按本机时区显示。
约局开场后保留 2 小时，到期会从列表消失。
临近开场可按 Y 准备，状态保留 5 分钟。按 X 查看约局对应的自有网络房间。
参加后可收开房提醒。监听从开场前 30 分钟开始，到开场后 2 小时结束。
房主在约局中按 Y 准备，再开同款游戏的公开房，可以把房间关联到那一场。
关联房只提醒那一场。普通公开房按同款游戏匹配。房间开放或腾出空位时会发出提醒。
启动 Ultrahand 并开启 API 通知后，约局页右侧可查看提醒连接状态。
Ultrahand 下载：https://github.com/ppkantorski/Ultrahand-Overlay/releases

候选示例 / Candidate examples（有本地无线资料，插件兼容性尚未验证）：
Dying Light: Platinum Edition · Mario Kart 8 Deluxe · Monster Hunter Rise · Monster Hunter Generations Ultimate
Animal Crossing: New Horizons · Super Smash Bros. Ultimate · Stardew Valley · Luigi's Mansion 3
Overcooked! 2 · Diablo III: Eternal Collection · Mario Party Superstars · Kirby Fighters 2
Pokémon Scarlet · Pokémon Violet · Borderlands 2: Game of the Year Edition · Dragon Ball FighterZ
完整名单见根目录 GAMES.txt：这些游戏有本地无线资料，尚未证明插件兼容。
本插件当前已完成真实双主机对局验证的游戏：0 款。

Requires an already working Atmosphère setup compatible with your console firmware.

1. Extract the ZIP. Merge the atmosphere, switch and lanywhere folders into the SD card root.
   Overwrite matching files; do not delete or replace the whole existing atmosphere folder.
   This package replaces an existing ldn_mitm with the same module ID.
   Do not copy the outer extracted folder as another level on the SD card.
2. Restart into your existing Atmosphère environment and open LANywhere Self-host from Album.
   Already have a compatible Tesla Menu or Ultrahand setup? Open LANywhere there to check or toggle local wireless interception. Use the Album app to find rooms.
3. English is the first-run default. Tap the top-right language control or press the right stick (RS)
   to switch between Chinese and English; your selection is remembered.
   The app opens Appointments. Press B for the room lobby.
   Select View guide at the bottom right to open the tutorial.
@CONNECTION_EN@
   Names use local or host metadata first, then the offline catalog. GAMES.txt is not an allowlist.
   The room lobby combines My server and external networks. Each room shows its source.
4. Host from the game's Local Wireless menu. New rooms appear in the lobby on My server.
   The host can set a game password in LANywhere or its overlay and choose Shared or Hidden.
   Shared shows the password. Hidden keeps the room visible and asks guests to enter the password before joining.
   Select a room to use its network, then search from the game's Local Wireless menu.
5. External rooms follow their source network rules. Enter protected My server passwords in the lobby.
   To play directly with nearby consoles, turn off interception in the overlay.

When Hosting line is available, press Y before starting the game to choose My server or an available community line.
On Community · LANywhere, both consoles connect to the community node. Use the password in the game.
Use My server for appointment alerts and lobby password sharing.

For in-game pairing such as Pokémon Link Trade, enable interception on both consoles.
In the game, choose local communication, enter the same link code and start searching.
Completing a trade on two Switch consoles is still unverified.

Tap Join beside any appointment, or press A on the selected one. Join several or tap again to leave.
Press L to open the game and time picker. Times use your console's time zone.
Appointments stay in the list for 2 hours after their start time.
Press Y to mark Ready near the start. Ready lasts 5 minutes. Press X for this appointment’s My server rooms.
Joined appointments can receive room alerts from 30 minutes before start until 2 hours after.
Hosts can mark Ready for an appointment before opening a public room for that game to link it.
Linked rooms alert that appointment. Ordinary public rooms match by game. Alerts are sent when a room opens or frees a seat.
Start Ultrahand with API notifications enabled and check the alert status on the appointment page.
Ultrahand download: https://github.com/ppkantorski/Ultrahand-Overlay/releases

See the examples above and GAMES.txt for the full collected Local Wireless candidate list, not confirmed compatibility.
Games verified in real two-console matches with this plugin: 0.

外部线路为实验接入：线路协议测试不代表游戏实机通过；部分国际线路的大 UDP 包可能丢片。旧版 TCP 隧道无确认和重传保证。
External communities are experimental: protocol tests do not certify games; large UDP may lose fragments. Legacy TCP tunnels have no ACK or retransmission guarantee.
