/* Appointments keep their own presentation and use the lobby's existing IPC worker. */
#include "appointments_view.h"
#include "appointments_model.h"
#include "gfx.h"
#include "title_inventory.h"
#include "ui_text.h"
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

enum { ListScreen, GameScreen, TimeScreen };
enum { ListX = 56, ListY = 180, ListW = 760, RowH = 62, StepH = 69, SideX = 848, SideW = 376, FooterY = 648 };
#define PICK_GAME (1ULL << 59)
#define TIME_FIELD (1ULL << 58)
#define REFRESH_MS 10000
#define SECOND 1000
#define WEEK_SECONDS (7 * 24 * 60 * 60)
#define TEXT RGBA(0xf2,0xf3,0xf7,0xff)
#define MUTED RGBA(0x9a,0xa0,0xb0,0xff)
#define PANEL RGBA(0xff,0xff,0xff,0x0f)
#define ACCENT RGBA(0x8b,0x5c,0xf6,0xff)
#define GOLD RGBA(0xff,0xd6,0x4a,0xff)
#define BG RGBA(0x1b,0x22,0x36,0xff)

static UEvent *g_wake;
static atomic_bool g_active;
static Mutex g_lock;
static bool g_pending, g_completed;
typedef struct {
    AppointmentRequest exchange;
    AppointmentWatchRequest subscription;
} PendingRequest;
typedef struct {
    AppointmentResponse exchange;
    AppointmentSubscriptions subscriptions;
    u32 subscription_status;
    bool subscriptions_ok;
} PendingReply;

static PendingRequest g_request;
static PendingReply g_reply;
static unsigned g_epoch, g_request_epoch;

/* These values belong to the UI thread. Only the request/reply cross the lock. */
static bool g_worker, g_busy;
static AppointmentSubscriptions g_subscriptions;
static bool g_subscriptions_ok;
static AppointmentResponse g_page;
static u32 g_offset;
static u64 g_selected, g_touched, g_rendered[APPOINTMENT_PAGE_SIZE];
static bool g_selection_expired;
static u64 g_clock, g_clock_anchor, g_next_refresh, g_tick_now;
static const char *g_notice;
static int g_screen;
static GameCacheRecord g_games[APPOINTMENT_PAGE_SIZE];
static int g_game_count, g_game_selected;
static u32 g_game_offset;
static bool g_games_loaded, g_games_more;
static GameCacheRecord g_game;
static int g_day, g_hour, g_minute, g_field;
static AppointmentDate g_today;
static u64 g_repeat_next, g_repeat_key;

void appointments_init(UEvent *wake)
{
    g_wake = wake;
    mutexInit(&g_lock);
}

bool appointments_active(void)
{
    return atomic_load(&g_active);
}

bool appointments_list_active(void)
{
    return appointments_active() && g_screen == ListScreen;
}

static void awake(void)
{
    if (g_wake) ueventSignal(g_wake);
}

void appointments_open(bool worker_available, bool resume)
{
    g_worker = worker_available;
    g_epoch++;
    g_screen = ListScreen;
    g_notice = NULL;
    g_next_refresh = 0;
    g_selection_expired = false;
    if (!resume) {
        g_offset = 0;
        g_selected = 0;
        g_clock = 0;
        g_page = (AppointmentResponse){.next = APPOINTMENT_END};
        g_subscriptions = (AppointmentSubscriptions){0};
        g_subscriptions_ok = false;
    }
    atomic_store(&g_active, true);
    awake();
}

void appointments_close(void)
{
    g_epoch++;
    atomic_store(&g_active, false);
    awake();
}

static void submit(PendingRequest data)
{
    if (g_busy || !g_worker) return;
    mutexLock(&g_lock);
    g_request = data;
    g_request_epoch = g_epoch;
    g_pending = true;
    mutexUnlock(&g_lock);
    g_busy = true;
    awake();
}

static void request(AppointmentRequest data)
{
    submit((PendingRequest){.exchange = data});
}

static bool subscriptions_valid(const AppointmentSubscriptions *subscriptions)
{
    if (subscriptions->count > APPOINTMENT_SUBSCRIPTION_LIMIT || subscriptions->reserved) return false;
    for (size_t i = 0; i < subscriptions->count; i++) {
        if (!subscriptions->ids[i]) return false;
        for (size_t j = 0; j < i; j++)
            if (subscriptions->ids[j] == subscriptions->ids[i]) return false;
    }
    return true;
}

static bool joined(u64 id)
{
    if (!g_subscriptions_ok) return false;
    for (size_t i = 0; i < g_subscriptions.count; i++)
        if (g_subscriptions.ids[i] == id) return true;
    return false;
}

bool appointments_worker_exchange(Service *service)
{
    PendingRequest req;
    mutexLock(&g_lock);
    bool pending = g_pending;
    if (pending) {
        req = g_request;
        g_pending = false;
    }
    mutexUnlock(&g_lock);
    if (!pending) return false;

    PendingReply reply = {.exchange = {.status = AppointmentUnavailable, .next = APPOINTMENT_END}};
    if (req.subscription.id) {
        u32 status = AppointmentUnavailable;
        Result rc = serviceDispatchInOut(service, APPOINTMENT_IPC_SUBSCRIBE, req.subscription, status);
        reply.subscription_status = R_SUCCEEDED(rc) ? status : AppointmentUnavailable;
    } else {
        Result rc = serviceDispatch(service, APPOINTMENT_IPC_EXCHANGE,
            .buffer_attrs = { SfBufferAttr_HipcMapAlias | SfBufferAttr_In,
                              SfBufferAttr_HipcMapAlias | SfBufferAttr_Out },
            .buffers = { { &req.exchange, sizeof(req.exchange) }, { &reply.exchange, sizeof(reply.exchange) } });
        u32 offset = req.exchange.op == AppointmentList ? req.exchange.offset : 0;
        if (R_FAILED(rc) || !appointment_response_valid(&reply.exchange, offset))
            reply.exchange = (AppointmentResponse){.status = AppointmentUnavailable, .next = APPOINTMENT_END};
    }
    const Result subscriptions_result = serviceDispatch(service, APPOINTMENT_IPC_SUBSCRIPTIONS,
        .buffer_attrs = { SfBufferAttr_HipcMapAlias | SfBufferAttr_Out },
        .buffers = { { &reply.subscriptions, sizeof(reply.subscriptions) } });
    reply.subscriptions_ok = R_SUCCEEDED(subscriptions_result) && subscriptions_valid(&reply.subscriptions);
    mutexLock(&g_lock);
    g_reply = reply;
    g_completed = true;
    mutexUnlock(&g_lock);
    return true;
}

static const char *status_text(u32 status)
{
    switch (status) {
    case AppointmentInvalid: return "Check the game and appointment time.";
    case AppointmentLimit: return "Appointment limit reached. Try again later.";
    case AppointmentNotFound: return "This appointment has ended.";
    case AppointmentStorage: return "The server could not save this change.";
    default: return "Appointments are unavailable. Try again.";
    }
}

static u64 server_now(void)
{
    return g_clock && g_tick_now >= g_clock_anchor ? g_clock + (g_tick_now - g_clock_anchor) / SECOND : g_clock;
}

static bool hide_expired_rows(u64 now)
{
    u32 count = 0;
    for (u32 i = 0; i < g_page.count; i++) {
        const AppointmentRow *row = &g_page.rows[i];
        if (appointment_expired(row->starts_at, now)) {
            if (row->id == g_selected) g_selection_expired = true;
        } else {
            g_page.rows[count++] = *row;
        }
    }
    if (count == g_page.count) return false;
    g_page.count = count;
    if (appointment_find_row(&g_page, g_selected) < 0)
        g_selected = count ? g_page.rows[0].id : 0;
    return true;
}

bool appointments_tick(u64 monotonic_ms)
{
    g_tick_now = monotonic_ms;
    bool dirty = false;
    PendingReply result;
    PendingRequest operation;
    unsigned epoch = 0;
    mutexLock(&g_lock);
    bool complete = g_completed;
    if (complete) {
        result = g_reply;
        operation = g_request;
        epoch = g_request_epoch;
        g_completed = false;
    }
    mutexUnlock(&g_lock);
    if (complete) {
        g_busy = false;
        if (epoch == g_epoch && appointments_active()) {
            g_subscriptions_ok = result.subscriptions_ok;
            if (result.subscriptions_ok) g_subscriptions = result.subscriptions;
            if (operation.subscription.id) {
                if (result.subscription_status == AppointmentOk)
                    g_notice = operation.subscription.enabled ? "Appointment joined." : "Appointment left.";
                else if (result.subscription_status == AppointmentLimit)
                    g_notice = "You can join up to 24 appointments.";
                else if (result.subscription_status == AppointmentStorage)
                    g_notice = "Could not save joined appointments.";
                else
                    g_notice = status_text(result.subscription_status);
            } else {
                AppointmentResponse reply = result.exchange;
                AppointmentRequest req = operation.exchange;
                if (reply.now) {
                    const u64 estimated_now = server_now();
                    g_clock = reply.now > estimated_now ? reply.now : estimated_now;
                    g_clock_anchor = monotonic_ms;
                }
                if (reply.status == AppointmentOk) {
                    /* Discard any controller action aimed at a row that just expired. */
                    hide_expired_rows(server_now());
                    g_page = reply;
                    g_offset = req.op == AppointmentList ? req.offset : 0;
                    if (req.op == AppointmentCreate) {
                        g_screen = ListScreen;
                        for (size_t i = 0; i < g_page.count; i++) {
                            const AppointmentRow *r = &g_page.rows[i];
                            if (r->game_id == req.game_id && r->app_id == req.app_id &&
                                r->starts_at == req.starts_at) {
                                g_selected = r->id;
                                break;
                            }
                        }
                    }
                    if (appointment_find_row(&g_page, g_selected) < 0)
                        g_selected = g_page.count ? g_page.rows[0].id : 0;
                    g_notice = NULL;
                    if (req.op == AppointmentCreate) g_notice = "Appointment created.";
                } else {
                    g_notice = status_text(reply.status);
                }
                g_next_refresh = monotonic_ms + REFRESH_MS;
            }
            dirty = true;
        }
    }
    if (!appointments_active()) return dirty;
    if (hide_expired_rows(server_now())) dirty = true;
    if (!g_worker) {
        if (!g_notice) { g_notice = status_text(AppointmentUnavailable); return true; }
        return dirty;
    }
    if (g_screen == ListScreen && !g_busy && monotonic_ms >= g_next_refresh) {
        if (g_offset && g_page.count == 0) g_offset = 0;
        request((AppointmentRequest){.op = AppointmentList, .offset = g_offset});
        dirty = true;
    }
    return dirty;
}

static void load_games(bool loading, bool failed)
{
    g_games_loaded = !loading;
    g_game_count = 0;
    g_game_selected = 0;
    g_games_more = false;
    if (loading) {
        g_notice = "Reading game titles…";
        return;
    }
    if (!failed)
        g_game_count = title_inventory_appointments_at(GAME_CACHE_PATH, g_game_offset,
            g_games, APPOINTMENT_PAGE_SIZE, &g_games_more);
    if (failed || g_game_count < 0) g_notice = "Could not read game titles. Reopen the app.";
    else g_notice = g_game_count ? NULL : "No installed games with Local Wireless found.";
}

static bool begin_time(const GameCacheRecord *game)
{
    TimeCalendarTime now, soon;
    TimeCalendarAdditionalInfo info;
    const u64 utc = server_now();
    if (!utc || R_FAILED(timeToCalendarTimeWithMyRule(utc, &now, &info)) ||
        R_FAILED(timeToCalendarTimeWithMyRule((utc / 60 + 61) * 60, &soon, &info))) {
        g_notice = "Could not read your local time.";
        return false;
    }
    g_today = (AppointmentDate){now.year, now.month, now.day};
    g_game = *game;
    g_day = now.day != soon.day;
    g_hour = soon.hour;
    g_minute = soon.minute;
    g_field = 1;
    g_repeat_key = 0;
    g_screen = TimeScreen;
    g_notice = NULL;
    return true;
}

static void create_appointment(void)
{
    AppointmentDate day = appointment_date_after(g_today, (unsigned)g_day);
    TimeCalendarTime local = {.year = day.year, .month = day.month, .day = day.day,
                              .hour = g_hour, .minute = g_minute};
    u64 utc[2] = {0};
    s32 count = 0;
    if (R_FAILED(timeToPosixTimeWithMyRule(&local, utc, 2, &count)) || count < 1 || count > 2) {
        g_notice = "This local time does not exist. Choose another minute.";
        return;
    }
    const u64 now = server_now();
    u64 first = 0;
    for (s32 i = 0; i < count; i++)
        if (utc[i] > now && (!first || utc[i] < first)) first = utc[i];
    if (!first || !now || first - now > WEEK_SECONDS) {
        g_notice = "Choose a future time within seven days.";
        return;
    }
    u64 game_id = 0;
    for (size_t i = 0; i < GAME_CACHE_LCID_COUNT; i++)
        if (g_game.local_communication_ids[i] && g_game.local_communication_ids[i] != UINT64_MAX) {
            game_id = g_game.local_communication_ids[i];
            break;
        }
    if (!game_id) return;
    request((AppointmentRequest){.op = AppointmentCreate, .starts_at = first,
                                 .game_id = game_id, .app_id = g_game.application_id});
}

void appointments_capture_touch(u64 action)
{
    size_t index = action & 0xff;
    if ((action & (APPOINTMENT_TOUCH_ROW | APPOINTMENT_TOUCH_JOIN)) && index < APPOINTMENT_PAGE_SIZE)
        g_touched = g_rendered[index];
}

static void adjust_time(int delta)
{
    if (g_field == 0) g_day = (g_day + delta + 8) % 8;
    else if (g_field == 1) g_hour = (g_hour + delta + 24) % 24;
    else g_minute = (g_minute + delta + 60) % 60;
    g_notice = NULL;
}

AppointmentAction appointments_input(u64 down, u64 held, u64 monotonic_ms,
                                     bool inventory_loading, bool inventory_failed, u64 *game_id)
{
    if (down & HidNpadButton_B) {
        if (g_busy && g_screen == TimeScreen) return AppointmentStay;
        if (g_screen == TimeScreen) g_screen = GameScreen;
        else if (g_screen == GameScreen) g_screen = ListScreen;
        else return AppointmentBack;
        g_notice = NULL;
        return AppointmentStay;
    }
    if (g_screen == GameScreen) {
        if (!g_games_loaded && !inventory_loading) load_games(false, inventory_failed);
        if (down & HidNpadButton_ZL && g_game_offset) {
            g_game_offset -= APPOINTMENT_PAGE_SIZE;
            load_games(inventory_loading, inventory_failed);
        }
        if (down & HidNpadButton_ZR && g_games_more) {
            g_game_offset += APPOINTMENT_PAGE_SIZE;
            load_games(inventory_loading, inventory_failed);
        }
        if (g_game_count <= 0) return AppointmentStay;
        if (down & HidNpadButton_AnyDown && g_game_selected + 1 < g_game_count) g_game_selected++;
        if (down & HidNpadButton_AnyUp && g_game_selected > 0) g_game_selected--;
        if ((down & PICK_GAME) && (int)(down & 0xff) < g_game_count) {
            g_game_selected = (int)(down & 0xff);
            down |= HidNpadButton_A;
        }
        if (down & HidNpadButton_A) begin_time(&g_games[g_game_selected]);
        return AppointmentStay;
    }
    if (g_screen == TimeScreen) {
        if (g_busy) return AppointmentStay;
        if (down & HidNpadButton_AnyLeft) g_field = (g_field + 2) % 3;
        if (down & HidNpadButton_AnyRight) g_field = (g_field + 1) % 3;
        if ((down & TIME_FIELD) && (down & 3) < 3) {
            g_field = (int)(down & 3);
            adjust_time(down & 4 ? -1 : 1);
        }
        u64 direction = held & (HidNpadButton_AnyUp | HidNpadButton_AnyDown);
        if (!direction) g_repeat_key = 0;
        else if (direction != g_repeat_key || monotonic_ms >= g_repeat_next) {
            adjust_time(direction & HidNpadButton_AnyUp ? 1 : -1);
            g_repeat_next = monotonic_ms + (direction == g_repeat_key ? 80 : 350);
            g_repeat_key = direction;
        }
        if (down & HidNpadButton_A) create_appointment();
        return AppointmentStay;
    }
    if (down & HidNpadButton_R && !g_busy) {
        g_next_refresh = 0;
        request((AppointmentRequest){.op = AppointmentList, .offset = g_offset});
        return AppointmentStay;
    }
    if (g_busy || !server_now()) return AppointmentStay;
    if (down & HidNpadButton_L) {
        g_screen = GameScreen;
        g_game_offset = 0;
        load_games(inventory_loading, inventory_failed);
        return AppointmentStay;
    }
    if (down & HidNpadButton_ZL && g_offset) {
        request((AppointmentRequest){.op = AppointmentList, .offset = g_offset - APPOINTMENT_PAGE_SIZE});
        return AppointmentStay;
    }
    if (down & HidNpadButton_ZR && g_page.next != APPOINTMENT_END) {
        request((AppointmentRequest){.op = AppointmentList, .offset = g_page.next});
        return AppointmentStay;
    }
    if (!g_page.count) return AppointmentStay;
    if (g_selection_expired && !(down & (APPOINTMENT_TOUCH_ROW | APPOINTMENT_TOUCH_JOIN)))
        return AppointmentStay;
    int selected = appointment_find_row(&g_page, g_selected);
    if (selected < 0) selected = 0;
    if (down & HidNpadButton_AnyDown && selected + 1 < (int)g_page.count) selected++;
    if (down & HidNpadButton_AnyUp && selected > 0) selected--;
    const bool join_tap = (down & APPOINTMENT_TOUCH_JOIN) != 0;
    if (down & (APPOINTMENT_TOUCH_ROW | APPOINTMENT_TOUCH_JOIN)) {
        const int tapped = appointment_find_row(&g_page, g_touched);
        if (tapped >= 0) selected = tapped;
        else if (join_tap) return AppointmentStay;
    }
    const AppointmentRow *row = &g_page.rows[selected];
    if (appointment_expired(row->starts_at, server_now())) return AppointmentStay;
    g_selected = row->id;
    if (join_tap || (down & HidNpadButton_A)) {
        const bool is_joined = joined(row->id);
        if (g_subscriptions_ok && (!join_tap || is_joined == ((down & APPOINTMENT_TOUCH_JOINED) != 0))) {
            submit((PendingRequest){.subscription = {
                .id = row->id, .starts_at = row->starts_at, .game_id = row->game_id,
                .app_id = row->app_id, .enabled = !is_joined}});
        }
    } else if (down & HidNpadButton_X && appointment_rooms_open(row->starts_at, server_now())) {
        *game_id = row->game_id;
        return AppointmentFindRooms;
    } else if ((down & HidNpadButton_Y) && (row->followed ||
              appointment_rooms_open(row->starts_at, server_now()))) {
        request((AppointmentRequest){.op = row->followed ? AppointmentUnfollow : AppointmentFollow,
                                     .id = row->id});
    }
    return AppointmentStay;
}

static void action(int x, int y, const char *key, const char *label, u64 button, AppointmentTouchZone touch)
{
    int width = gfx_button(x, y, key, ui_text(label));
    touch(x - 8, y - 7, width + 16, 50, button);
}

static void card(int i, bool selected)
{
    int y = ListY + i * StepH;
    if (selected) gfx_round_rect(ListX - 2, y - 2, ListW + 4, RowH + 4, 14, ACCENT);
    gfx_round_rect(ListX, y, ListW, RowH, 12, selected ? BG : PANEL);
}

static void draw_list(const GameCatalog *catalog, AppointmentTouchZone touch)
{
    g_selection_expired = false;
    memset(g_rendered, 0, sizeof(g_rendered));
    for (size_t i = 0; i < g_page.count; i++) {
        const AppointmentRow *row = &g_page.rows[i];
        const int y = ListY + (int)i * StepH;
        card((int)i, row->id == g_selected);
        const CatalogMatch game = game_catalog_identify(catalog, row->app_id, row->game_id);
        const char *name = game_catalog_name(&game, ui_chinese());
        char fallback[80];
        if (!name) {
            snprintf(fallback, sizeof(fallback), ui_text("Game %016lX"), (unsigned long)row->game_id);
            name = fallback;
        }
        gfx_text_fit(ListX + 18, y + 7, 22, TEXT, name, ListW - 190);
        TimeCalendarTime local;
        TimeCalendarAdditionalInfo info;
        char when[96];
        if (R_SUCCEEDED(timeToCalendarTimeWithMyRule(row->starts_at, &local, &info)))
            snprintf(when, sizeof(when), "%04u-%02u-%02u  %02u:%02u",
                     local.year, local.month, local.day, local.hour, local.minute);
        else
            snprintf(when, sizeof(when), "%s", ui_text("Local time unavailable"));
        if (row->followed) {
            const size_t used = strlen(when);
            snprintf(when + used, sizeof(when) - used, " · %s", ui_text("Ready to play"));
        }
        gfx_text_fit(ListX + 18, y + 34, 19, row->followed ? GOLD : MUTED, when, ListW - 180);
        const int join_x = ListX + ListW - 157;
        char count[64];
        snprintf(count, sizeof(count), ui_text("%u ready"), row->interested);
        gfx_text_fit(join_x, y + 34, 18, MUTED, count, 143);
        g_rendered[i] = row->id;
        touch(ListX, y, ListW, RowH, APPOINTMENT_TOUCH_ROW | (u64)i);
        if (g_subscriptions_ok) {
            const bool is_joined = joined(row->id);
            const char *label = ui_text(is_joined ? "Joined" : "Join");
            gfx_round_rect(join_x, y + 4, 100, 27, 12, is_joined ? ACCENT : PANEL);
            gfx_text(join_x + (100 - gfx_text_width(17, label)) / 2, y + 7, 17, TEXT, label);
            if (!g_busy)
                touch(join_x - 6, y + 2, 112, 30, APPOINTMENT_TOUCH_JOIN | (u64)i |
                    (is_joined ? APPOINTMENT_TOUCH_JOINED : 0));
        }
    }
    if (!g_page.count) {
        const char *text = g_busy ? "Loading appointments…" :
            (g_notice ? "Appointments are unavailable." : "No upcoming appointments");
        gfx_text(ListX, ListY + 16, 25, MUTED, ui_text(text));
    }
    int i = appointment_find_row(&g_page, g_selected);
    if (i >= 0 && !g_busy) {
        const AppointmentRow *row = &g_page.rows[i];
        const bool near_start = appointment_rooms_open(row->starts_at, server_now());
        if (g_subscriptions_ok)
            action(SideX, ListY + 16, "A", joined(row->id) ? "Leave appointment" : "Join appointment",
                   HidNpadButton_A, touch);
        else
            gfx_text_fit(SideX, ListY + 16, 19, MUTED, ui_text("Joined appointments unavailable."), SideW);
        if (near_start)
            action(SideX, ListY + 74, "X", "Find rooms", HidNpadButton_X, touch);
        if (near_start || row->followed)
            action(SideX, ListY + 132, "Y", row->followed ? "Cancel ready" : "Ready now", HidNpadButton_Y, touch);
        else
            gfx_text_fit(SideX, ListY + 132, 19, MUTED, ui_text("Ready opens 30 min before."), SideW);
    }
    if (server_now() && !g_busy)
        action(SideX, ListY + 190, "L", "New appointment", HidNpadButton_L, touch);
    if (g_offset)
        action(ListX + 444, 127, "ZL", "Prev", HidNpadButton_ZL, touch);
    if (g_page.next != APPOINTMENT_END)
        action(ListX + 580, 127, "ZR", "Next", HidNpadButton_ZR, touch);
    if (!g_busy)
        action(SideX, FooterY + 20, "R", "Refresh", HidNpadButton_R, touch);
    const int guide_x = GFX_W - ListX - 40 - gfx_text_width(22, ui_text("View guide"));
    action(guide_x, FooterY + 20, "→", "View guide", HidNpadButton_Right, touch);
}

static void draw_games(AppointmentTouchZone touch)
{
    for (int i = 0; i < g_game_count; i++) {
        card(i, i == g_game_selected);
        const char *name = ui_chinese() ? g_games[i].names.chinese : g_games[i].names.english;
        gfx_text_fit(ListX + 18, ListY + i * StepH + 19, 23, TEXT, name, ListW - 36);
        touch(ListX, ListY + i * StepH, ListW, RowH, PICK_GAME | (u64)i);
    }
    if (g_game_count > 0)
        action(SideX, ListY + 16, "A", "Select game", HidNpadButton_A, touch);
    if (g_game_offset)
        action(ListX + 444, 127, "ZL", "Prev", HidNpadButton_ZL, touch);
    if (g_games_more)
        action(ListX + 580, 127, "ZR", "Next", HidNpadButton_ZR, touch);
}

static void draw_time(AppointmentTouchZone touch)
{
    const char *name = ui_chinese() ? g_game.names.chinese : g_game.names.english;
    gfx_text_fit(ListX, ListY, 25, TEXT, name, ListW);
    gfx_text(ListX, ListY + 56, 19, MUTED, ui_text("Left/right selects a field. Up/down changes it."));
    AppointmentDate day = appointment_date_after(g_today, (unsigned)g_day);
    char value[3][32];
    snprintf(value[0], sizeof(value[0]), "%04d-%02d-%02d", day.year, day.month, day.day);
    snprintf(value[1], sizeof(value[1]), "%02d", g_hour);
    snprintf(value[2], sizeof(value[2]), "%02d", g_minute);
    const char *labels[] = {"Date", "Hour", "Minute"};
    for (int i = 0, x = ListX; i < 3; i++, x += 250) {
        gfx_text(x + 14, ListY + 113, 21, MUTED, ui_text(labels[i]));
        gfx_round_rect(x, ListY + 147, 224, 98, 13, i == g_field ? ACCENT : PANEL);
        gfx_text(x + 17, ListY + 176, 28, TEXT, value[i]);
        gfx_text(x + 185, ListY + 153, 20, TEXT, "▲");
        gfx_text(x + 185, ListY + 215, 20, TEXT, "▼");
        touch(x, ListY + 147, 224, 49, TIME_FIELD | (u64)i);
        touch(x, ListY + 196, 224, 49, TIME_FIELD | (u64)i | 4);
    }
    if (!g_busy) action(SideX, ListY + 16, "A", "Create appointment", HidNpadButton_A, touch);
}

void appointments_draw(const GameCatalog *catalog, AppointmentTouchZone touch)
{
    gfx_text(ListX, 36, 40, TEXT, ui_text("Appointments"));
    gfx_text(ListX, 128, 24, TEXT, ui_text(g_screen == ListScreen ? "Upcoming · local time" :
                                         g_screen == GameScreen ? "Select a game" : "Choose local time"));
    if (g_screen == ListScreen) draw_list(catalog, touch);
    else if (g_screen == GameScreen) draw_games(touch);
    else draw_time(touch);
    if (g_notice)
        gfx_text_fit(ListX, FooterY - 35, 20, GOLD, ui_text(g_notice), GFX_W - 2 * ListX);
    gfx_rect(0, FooterY, GFX_W, 1, PANEL);
    action(ListX, FooterY + 20, "B", g_screen == ListScreen ? "Back to lobby" : "Back", HidNpadButton_B, touch);
}
