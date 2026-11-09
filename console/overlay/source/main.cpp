/* Modified by LANywhere Self-host, 2026-11-07 to 2026-11-08. */
/* LANywhere Tesla status/control overlay. SPDX-License-Identifier: GPL-2.0-only */
#define TESLA_INIT_IMPL
#include <tesla.hpp>
#include "ldn.h"
#include "model.hpp"
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstring>
#include <string_view>

namespace {
    Service g_ldnSrv{}, g_relay{};
    LdnMitmConfigService g_config{};
    overlay::Snapshot g_snapshot{};
    RoomPasscodeHost g_passcode_host{};
    bool g_chinese = false, g_protocol_mismatch = false;
    char g_version[32]{};
    std::string g_notice;
    u64 g_notice_until = 0;
    u64 g_last_poll = 0;

    const char *tr(const char *english, const char *chinese) { return g_chinese ? chinese : english; }

    bool chinesePreference(const char *path, bool *found) {
        FILE *file = std::fopen(path, "rb");
        *found = file != nullptr;
        if (!file) return false;
        char value[32];
        size_t size = std::fread(value, 1, sizeof(value), file);
        const bool valid = std::feof(file) && !std::ferror(file);
        std::fclose(file);
        if (size && value[size - 1] == '\n') --size;
        if (size && value[size - 1] == '\r') --size;
        return valid && std::string_view(value, size) == "language=zh";
    }

    bool hasPasscodeHost() {
        return g_passcode_host.status == RoomPasscodeOk && g_passcode_host.room[0] != '\0';
    }

    void refresh() {
        g_snapshot.config_ok = false;
        g_snapshot.relay_ok = false;
        g_passcode_host = {};
        u32 enabled = 0, logging = 0;
        if (serviceIsActive(&g_config.s) && R_SUCCEEDED(ldnMitmGetEnabled(&g_config, &enabled)) &&
            R_SUCCEEDED(ldnMitmGetLogging(&g_config, &logging))) {
            g_snapshot.config_ok = true;
            g_snapshot.enabled = enabled != 0;
            g_snapshot.logging = logging != 0;
        }
        LanywhereOverlayStatus status{};
        LanywhereOverlayMatch match{};
        if (serviceIsActive(&g_relay) && R_SUCCEEDED(lanywhereOverlayGetStatus(&g_relay, &status)) &&
            R_SUCCEEDED(lanywhereOverlayGetMatch(&g_relay, &match))) {
            g_snapshot.relay_ok = true;
            g_snapshot.status = status;
            g_snapshot.match = match;
            if (status.state == 2 && status.my_index == 0 && status.game_id) {
                if (R_FAILED(lanywhereOverlayGetPasscodeHost(&g_relay, &g_passcode_host)) ||
                    std::memcmp(status.code, g_passcode_host.room, sizeof(status.code)))
                    g_passcode_host = {};
            }
        } else {
            g_snapshot.status = {};
            g_snapshot.match = {};
        }
        g_last_poll = armGetSystemTick();
    }

    void closeServices() {
        serviceClose(&g_relay);
        serviceClose(&g_config.s);
        serviceClose(&g_ldnSrv);
        g_snapshot = {};
        g_passcode_host = {};
    }

    void connectServices() {
        closeServices();
        g_version[0] = '\0';
        g_notice.clear();
        g_notice_until = 0;
        g_protocol_mismatch = false;
        tsl::hlp::doWithSmSession([] {
            bool present = false;
            if (R_SUCCEEDED(lanywhereOverlayHasService(&present, true)) && present &&
                R_SUCCEEDED(smGetService(&g_ldnSrv, "ldn:u")) &&
                R_SUCCEEDED(ldnMitmGetConfigFromService(&g_ldnSrv, &g_config))) {
                if (R_FAILED(ldnMitmGetVersion(&g_config, g_version))) g_version[0] = '\0';
            }
            if (R_SUCCEEDED(lanywhereOverlayHasService(&present, false)) && present &&
                R_SUCCEEDED(smGetService(&g_relay, "lanywhr"))) {
                u32 version = 0;
                if (R_FAILED(lanywhereOverlayGetProtocol(&g_relay, &version)) || version != LANYWHERE_OVERLAY_IPC_MAJOR) {
                    g_protocol_mismatch = true;
                    serviceClose(&g_relay);
                }
            }
        });
        refresh();
    }

    class SafeToggle : public tsl::elm::ToggleListItem {
        bool m_logging;
    public:
        explicit SafeToggle(bool logging) : ToggleListItem(logging ? tr("Logging", "记录日志") : tr("Plugin", "联机插件"), false,
                tr("On", "开启"), tr("Off", "关闭")), m_logging(logging) {}
        bool onClick(u64 keys) override {
            if (!(keys & HidNpadButton_A)) return false;
            refresh();
            if (!g_snapshot.config_ok || (!m_logging && !overlay::canChangeEnabled(g_snapshot))) {
                g_notice = !g_snapshot.config_ok ? tr("Module unavailable. Reconnect or restart the console.", "插件服务不可用，请重连或重启主机。") :
                    tr("Leave the game room and stop matching first.", "请先退出游戏房间并停止匹配。");
                g_notice_until = armGetSystemTick() + 5 * armGetSystemTickFreq();
                return true;
            }
            const bool next = !(m_logging ? g_snapshot.logging : g_snapshot.enabled);
            const Result result = m_logging ? ldnMitmSetLogging(&g_config, next) : ldnMitmSetEnabled(&g_config, next);
            refresh(); // Re-read on failure too; never display an optimistic toggle.
            const bool actual = m_logging ? g_snapshot.logging : g_snapshot.enabled;
            if (R_FAILED(result) || !g_snapshot.config_ok || actual != next)
                g_notice = tr("Change failed. Reconnect and try again.", "修改失败，请重新连接后再试。");
            else g_notice = m_logging ? tr("Logging updated.", "日志设置已更新。") :
                tr("Applies next time the game opens local wireless.", "下次进入游戏的本地联机时生效。");
            g_notice_until = armGetSystemTick() + 5 * armGetSystemTickFreq();
            this->setState(actual);
            return true;
        }
    };

    const char *connectionLabel() {
        if (!g_snapshot.relay_ok) return g_protocol_mismatch ? tr("Update required", "需要更新") : tr("Unavailable", "服务不可用");
        if (g_snapshot.status.state == 1)
            return !std::strcmp(g_snapshot.status.error, "Reconnecting to the room.") ?
                tr("Reconnecting", "正在重连") : tr("Connecting", "连接中");
        if (g_snapshot.status.state == 3) {
            if (!std::strcmp(g_snapshot.status.error, "Room session expired. Rejoin from the game."))
                return tr("Session expired", "会话已过期");
            if (!std::strcmp(g_snapshot.status.error, "Room changed during recovery. Rejoin from the game."))
                return tr("Room changed", "房间已变化");
            if (!std::strcmp(g_snapshot.status.error, "Could not reconnect. Check Wi-Fi and rejoin."))
                return tr("Reconnect failed", "重连未成功");
            return tr("Disconnected", "连接已断开");
        }
        if (g_snapshot.status.error[0]) return tr("Check connection", "连接需检查");
        switch (g_snapshot.status.state) {
            case 0: return tr("Not in a room", "未加入房间");
            case 1: return tr("Connecting", "连接中");
            case 2: return tr("In a room", "已加入房间");
            default: return tr("Disconnected", "连接已断开");
        }
    }
    const char *matchLabel() {
        if (!g_snapshot.relay_ok) return tr("Unavailable", "服务不可用");
        switch (g_snapshot.match.state) {
            case 1: return tr("Waiting for game", "等待游戏");
            case 2: return tr("Searching", "搜索中");
            case 3: return tr("Room found", "已找到房间");
            case 4: return tr("Joining", "加入中");
            case 5: return tr("Joined", "已加入");
            case 6: return tr("Expired", "已超时");
            case 8: return tr("Failed", "未成功");
            default: return tr("Off", "未匹配");
        }
    }

    class PasscodeGui : public tsl::Gui {
        static constexpr std::array<std::string_view, 4> Characters{
            "0123456789",
            "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
            "abcdefghijklmnopqrstuvwxyz",
            " !\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"
        };
        RoomPasscodeChange m_change{};
        size_t m_length{}, m_group{}, m_character{};
        bool m_hidden = true;
        tsl::elm::CategoryHeader *m_visibility{};
        tsl::elm::ListItem *m_code_first{}, *m_code_second{}, *m_picker{}, *m_feedback{};
        const char *m_message = "";

        static size_t cycle(size_t index, int step, size_t count) {
            return (static_cast<int>(index + count) + step) % count;
        }

        void submit(bool clear) {
            if (!clear && !m_length) {
                m_message = tr("Enter the game password.", "请输入游戏密码。");
                return;
            }
            refresh();
            if (!hasPasscodeHost() || std::memcmp(m_change.room, g_passcode_host.room, sizeof(m_change.room))) {
                m_message = tr("Room closed or changed.", "房间已关闭或变化。");
                return;
            }

            RoomAccessChange request{};
            std::memcpy(request.change.room, m_change.room, sizeof(request.change.room));
            if (!clear) std::memcpy(request.change.passcode, m_change.passcode, m_length);
            request.hidden = !clear && m_hidden;
            u32 status = RoomPasscodeUnavailable;
            if (R_FAILED(lanywhereOverlaySetRoomAccess(&g_relay, &request, &status)))
                status = RoomPasscodeUnavailable;
            switch (status) {
                case RoomPasscodeOk:
                    std::memset(m_change.passcode, 0, sizeof(m_change.passcode));
                    m_length = 0;
                    if (clear) m_message = tr("Password cleared.", "密码已清除。");
                    else if (m_hidden) m_message = tr("Password hidden.", "密码已隐藏。");
                    else m_message = tr("Password shared in lobby.", "密码已公开到大厅。");
                    g_notice = m_message;
                    g_notice_until = armGetSystemTick() + 5 * armGetSystemTickFreq();
                    break;
                case RoomPasscodeInvalid: m_message = tr("Invalid password.", "密码格式无效。"); break;
                case RoomPasscodeRoomUnavailable: m_message = tr("Room closed or changed.", "房间已关闭或变化。"); break;
                case RoomPasscodeNotHost: m_message = tr("Host in the game first.", "请先在游戏里建房。"); break;
                case RoomPasscodeBusy: m_message = tr("Try again in a moment.", "请稍后再试。"); break;
                default: m_message = tr("Could not save password.", "无法保存密码。"); break;
            }
        }

        void redraw() {
            const size_t first = std::min<size_t>(12, m_length);
            const auto segment = [&](size_t start, size_t count) {
                return count ? "[" + std::string(m_change.passcode + start, count) + "]" : "—";
            };
            m_visibility->setText(m_hidden ?
                tr("Hidden · Guests enter password", "隐藏 · 访客需输入密码") :
                tr("Shared · Visible in the lobby", "公开 · 大厅所有人可见"));
            m_code_first->setText(segment(0, first));
            m_code_second->setText(segment(first, m_length - first));
            const char current = Characters[m_group][m_character];
            const char *group_names[] = {
                tr("Digits", "数字"), tr("Uppercase", "大写"), tr("Lowercase", "小写"), tr("Symbols", "符号")
            };
            const std::string character = current == ' ' ? tr("Space", "空格") : std::string(1, current);
            m_picker->setValue(character + "  ·  " + group_names[m_group]);
            m_feedback->setText(m_message);
        }

    public:
        explicit PasscodeGui(const RoomPasscodeHost &host) {
            std::memcpy(m_change.room, host.room, sizeof(m_change.room));
        }

        tsl::elm::Element *createUI() override {
            auto *frame = new tsl::elm::OverlayFrame(tr("Game password", "游戏密码"),
                std::string(tr("Room ", "房间 ")) + m_change.room);
            auto *list = new tsl::elm::List();
            list->addItem(m_visibility = new tsl::elm::CategoryHeader(""));
            list->addItem(m_code_first = new tsl::elm::ListItem(""));
            list->addItem(m_code_second = new tsl::elm::ListItem(""));
            list->addItem(m_picker = new tsl::elm::ListItem(tr("Character", "字符")));
            list->addItem(new tsl::elm::ListItem(tr("←/→ Choose   A Add", "←/→ 选择   A 添加")));
            list->addItem(new tsl::elm::ListItem(tr("L/R Group   Y Delete", "L/R 字符组   Y 删除")));
            list->addItem(new tsl::elm::ListItem(tr("X Mode   + Save   − Clear", "X 模式   + 保存   − 清除")));
            list->addItem(m_feedback = new tsl::elm::ListItem(""));
            frame->setContent(list);
            redraw();
            return frame;
        }

        bool handleInput(u64 down, u64, const HidTouchState &, HidAnalogStickState, HidAnalogStickState) override {
            if (!down || (down & HidNpadButton_B)) return false;
            m_message = "";
            if (down & HidNpadButton_Plus) {
                submit(false);
            } else if (down & HidNpadButton_Minus) {
                submit(true);
            } else if (down & HidNpadButton_X) {
                m_hidden = !m_hidden;
            } else if (down & HidNpadButton_Y) {
                if (m_length) m_change.passcode[--m_length] = '\0';
            } else if (down & HidNpadButton_A) {
                if (m_length < sizeof(m_change.passcode))
                    m_change.passcode[m_length++] = Characters[m_group][m_character];
                else
                    m_message = tr("Maximum 24 characters.", "最多 24 个字符。");
            } else if (down & (HidNpadButton_L | HidNpadButton_R)) {
                m_group = cycle(m_group, down & HidNpadButton_R ? 1 : -1, Characters.size());
                m_character = 0;
            } else if (down & (HidNpadButton_AnyLeft | HidNpadButton_AnyRight)) {
                m_character = cycle(m_character, down & HidNpadButton_AnyRight ? 1 : -1, Characters[m_group].size());
            } else {
                return false;
            }
            redraw();
            return true;
        }
    };

    class MainGui : public tsl::Gui {
        tsl::elm::List *m_list{};
        tsl::elm::ListItem *m_connection{}, *m_room{}, *m_players{}, *m_match{}, *m_notice{}, *m_password{};
        SafeToggle *m_enabled{}, *m_logging{};

        void updatePasswordAction() {
            if (hasPasscodeHost() && !m_password) {
                m_password = new tsl::elm::ListItem(tr("Game password", "游戏密码"));
                m_password->setClickListener([](u64 keys) {
                    if (!(keys & HidNpadButton_A)) return false;
                    refresh();
                    if (hasPasscodeHost()) {
                        tsl::changeTo<PasscodeGui>(g_passcode_host);
                    } else {
                        g_notice = tr("Room closed or changed.", "房间已关闭或变化。");
                        g_notice_until = armGetSystemTick() + 5 * armGetSystemTickFreq();
                    }
                    return true;
                });
                m_list->addItem(m_password, 0, 5);
            } else if (!hasPasscodeHost() && m_password) {
                if (getFocusedElement() == m_password) {
                    removeFocus();
                    restoreFocus();
                }
                m_list->removeItem(m_password);
                m_password = nullptr;
            }
        }

    public:
        tsl::elm::Element *createUI() override {
            auto *frame = new tsl::elm::OverlayFrame("LANywhere", GITDESCVER);
            auto *list = m_list = new tsl::elm::List();
            list->addItem(new tsl::elm::CategoryHeader(tr("Current session", "当前连接")));
            list->addItem(m_connection = new tsl::elm::ListItem(tr("Connection", "连接")));
            list->addItem(m_room = new tsl::elm::ListItem(tr("Room", "房间")));
            list->addItem(m_players = new tsl::elm::ListItem(tr("Room members", "房间成员")));
            list->addItem(m_match = new tsl::elm::ListItem(tr("Match", "匹配")));
            list->addItem(new tsl::elm::CategoryHeader(tr("Controls", "控制")));
            list->addItem(m_enabled = new SafeToggle(false));
            list->addItem(m_logging = new SafeToggle(true));
            auto *retry = new tsl::elm::ListItem(tr("Reconnect to module", "重新连接插件"));
            retry->setClickListener([](u64 keys) {
                if (!(keys & HidNpadButton_A)) return false;
                connectServices();
                return true;
            });
            list->addItem(retry);
            list->addItem(m_notice = new tsl::elm::ListItem(""));
            list->addItem(new tsl::elm::CategoryHeader(tr("Rooms and networks: use the LANywhere app", "建房、选网络：打开 LANywhere 主应用")));
            list->addItem(new tsl::elm::ListItem(tr("Closing this overlay keeps your room connected.", "关闭浮层不会退出房间。")));
            frame->setContent(list);
            update();
            return frame;
        }
        void update() override {
            if (armGetSystemTick() - g_last_poll >= armGetSystemTickFreq()) refresh();
            if (!g_notice.empty() && armGetSystemTick() >= g_notice_until) g_notice.clear();
            updatePasswordAction();
            m_connection->setValue(connectionLabel(), !g_snapshot.relay_ok);
            const bool room = g_snapshot.relay_ok && g_snapshot.status.state == 2;
            m_room->setValue(room ? g_snapshot.status.code : "—", !room);
            char players[16]{};
            if (room) std::snprintf(players, sizeof(players), "%u / 8", g_snapshot.status.member_count);
            m_players->setValue(room ? players : "—", !room);
            m_match->setValue(matchLabel(), !g_snapshot.relay_ok);
            m_enabled->setState(g_snapshot.config_ok && g_snapshot.enabled);
            m_logging->setState(g_snapshot.config_ok && g_snapshot.logging);
            if (!g_snapshot.config_ok) {
                m_enabled->setValue(tr("Unavailable", "服务不可用"), true);
                m_logging->setValue(tr("Unavailable", "服务不可用"), true);
            }
            const char *notice = g_protocol_mismatch ? tr("Install the module and overlay from the same release.", "请使用同一版本的插件和浮层。") :
                !g_snapshot.config_ok ? tr("Module not loaded. Restart after installation.", "插件未加载，安装后请重启主机。") :
                g_snapshot.relay_ok && g_snapshot.status.state == 1 ? tr("Waiting for the room connection.", "正在等待房间连接。") :
                g_snapshot.relay_ok && g_snapshot.status.error[0] ? tr("Open LANywhere for connection details.", "请打开 LANywhere 查看连接详情。") :
                !g_notice.empty() ? g_notice.c_str() :
                tr("Plugin changes apply on the next local-wireless session.", "插件开关在下次本地联机时生效。");
            m_notice->setText(notice);
        }
    };

    class Overlay : public tsl::Overlay {
    public:
        void initServices() override {
            tsl::hlp::doWithSDCardHandle([] {
                bool found = false;
                g_chinese = chinesePreference("sdmc:/lanywhere/language.ini", &found);
                if (!found) g_chinese = chinesePreference("sdmc:/lanywhere/language.ini.previous", &found);
            });
            connectServices();
        }
        void exitServices() override { closeServices(); }
        void onShow() override { refresh(); }
        void onHide() override {} // Never leave a room or change settings when hidden.
        std::unique_ptr<tsl::Gui> loadInitialGui() override { return initially<MainGui>(); }
    };
}
int main(int argc, char **argv) { return tsl::loop<Overlay>(argc, argv); }
