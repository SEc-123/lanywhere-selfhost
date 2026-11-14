#include <stdio.h>
#include "guide.h"
#include "gfx.h"

typedef struct { const char *title, *steps[3], *key; } GuidePage;
static const GuidePage pages_zh[] = {
    { "创建房间", {
        "开房前可在大厅按 Y 切换线路。默认使用自有网络。",
        "回到游戏，在“本地无线”里创建房间。",
        "房间会按线路列在统一大厅。"
    }, "社区线路使用游戏内密码。约局开房提醒请用自有网络。" },
    { "加入房间", {
        "在大厅按 A 选房，线路按房间来源自动切换。",
        "打开对应游戏，进入“本地无线”。",
        "搜索房间，按游戏提示加入。"
    }, "受保护的房间先在大厅验证。游戏若再要求，输入相同密码。" },
    { "游戏内配对", {
        "两台都开启 LANywhere 的本地无线接管。",
        "在游戏里选本地通信，输入相同连接码。",
        "两台都在游戏里开始寻找。"
    }, "适用于宝可梦连接交换等游戏内双人搜索。" },
    { "游戏密码", {
        "“在大厅分享”会让选房的玩家看到密码。",
        "“隐藏密码”需要玩家向房主获取密码。",
        "留空并确认可清除大厅中的密码设置。"
    }, "只隐藏密码。房间仍显示在大厅。" },
    { "约局", {
        "打开应用即进入约局。大厅按十字键左可返回。",
        "选中约局按 A 加入或退出。按 L 发起新约局。",
        "开场前 30 分钟起按 Y 准备，临近开场按 X 找房。"
    }, "加入可收开房提醒。房主按 Y 准备后开房可关联约局。" },
    { "连不上", {
        "确认联网，尽量使用相同游戏版本。",
        "使用“本地无线”，别选游戏的官方在线模式。",
        "仍失败：退出游戏房间，再重新选择或创建。"
    }, "来源暂不可用时，仍可查看其他来源的房间。" },
};
static const GuidePage pages_en[] = {
    { "Host a room", {
        "Before hosting, press Y if a hosting line is shown. Default: My server.",
        "Return to the game and create a room in Local Wireless.",
        "Your room appears in All rooms under its hosting line."
    }, "On Community, use the game's password. For room alerts, host on My server." },
    { "Join a room", {
        "Select with A. The lobby uses that room's source.",
        "Open the matching game and enter Local Wireless.",
        "Search for rooms and follow the game's prompts."
    }, "Unlock protected rooms in the lobby. Enter the same password in game if asked." },
    { "Pair in game", {
        "Enable LANywhere interception on both consoles.",
        "Choose local communication and enter the same link code.",
        "Start searching from the game on both consoles."
    }, "For in-game pairing such as Pokémon Link Trade." },
    { "Game passwords", {
        "Share in lobby lets players see the password.",
        "Keep password hidden: players ask the host for it.",
        "Leave it blank to clear the lobby password setting."
    }, "Hiding the password keeps the room visible in the lobby." },
    { "Appointments", {
        "The app opens in Appointments. D-pad Left reopens it.",
        "A to join or leave a selected appointment. L to create.",
        "Y for Ready from 30 min before. X to find rooms."
    }, "Join for room alerts. Hosts can mark Ready before opening a room to link it." },
    { "Cannot connect?", {
        "Check internet. Use the same game version where possible.",
        "Choose Local Wireless in the game's menu.",
        "Still stuck? Leave the in-game room, then choose or host again."
    }, "Rooms from other sources still appear when a source is unavailable." },
};

enum { PageCount = sizeof(pages_zh) / sizeof(pages_zh[0]), Margin = 56, Footer = 648 };
static int page_index(int page) { return page < 0 ? 0 : page >= PageCount ? PageCount - 1 : page; }
int guide_page_count(void) { return PageCount; }

void guide_draw_language(bool chinese)
{
    gfx_round_rect(1056, 40, 168, 44, 18, RGBA(0xFF, 0xFF, 0xFF, 0x0A));
    gfx_button(1068, 47, "RS", chinese ? "English" : "中文");
}

void guide_draw(int page, bool chinese, bool spanish)
{
    (void)spanish;
    page = page_index(page);
    const GuidePage *p = &(chinese ? pages_zh : pages_en)[page];
    const u32 text = RGBA(0xF2, 0xF3, 0xF7, 0xFF), dim = RGBA(0x9A, 0xA0, 0xB0, 0xFF);
    const u32 accent = RGBA(0x8B, 0x5C, 0xF6, 0xFF), panel = RGBA(0xFF, 0xFF, 0xFF, 0x0A);
    gfx_clear_gradient(RGBA(0x1B, 0x22, 0x36, 0xFF), RGBA(0x0F, 0x12, 0x1C, 0xFF));
    gfx_text(Margin, 42, 24, dim, chinese ? "LANywhere · 使用教程" : "LANywhere · How to play");
    guide_draw_language(chinese);
    char position[20];
    snprintf(position, sizeof(position), "%d / %d", page + 1, PageCount);
    gfx_text(GFX_W - Margin - gfx_text_width(24, position), 128, 24, dim, position);
    gfx_text(Margin, 120, 40, text, p->title);
    for (int i = 0; i < 3; i++) {
        const int y = 228 + i * 92;
        char number[2] = { (char)('1' + i), 0 };
        gfx_round_rect(Margin, y - 4, 48, 48, 24, accent);
        gfx_text(Margin + (48 - gfx_text_width(26, number)) / 2, y + 6, 26, text, number);
        gfx_text(Margin + 72, y + 5, 28, text, p->steps[i]);
    }
    gfx_round_rect(Margin, 532, GFX_W - Margin * 2, 68, 18, panel);
    gfx_text(Margin + 24, 553, 23, dim, p->key);
    gfx_rect(0, Footer, GFX_W, 1, RGBA(0xFF, 0xFF, 0xFF, 0x1C));
    if (page > 0) gfx_button(Margin, Footer + 20, "ZL", chinese ? "上一页" : "Previous");
    if (page + 1 < PageCount) gfx_button(856, Footer + 20, "ZR", chinese ? "下一页" : "Next");
    gfx_button(1090, Footer + 20, "B", chinese ? "返回" : "Back");
}

u64 guide_touch_action(int x, int y, int page)
{
    page = page_index(page);
    if (x >= 1056 && x < 1224 && y >= 40 && y < 84) return HidNpadButton_StickR;
    if (y < Footer + 8 || y >= Footer + 64) return 0;
    if (x >= 48 && x < 268 && page > 0) return HidNpadButton_ZL;
    if (x >= 844 && x < 1054 && page + 1 < PageCount) return HidNpadButton_ZR;
    if (x >= 1074 && x < 1232) return HidNpadButton_B;
    return 0;
}
