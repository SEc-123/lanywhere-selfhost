# Stage3 公共社区名称交接

基于main bb36c06，修改3文件：upstream-gateway.js、test-upstream-gateway.js、smoke-upstream.cjs。只需发布更新后的upstream-gateway.js；其复用已在发布依赖中的room-metadata.js，没有新增运行时文件。未自行commit或部署。

## 前端能力与真实上游分开

- self=127；LANPlay子realm=78；旧公共LANywhere适配器=64。
- 公共上游真实CAPS仍ERROR4/0。64仅来自我方网关持有的房主metadata，不是上游原生能力。
- 不启V2、原子席位预留、完整分页；legacy UDP保持1455上限，旧FIND返回体不改。
- META_PAGE offset必须0；实际发上游旧FIND15bytes，响应每条真实code/LCID/NetworkInfo转336bytes摘要。旧服最多6条，next=END，不编造更多页或完整目录。

## 绑定和清理

META_SET复用room-metadata.parse的严格UTF8/控制字符/NUL-padding验证。只允许当前真实上游ROOM index0代理成员；声明存在该成员token记录内，绑定provider+code+LCID+index+IP/remote token。按房主4次变更/分钟，同内容幂等。

摘要只附加当前活跃、上游hostIP和LCID匹配的代理房主声明；外部原生host永远为空。不同provider即使指向同一上游也不借用声明。LEAVE和55秒租约失效forget时清除；同身份RESUME保留，身份变化拒绝。列表查询单路串行；错误清pending，2.5秒超时关闭连接避免晚到GROUPS污染下一查询。

两个真实问题一起闭环：
1. 旧房间的合法MEMBER_LEFT/成员加入通知可能在主动LEAVE后晚到。现在仅在该空房窗口忽略；新ROOM到达结束窗口，格式错误仍拒绝。增加延迟通知回归。
2. 公共上游连接实测出现TCP重传延迟，原3秒整体握手偶尔超时；该固定provider改为8秒。native外部SELECT14秒由root同步；其他RPC/次数/并发没有放宽。只读CAPS实测connect1311ms、reply1599ms见direct-caps-timing.json。

## 验证

本地覆盖同时两个同LCID/不同AppID与标题、无本机游戏库访客准确读名、外部原始host无META、非房主和非法文本拒绝、跨provider隔离、离房后复用相同code/IP/LCID无旧声明、同身份resume及TTL、串行查询/错误/超时、旧FIND兼容、离房晚到通知。

真实云服loopback gateway→129.38.114.182公开服仅建自有组：私房/旧UDP64/1400/1455/恢复通过；两个先后创建的公开房间共享LCID但返回各自AppID/title；访客仅读网络摘要，无本机库；房主恢复保留名、离房消失；直接旧客户端的自有外部host返回空META。原上游CAP0与adapter64均实际验证。不是Switch真机对局或真实NACP采集验收。

初次工具PING在SELECT阶段早发的竞态已修，背景PING只在握手完成后启动；所有失败报告保留，成功报告stage3-public-wire.json。实际测试同时最多两个公共peer，结束全部LEAVE/close；临时gateway退出0、目录删除、生产11460PID保持。

最终回归命令：node --test --test-timeout=45000 server/relay/test-*.js。最终输出final-tests.txt；文件SHA见stage3-summary.json。
