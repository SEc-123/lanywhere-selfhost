/* Modified by LANywhere Self-host, 2026-11-07 to 2026-11-08. */
/* LANywhere Tesla status/control overlay. SPDX-License-Identifier: GPL-2.0-only */
#define TESLA_INIT_IMPL
#include <tesla.hpp>
#include "ldn.h"
#include "model.hpp"

namespace {
    Service g_ldnSrv{}, g_relay{};
    LdnMitmConfigService g_config{};
    overlay::Snapshot g_snapshot{};
    bool g_chinese = false, g_protocol_mismatch = false;
    char g_version[32]{};
    std::string g_notice;
    u64 g_notice_until = 0;
    u64 g_last_poll = 0;

    const char *tr(const char *english, const char *chinese) { return g_chinese ? chinese : english; }

    void refresh() {
        g_snapshot.config_ok = false;
        g_snapshot.relay_ok = false;
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

    class MainGui : public tsl::Gui {
        tsl::elm::ListItem *m_connection{}, *m_room{}, *m_players{}, *m_match{}, *m_notice{};
        SafeToggle *m_enabled{}, *m_logging{};
    public:
        tsl::elm::Element *createUI() override {
            auto *frame = new tsl::elm::OverlayFrame("LANywhere", GITDESCVER);
            auto *list = new tsl::elm::List();
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
            tsl::hlp::doWithSmSession([] {
                if (R_SUCCEEDED(setInitialize())) {
                    u64 code = 0; SetLanguage language = SetLanguage_ENUS;
                    if (R_SUCCEEDED(setGetSystemLanguage(&code)) && R_SUCCEEDED(setMakeLanguage(code, &language)))
                        g_chinese = language == SetLanguage_ZHCN || language == SetLanguage_ZHHANS ||
                                    language == SetLanguage_ZHTW || language == SetLanguage_ZHHANT;
                    setExit();
                }
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
