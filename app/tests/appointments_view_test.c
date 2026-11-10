#define _POSIX_C_SOURCE 200809L
#include "appointments_model.h"
#include "appointments_view.h"
#include "gfx.h"
#include "title_inventory.h"
#include "ui_text.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

static const u64 now = 1794227820; /* 2026-11-09 12:37 UTC */
static const u64 local_offset = 8 * 3600;
static const u64 lcid = 0x0100a3d008c5c000;
static const u64 scarlet = 0x0100a3d008c5c000;
static const u64 violet = 0x01008f6008c5e000;
static u64 tick = 1000, game;
static AppointmentResponse page;
static AppointmentRequest last;
static AppointmentWatchRequest last_subscription;
static AppointmentSubscriptions subscriptions;
static unsigned exchanges, subscription_updates;
static bool disconnect, bad_subscriptions;
static u32 subscription_result, alert_status;
static const char *expected[8];

Result mock_appointment_dispatch_in_out(Service *service, unsigned command, const void *request, size_t size,
                                        void *output, size_t output_size)
{
    assert(service && command == APPOINTMENT_IPC_SUBSCRIBE && size == sizeof(last_subscription));
    assert(output_size == sizeof(u32));
    memcpy(&last_subscription, request, size);
    assert(last_subscription.id && last_subscription.starts_at && last_subscription.game_id == lcid);
    assert(last_subscription.app_id == scarlet || last_subscription.app_id == violet);
    assert(last_subscription.enabled <= 1 && !last_subscription.reserved);
    subscription_updates++;
    memcpy(output, &subscription_result, sizeof(subscription_result));
    if (subscription_result != AppointmentOk) return 0;
    size_t index = 0;
    while (index < subscriptions.count && subscriptions.ids[index] != last_subscription.id) ++index;
    if (last_subscription.enabled && index == subscriptions.count) {
        assert(subscriptions.count < APPOINTMENT_SUBSCRIPTION_LIMIT);
        subscriptions.ids[subscriptions.count++] = last_subscription.id;
    } else if (!last_subscription.enabled && index < subscriptions.count) {
        for (; index + 1 < subscriptions.count; ++index)
            subscriptions.ids[index] = subscriptions.ids[index + 1];
        subscriptions.ids[--subscriptions.count] = 0;
    }
    return 0;
}

Result mock_appointment_dispatch_out(Service *service, unsigned command, void *output, size_t size)
{
    assert(service && command == APPOINTMENT_IPC_ALERT_STATE && size == sizeof(alert_status));
    memcpy(output, &alert_status, size);
    return 0;
}

Result mock_appointment_dispatch(Service *service, unsigned command, AppointmentTestDispatch dispatch)
{
    assert(service);
    if (command == APPOINTMENT_IPC_SUBSCRIPTIONS) {
        assert(dispatch.buffer_attrs[0] == (SfBufferAttr_HipcMapAlias | SfBufferAttr_Out));
        assert(dispatch.buffers[0].size == sizeof(subscriptions));
        AppointmentSubscriptions reply = subscriptions;
        if (bad_subscriptions) reply.count = APPOINTMENT_SUBSCRIPTION_LIMIT + 1;
        memcpy(dispatch.buffers[0].pointer, &reply, sizeof(reply));
        return 0;
    }
    assert(command == APPOINTMENT_IPC_EXCHANGE);
    assert(dispatch.buffer_attrs[0] == (SfBufferAttr_HipcMapAlias | SfBufferAttr_In));
    assert(dispatch.buffer_attrs[1] == (SfBufferAttr_HipcMapAlias | SfBufferAttr_Out));
    assert(dispatch.buffers[0].size == sizeof(AppointmentRequest));
    assert(dispatch.buffers[1].size == sizeof(AppointmentResponse));
    memcpy(&last, dispatch.buffers[0].pointer, sizeof(last));
    for (size_t i = 0; i < sizeof(last.participant); i++) assert(last.participant[i] == 0);
    for (size_t i = 0; i < sizeof(last.reserved); i++) assert(last.reserved[i] == 0);
    exchanges++;
    if (disconnect) return 1;
    switch (last.op) {
    case AppointmentList:
        assert(!last.offset);
        break;
    case AppointmentFollow:
    case AppointmentUnfollow:
        for (u32 i = 0; i < page.count; i++) {
            AppointmentRow *row = &page.rows[i];
            if (row->id != last.id) continue;
            row->followed = last.op == AppointmentFollow;
            row->interested = row->followed;
            break;
        }
        break;
    case AppointmentCreate:
        assert(last.game_id == lcid && last.app_id == violet);
        assert(last.starts_at == now + 73 * 60);
        page.rows[2] = (AppointmentRow){3, last.starts_at, lcid, violet, 0, 0, {0}};
        page.count = 3;
        break;
    default:
        assert(false);
    }
    memcpy(dispatch.buffers[1].pointer, &page, sizeof(page));
    return 0;
}

Result timeToCalendarTimeWithMyRule(u64 utc, TimeCalendarTime *out, TimeCalendarAdditionalInfo *info)
{
    time_t local = (time_t)(utc + local_offset);
    struct tm calendar;
    assert(gmtime_r(&local, &calendar));
    *out = (TimeCalendarTime){calendar.tm_year + 1900, calendar.tm_mon + 1, calendar.tm_mday,
                              calendar.tm_hour, calendar.tm_min, calendar.tm_sec, 0};
    info->offset = (s32)local_offset;
    return 0;
}

Result timeToPosixTimeWithMyRule(const TimeCalendarTime *local, u64 *times, s32 capacity, s32 *count)
{
    assert(local->year == 2026 && local->month == 11 && local->day == 9);
    assert(local->hour == 21 && local->minute == 50 && !local->second);
    assert(capacity == 2);
    times[0] = now + 73 * 60;
    *count = 1;
    return 0;
}

int title_inventory_appointments_at(const char *path, u32 offset, GameCacheRecord *out,
                                    size_t capacity, bool *has_more)
{
    assert(strcmp(path, GAME_CACHE_PATH) == 0 && !offset && capacity >= 1);
    out[0] = (GameCacheRecord){.application_id = violet, .local_communication_ids = {0, UINT64_MAX, lcid},
                              .names = {"Pokémon Violet", "宝可梦 紫"}};
    *has_more = false;
    return 1;
}

static void capture(const char *s)
{
    for (size_t i = 0; i < sizeof(expected) / sizeof(*expected); i++)
        if (expected[i] && strcmp(s, expected[i]) == 0) expected[i] = NULL;
}

int gfx_text(int x, int y, int size, u32 color, const char *text)
{
    assert(x >= 0 && y >= 0 && size > 0 && color);
    capture(text);
    return 0;
}

void gfx_text_fit(int x, int y, int size, u32 color, const char *text, int width)
{
    assert(width > 0);
    gfx_text(x, y, size, color, text);
}

int gfx_text_width(int size, const char *label)
{
    return (int)strlen(label) * (size / 2);
}

int gfx_button(int x, int y, const char *button, const char *label)
{
    assert(x >= 0 && y >= 0 && *button);
    capture(label);
    return 140;
}

void gfx_round_rect(int x, int y, int w, int h, int radius, u32 color)
{
    assert(radius > 0);
    gfx_rect(x, y, w, h, color);
}

void gfx_rect(int x, int y, int w, int h, u32 color)
{
    assert(x >= 0 && y >= 0 && w > 0 && h > 0 && color);
}

static bool guide_tap, refresh_tap;
static u64 join_taps[APPOINTMENT_PAGE_SIZE];
static void touch(int x, int y, int w, int h, u64 action)
{
    assert(x >= 0 && y >= 0 && x + w <= GFX_W && y + h <= GFX_H && action);
    if (action == HidNpadButton_Right && x > 1000 && y > 648) guide_tap = true;
    if (action == HidNpadButton_R && x > 820 && y > 648) refresh_tap = true;
    if (action & APPOINTMENT_TOUCH_JOIN) {
        assert((action & 0xff) < APPOINTMENT_PAGE_SIZE && x > 620 && x + w < 816);
        join_taps[action & 0xff] = action;
    }
}

static void check_draw(const char *heading, const char *action, const char *row)
{
    GameCatalog catalog = {0};
    expected[0] = heading;
    expected[1] = action;
    expected[2] = row;
    memset(join_taps, 0, sizeof(join_taps));
    appointments_draw(&catalog, touch);
    assert(!expected[0] && !expected[1] && !expected[2]);
}

static AppointmentAction press(u64 button)
{
    return appointments_input(button, button, ++tick, false, false, &game);
}

static void exchange(u8 op)
{
    Service service = {0};
    assert(appointments_worker_exchange(&service));
    assert(!appointments_worker_exchange(&service));
    if (op) assert(last.op == op);
    assert(appointments_tick(++tick));
}

int main(void)
{
    assert(!appointment_rooms_open(now, now - APPOINTMENT_EARLY_SECONDS - 1));
    assert(appointment_rooms_open(now, now - APPOINTMENT_EARLY_SECONDS));
    assert(appointment_rooms_open(now, now + APPOINTMENT_ACTIVE_SECONDS - 1));
    assert(!appointment_rooms_open(now, now + APPOINTMENT_ACTIVE_SECONDS));
    AppointmentDate leap = appointment_date_after((AppointmentDate){2028, 2, 28}, 1);
    assert(leap.year == 2028 && leap.month == 2 && leap.day == 29);
    AppointmentDate new_year = appointment_date_after((AppointmentDate){2026, 12, 31}, 1);
    assert(new_year.year == 2027 && new_year.month == 1 && new_year.day == 1);

    page = (AppointmentResponse){
        .status = AppointmentOk, .count = 2, .next = APPOINTMENT_END, .now = now,
        .rows = {{1, now + 25 * 60, lcid, scarlet, 0, 0, {0}},
                 {2, now + 73 * 60, lcid, scarlet, 0, 0, {0}}}};
    UEvent wake = {0};
    appointments_init(&wake);
    appointments_open(true, false);
    assert(appointments_active() && appointments_list_active() && appointments_tick(tick));
    exchange(AppointmentList);
    check_draw("View guide", "Back to lobby", "Refresh");
    assert(guide_tap && refresh_tap);
    assert(wake.signals >= 2);
    check_draw("Appointments", "Join appointment", "2026-11-09  21:02");
    assert(join_taps[0] && join_taps[1]);
    assert(press(HidNpadButton_X) == AppointmentFindRooms && game == lcid);
    assert(press(HidNpadButton_A) == AppointmentStay);
    exchange(0);
    assert(last_subscription.id == 1 && last_subscription.enabled && subscriptions.count == 1);
    check_draw("Appointments", "Leave appointment", "Appointment joined.");
    check_draw("Appointments", "Leave appointment", "Start Ultrahand with API notifications.");
    alert_status = AppointmentAlertConnected;

    // The other row joins directly without moving the controller selection.
    const u64 second_tap = join_taps[1];
    appointments_capture_touch(second_tap);
    assert(press(second_tap) == AppointmentStay);
    exchange(0);
    assert(last_subscription.id == 2 && last_subscription.enabled && subscriptions.count == 2);
    check_draw("Appointments", "Leave appointment", "Room alerts connected.");
    assert(!page.rows[0].interested && !page.rows[1].interested);
    check_draw("Appointments", "Leave appointment", "Ready opens 30 min before.");
    assert(join_taps[0] & APPOINTMENT_TOUCH_JOINED);
    assert(join_taps[1] & APPOINTMENT_TOUCH_JOINED);
    assert(press(HidNpadButton_Y) == AppointmentStay); // Too early to get ready for row 2.
    Service service = {0};
    assert(!appointments_worker_exchange(&service));

    // A touch begun when a row was unjoined cannot accidentally unjoin it now.
    appointments_capture_touch(second_tap);
    assert(press(second_tap) == AppointmentStay);
    assert(!appointments_worker_exchange(&service));
    assert(subscriptions.count == 2);

    assert(press(HidNpadButton_AnyUp) == AppointmentStay);
    assert(press(HidNpadButton_Y) == AppointmentStay);
    exchange(AppointmentFollow);
    assert(last.id == 1 && subscriptions.count == 2 && page.rows[0].interested == 1);
    ui_set_language(true, false);
    check_draw("约局", "取消准备", "1 人已准备");
    check_draw("约局", "退出约局", "已加入");
    assert(press(HidNpadButton_Y) == AppointmentStay);
    exchange(AppointmentUnfollow);
    assert(last.id == 1 && !page.rows[0].interested && subscriptions.count == 2);

    assert(press(HidNpadButton_A) == AppointmentStay);
    exchange(0);
    assert(last_subscription.id == 1 && !last_subscription.enabled &&
           subscriptions.count == 1 && subscriptions.ids[0] == 2);
    check_draw("约局", "加入约局", "已退出约局。");
    subscription_result = AppointmentStorage;
    assert(press(HidNpadButton_A) == AppointmentStay);
    exchange(0);
    assert(subscriptions.count == 1);
    check_draw("约局", "加入约局", "无法保存已加入的约局。");
    subscription_result = AppointmentOk;

    assert(press(HidNpadButton_L) == AppointmentStay);
    assert(appointments_active() && !appointments_list_active());
    check_draw("约局", NULL, "宝可梦 紫");
    assert(press(HidNpadButton_A) == AppointmentStay);
    check_draw("设置本机时间", "确认约局", "38");
    assert(press(HidNpadButton_AnyRight) == AppointmentStay);
    for (unsigned i = 0; i < 12; i++) {
        assert(press(HidNpadButton_AnyUp) == AppointmentStay);
        assert(press(0) == AppointmentStay);
    }
    ui_set_language(false, false);
    check_draw("Choose local time", "Create appointment", "50");
    assert(press(HidNpadButton_A) == AppointmentStay);
    assert(press(HidNpadButton_B) == AppointmentStay);
    exchange(AppointmentCreate);
    check_draw("Appointments", "Join appointment", "Appointment created.");
    assert(subscriptions.count == 1); // Creation and joining are distinct.
    assert(press(HidNpadButton_A) == AppointmentStay);
    exchange(0);
    assert(last_subscription.id == 3 && last_subscription.app_id == violet);

    disconnect = true;
    assert(press(HidNpadButton_R) == AppointmentStay);
    exchange(AppointmentList);
    check_draw("Appointments", "Refresh", "Appointments are unavailable. Try again.");
    disconnect = false;
    tick += 10000;
    assert(appointments_tick(tick));
    exchange(AppointmentList);

    appointments_close();
    assert(!appointments_active() && !appointments_list_active());
    appointments_open(true, false);
    assert(appointments_tick(++tick));
    exchange(AppointmentList);
    assert(press(HidNpadButton_AnyDown) == AppointmentStay);
    check_draw("Appointments", "Leave appointment", "2026-11-09  21:50");

    // A removed/replaced row under a held finger must not subscribe another event.
    const u64 stale_tap = join_taps[1];
    appointments_capture_touch(stale_tap);
    page.rows[1] = page.rows[2];
    page.count = 2;
    assert(press(HidNpadButton_R) == AppointmentStay);
    exchange(AppointmentList);
    assert(press(stale_tap) == AppointmentStay && !appointments_worker_exchange(&service));
    assert(subscriptions.count == 2 && subscriptions.ids[0] == 2 && subscriptions.ids[1] == 3);

    bad_subscriptions = true;
    assert(press(HidNpadButton_R) == AppointmentStay);
    exchange(AppointmentList);
    check_draw("Appointments", "Joined appointments unavailable.", "2026-11-09  21:50");
    assert(press(HidNpadButton_A) == AppointmentStay && !appointments_worker_exchange(&service));
    assert(exchanges == 9 && subscription_updates == 5);

    // A cached row remains visible for its last second, then expires offline.
    appointments_close();
    subscriptions = (AppointmentSubscriptions){0};
    bad_subscriptions = false;
    page = (AppointmentResponse){
        .status = AppointmentOk, .count = 2, .next = APPOINTMENT_END, .now = now,
        .rows = {{4, now - APPOINTMENT_ACTIVE_SECONDS + 1, lcid, scarlet, 0, 0, {0}},
                 {5, now + 60, lcid, scarlet, 0, 0, {0}}}};
    appointments_open(true, false);
    assert(appointments_tick(++tick));
    exchange(AppointmentList);
    const u64 clock_anchor = tick;
    disconnect = true;
    assert(press(HidNpadButton_R) == AppointmentStay);
    exchange(AppointmentList);
    tick = clock_anchor + 999;
    assert(!appointments_tick(tick));
    check_draw("Appointments", "Join appointment", "Appointments are unavailable. Try again.");
    assert(join_taps[0] && join_taps[1]);
    const u64 expiring_tap = join_taps[0];
    appointments_capture_touch(expiring_tap);

    assert(appointments_tick(++tick));
    assert(press(HidNpadButton_A) == AppointmentStay && !appointments_worker_exchange(&service));
    assert(press(expiring_tap) == AppointmentStay && !appointments_worker_exchange(&service));
    check_draw("Appointments", "Join appointment", "2026-11-09  20:38");
    assert(join_taps[0] && !join_taps[1]);
    assert(press(HidNpadButton_A) == AppointmentStay);
    exchange(0);
    assert(last_subscription.id == 5 && subscriptions.count == 1);

    // An older response must not put an expired row back on the screen.
    disconnect = false;
    assert(press(HidNpadButton_R) == AppointmentStay);
    exchange(AppointmentList);
    check_draw("Appointments", "Leave appointment", "2026-11-09  20:38");
    assert(join_taps[0] && !join_taps[1]);

    puts("appointment UI: local time, direct per-row join, independent ready, saved joins, stale touch, bilingual controls and retry");
    return 0;
}
