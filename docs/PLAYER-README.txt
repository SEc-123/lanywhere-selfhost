Switch Online — 玩家安装与使用 / Player Guide

安装前：需要已配置并可启动的 Atmosphère 环境。请确认当前固件与 Atmosphère 兼容。

1. 解压后，将 atmosphere、switch、lanywhere 三个文件夹合并到 SD 卡根目录。
   同名文件选择覆盖；不要删除或整体替换原有 atmosphere 文件夹。
   本包会替换相同模块 ID 的旧版 ldn_mitm。
   不要把解压出来的外层文件夹直接复制进 SD 卡。
2. 重启主机，进入原有 Atmosphère 环境，从相册打开 LANywhere Self-host。
   已安装兼容的 Tesla Menu 或 Ultrahand？从其菜单打开 LANywhere 查看或切换本地无线接管。找房仍用相册应用。
3. 首次默认英文；点右上角语言按钮或按右摇杆 RS 切换中英文，选择会被记住。
   教程按 B 进入大厅，R 可重看。
@CONNECTION_ZH@
   房间名称优先读取本机或房主资料，缺少时查离线目录；不依赖 GAMES.txt 白名单。
   按左摇杆 LS 或点“网络”选择线路，默认“自有网络”，无需填写 IP。
4. 公开房：确认大厅「游戏建房」为公开（X 切换），在游戏中进入「本地无线」并创建房间；
   加入时在大厅选择房间按 A，再到游戏的本地无线界面搜索并加入。
5. 好友私房仅用于“自有网络/公共社区”：大厅按 Y，房主按 A 创建并分享邀请码；好友按 X 输入邀请码。
   双方选择同一网络，再打开游戏的本地无线。按 + 返回游戏，B 退出或取消。
   LAN Play 线路只使用游戏内的本地无线房间，不提供邀请码或快速匹配预留。
   “本机可匹配”表示本地候选，不代表旧外部房主已提供准确游戏名。
   线上找房不会同时搜索附近局域网；仅附近联机时，先离开线上房间并选择“仅本地”。

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
   Press B to close the guide and enter the lobby; press R to reopen it.
@CONNECTION_EN@
   Names use local or host metadata first, then the offline catalog. GAMES.txt is not an allowlist.
   Press the left stick (LS), or tap Network, to choose a community. My server is the default; no IP setup.
4. Public: check Game room visibility is Public (X toggles it); create a room in the game's Local Wireless mode.
   To join, select a lobby room and press A, then search and join in the game's Local Wireless screen.
5. Friends codes work on My server / Public community: press Y, then A to create or X to enter a code.
   Choose the same network, then use Local Wireless in the game. + returns to the game; B cancels or leaves.
   LAN Play uses in-game Local Wireless rooms, without invite codes or reserved Quick match.
   Local match means a compatible local candidate, not a confirmed remote game title.
   Online searches do not include nearby LAN rooms; leave online rooms and select Local only for nearby play.

See the examples above and GAMES.txt for the full collected Local Wireless candidate list, not confirmed compatibility.
Games verified in real two-console matches with this plugin: 0.

外部线路为实验接入：线路协议测试不代表游戏实机通过；部分国际线路的大 UDP 包可能丢片。旧版 TCP 隧道无确认和重传保证。
External communities are experimental: protocol tests do not certify games; large UDP may lose fragments. Legacy TCP tunnels have no ACK or retransmission guarantee.
