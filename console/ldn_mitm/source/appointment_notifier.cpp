// SPDX-License-Identifier: GPL-2.0-only
#include "appointment_notifier.hpp"
#include <algorithm>
#include <cstdio>
#include <cstring>

namespace ams::mitm::lanywhere {

    namespace {
        constexpr char NotificationDir[] = "sdmc:/config/ultrahand/notifications";
        constexpr char NotificationPath[] = "sdmc:/config/ultrahand/notifications/LANywhere-room.notify";
        constexpr char TemporaryPath[] = "sdmc:/config/ultrahand/notifications/LANywhere-room.tmp";
        constexpr char LocalePath[] = "sdmc:/lanywhere/language.ini";
        constexpr char SubscriptionsPath[] = "sdmc:/lanywhere/appointment-subscriptions.bin";
        constexpr char PreviousSubscriptionsPath[] = "sdmc:/lanywhere/appointment-subscriptions.bin.previous";
        constexpr char TemporarySubscriptionsPath[] = "sdmc:/lanywhere/appointment-subscriptions.bin.tmp";
        constexpr u32 SubscriptionMagic = 0x53414e4c; // LNAS
        constexpr u32 SubscriptionVersion = 1;
        constexpr u64 MaxScheduleAhead = 7 * 24 * 60 * 60;
        constexpr u64 ReadyLeaseSeconds = 5 * 60;
        constexpr size_t RecentRooms = 64;
        constexpr size_t RecentDeliveries = 128;
        constexpr size_t PendingCapacity = 16;

        struct Watch {
            AppointmentWatchRequest event;
            bool explicit_watch;
            char seen[RecentRooms][CodeLength];
            size_t next_seen;
            u32 room_offset;
        };

        struct SavedEvent {
            u64 id, starts_at, game_id, app_id;
        };

        struct SavedSubscriptions {
            u32 magic, version, count, reserved;
            SavedEvent events[APPOINTMENT_SUBSCRIPTION_LIMIT];
        };
        static_assert(sizeof(SavedEvent) == 32);
        static_assert(sizeof(SavedSubscriptions) == 16 + 32 * APPOINTMENT_SUBSCRIPTION_LIMIT);

        struct PendingAlert {
            GroupSummaryV2 group;
            u64 appointment_id;
            u64 received_at;
        };

        struct PushSession {
            DiscoveryRoute route{};
            int fd = -1;
            u64 generation = 0;
            u64 retry_at = 0;
            u64 ping_at = 0;
            u64 last_frame_at = 0;
            u64 ack_deadline = 0;
            u32 retry_delay = 1000;
            bool acknowledged = false;
            bool unsupported = false;
        };

        constinit os::SdkMutex g_watch_lock;
        constinit os::SdkConditionVariable g_watch_changed;
        constinit Watch g_watch{}; // Legacy explicit watch or an automatic Ready watch.
        constinit Watch g_subscriptions[APPOINTMENT_SUBSCRIPTION_LIMIT]{};
        constinit size_t g_subscription_count = 0;
        constinit size_t g_next_poll = 0;
        constinit bool g_subscriptions_loaded = false;
        constinit bool g_primary_valid = false;
        constinit u64 g_generation = 0;
        constinit bool g_worker_started = false;
        constinit bool g_pending_toast = false;
        constinit u64 g_toast_event = 0;
        constinit os::Tick g_toast_at{};
        constinit u64 g_relay_time = 0;
        constinit u64 g_relay_tick = 0;
        constinit AppointmentWatchRequest g_ready_event{};
        constinit u64 g_ready_until = 0;
        constinit u32 g_alert_state = AppointmentAlertWaiting;
        constinit u64 g_alert_generation = 0;
        constinit u64 g_seen_delivery[RecentDeliveries]{};
        constinit size_t g_next_delivery = 0;
        constinit PendingAlert g_pending_alerts[PendingCapacity]{};
        constinit size_t g_pending_begin = 0, g_pending_count = 0;
        os::ThreadType g_worker;
        alignas(os::MemoryPageSize) u8 g_worker_stack[0x4000];

        u64 MonotonicMs() {
            return static_cast<u64>(os::GetSystemTick().ToTimeSpan().GetMilliSeconds());
        }

        u64 NowLocked() {
            const u64 tick = MonotonicMs();
            return g_relay_time && tick >= g_relay_tick ? g_relay_time + (tick - g_relay_tick) / 1000 : g_relay_time;
        }

        bool Chinese() {
            fs::FileHandle file;
            if (R_FAILED(fs::OpenFile(&file, LocalePath, fs::OpenMode_Read)) &&
                R_FAILED(fs::OpenFile(&file, "sdmc:/lanywhere/language.ini.previous", fs::OpenMode_Read))) return false;
            char text[32]{};
            size_t size = 0;
            const Result result = fs::ReadFile(&size, file, 0, text, sizeof(text) - 1);
            fs::CloseFile(file);
            if (R_FAILED(result)) return false;
            if (size && text[size - 1] == '\n') --size;
            if (size && text[size - 1] == '\r') --size;
            return size == sizeof("language=zh") - 1 && std::memcmp(text, "language=zh", size) == 0;
        }

        bool ToastAvailable() {
            fs::DirectoryEntryType type;
            return R_SUCCEEDED(fs::GetEntryType(&type, NotificationDir)) &&
                type == fs::DirectoryEntryType_Directory &&
                R_SUCCEEDED(fs::GetEntryType(&type, "sdmc:/config/ultrahand/flags/NOTIFICATIONS.flag")) &&
                type == fs::DirectoryEntryType_File &&
                R_FAILED(fs::GetEntryType(&type, "sdmc:/config/ultrahand/flags/notifications/LANywhere.flag"));
        }

        bool QueueToast(const GroupSummaryV2 &group) {
            const bool zh = Chinese();
            const char *title = zh && group.title_zh[0] ? group.title_zh : group.title_en;
            if (!title[0]) title = group.title_zh;
            // FindGroupSummaries has already validated the UTF-8, control bytes and termination.
            char escaped[2 * sizeof(group.title_en)]{};
            size_t cursor = 0;
            for (size_t i = 0; i < sizeof(group.title_en) && title[i]; ++i) {
                const char c = title[i];
                if (c == '"' || c == '\\') escaped[cursor++] = '\\';
                escaped[cursor++] = c;
            }
            char json[384]{};
            const int size = std::snprintf(json, sizeof(json),
                "{\"title\":\"LANywhere\",\"text\":\"%s%s%s\",\"duration\":7000}",
                escaped, cursor ? " · " : "",
                zh ? (cursor ? "房间已开放" : "约局房间已开放") :
                     (cursor ? "Room open" : "Your scheduled game has an open room"));
            if (size <= 0 || static_cast<size_t>(size) >= sizeof(json)) return false;
            static_cast<void>(fs::DeleteFile(TemporaryPath));
            if (R_FAILED(fs::CreateFile(TemporaryPath, size))) return false;
            fs::FileHandle file;
            bool written = false;
            if (R_SUCCEEDED(fs::OpenFile(&file, TemporaryPath, fs::OpenMode_Write))) {
                written = R_SUCCEEDED(fs::WriteFile(file, 0, json, size, fs::WriteOption::Flush));
                fs::CloseFile(file);
            }
            if (written && R_SUCCEEDED(fs::RenameFile(TemporaryPath, NotificationPath))) {
                g_pending_toast = true;
                g_toast_at = os::GetSystemTick();
                return true;
            }
            static_cast<void>(fs::DeleteFile(TemporaryPath));
            return false;
        }

        void ClearPendingToast() {
            if (!g_pending_toast) return;
            static_cast<void>(fs::DeleteFile(NotificationPath));
            g_pending_toast = false;
            g_toast_event = 0;
        }

        size_t SubscriptionIndex(u64 id) {
            for (size_t i = 0; i < g_subscription_count; ++i)
                if (g_subscriptions[i].event.id == id) return i;
            return g_subscription_count;
        }

        void ClearWatch() {
            const u64 id = g_watch.event.id;
            g_watch = {};
            ++g_generation;
            if (g_toast_event == id && SubscriptionIndex(id) == g_subscription_count)
                ClearPendingToast();
        }

        bool IsExpired(u64 starts_at, u64 now) {
            return now >= starts_at && now - starts_at >= APPOINTMENT_ACTIVE_SECONDS;
        }

        bool InAlertWindow(u64 starts_at, u64 now) {
            return now && !IsExpired(starts_at, now) &&
                (starts_at <= now || starts_at - now <= APPOINTMENT_EARLY_SECONDS);
        }

        bool ValidEvent(u64 id, u64 starts_at, u64 game_id, u64 app_id) {
            return id && starts_at && game_id && game_id != UINT64_MAX && app_id != UINT64_MAX;
        }

        bool SameEvent(const AppointmentWatchRequest &a, const AppointmentWatchRequest &b) {
            return a.id == b.id && a.starts_at == b.starts_at && a.game_id == b.game_id && a.app_id == b.app_id;
        }

        bool ValidWindow(const AppointmentWatchRequest &request, u64 now) {
            return ValidEvent(request.id, request.starts_at, request.game_id, request.app_id) &&
                (!now || (!IsExpired(request.starts_at, now) &&
                 (request.starts_at <= now || request.starts_at - now <= MaxScheduleAhead)));
        }

        enum class ReadState { Missing, Invalid, Unavailable, Valid };

        ReadState ReadSubscriptions(const char *path, SavedSubscriptions *state) {
            fs::FileHandle file;
            const Result opened = fs::OpenFile(&file, path, fs::OpenMode_Read);
            if (R_FAILED(opened))
                return fs::ResultPathNotFound::Includes(opened) ? ReadState::Missing : ReadState::Unavailable;
            s64 size = 0;
            const Result measured = fs::GetFileSize(&size, file);
            size_t read = 0;
            const Result loaded = R_SUCCEEDED(measured) && size == static_cast<s64>(sizeof(*state)) ?
                fs::ReadFile(&read, file, 0, state, sizeof(*state)) : measured;
            fs::CloseFile(file);
            if (R_FAILED(loaded)) return ReadState::Unavailable;
            if (size != static_cast<s64>(sizeof(*state)) || read != sizeof(*state) || state->magic != SubscriptionMagic)
                return ReadState::Invalid;
            if (state->version != SubscriptionVersion) return ReadState::Unavailable;
            if (state->reserved || state->count > APPOINTMENT_SUBSCRIPTION_LIMIT) return ReadState::Invalid;
            for (size_t i = 0; i < state->count; ++i) {
                const auto &event = state->events[i];
                if (!ValidEvent(event.id, event.starts_at, event.game_id, event.app_id)) return ReadState::Invalid;
                for (size_t previous = 0; previous < i; ++previous)
                    if (state->events[previous].id == event.id) return ReadState::Invalid;
            }
            for (size_t i = state->count; i < APPOINTMENT_SUBSCRIPTION_LIMIT; ++i) {
                const auto &event = state->events[i];
                if (event.id || event.starts_at || event.game_id || event.app_id) return ReadState::Invalid;
            }
            return ReadState::Valid;
        }

        bool LoadSubscriptionsLocked() {
            if (g_subscriptions_loaded) return true;
            SavedSubscriptions state{};
            const ReadState primary = ReadSubscriptions(SubscriptionsPath, &state);
            if (primary == ReadState::Unavailable) return false;
            const ReadState recovered = primary == ReadState::Valid ?
                primary : ReadSubscriptions(PreviousSubscriptionsPath, &state);
            if (recovered == ReadState::Unavailable) return false;
            g_primary_valid = primary == ReadState::Valid;
            g_subscription_count = recovered == ReadState::Valid ? state.count : 0;
            for (size_t i = 0; i < g_subscription_count; ++i) {
                const auto &event = state.events[i];
                g_subscriptions[i].event = {event.id, event.starts_at, event.game_id, event.app_id, 1, 0};
            }
            g_subscriptions_loaded = true;
            return true;
        }

        SavedEvent SaveEvent(const AppointmentWatchRequest &event) {
            return {event.id, event.starts_at, event.game_id, event.app_id};
        }

        SavedSubscriptions SubscriptionSnapshot() {
            SavedSubscriptions state{SubscriptionMagic, SubscriptionVersion, static_cast<u32>(g_subscription_count), 0, {}};
            for (size_t i = 0; i < g_subscription_count; ++i)
                state.events[i] = SaveEvent(g_subscriptions[i].event);
            return state;
        }

        bool DeleteIfPresent(const char *path) {
            const Result result = fs::DeleteFile(path);
            return R_SUCCEEDED(result) || fs::ResultPathNotFound::Includes(result);
        }

        bool StoreSubscriptionsLocked(const SavedSubscriptions &state) {
            if (!DeleteIfPresent(TemporarySubscriptionsPath) ||
                R_FAILED(fs::CreateFile(TemporarySubscriptionsPath, sizeof(state)))) return false;
            fs::FileHandle file;
            bool written = false;
            if (R_SUCCEEDED(fs::OpenFile(&file, TemporarySubscriptionsPath, fs::OpenMode_Write))) {
                written = R_SUCCEEDED(fs::WriteFile(file, 0, &state, sizeof(state), fs::WriteOption::Flush));
                fs::CloseFile(file);
            }
            SavedSubscriptions verified{};
            written = written && ReadSubscriptions(TemporarySubscriptionsPath, &verified) == ReadState::Valid &&
                std::memcmp(&state, &verified, sizeof(state)) == 0;
            if (written && g_primary_valid) {
                written = DeleteIfPresent(PreviousSubscriptionsPath) &&
                    R_SUCCEEDED(fs::RenameFile(SubscriptionsPath, PreviousSubscriptionsPath));
                if (written) g_primary_valid = false;
            } else if (written) {
                written = DeleteIfPresent(SubscriptionsPath);
            }
            if (written && R_SUCCEEDED(fs::RenameFile(TemporarySubscriptionsPath, SubscriptionsPath))) {
                g_primary_valid = true;
                return true;
            }
            static_cast<void>(DeleteIfPresent(TemporarySubscriptionsPath));
            return false;
        }

        void RemoveSubscriptionLocked(size_t index) {
            const u64 id = g_subscriptions[index].event.id;
            for (size_t i = index + 1; i < g_subscription_count; ++i)
                g_subscriptions[i - 1] = g_subscriptions[i];
            g_subscriptions[--g_subscription_count] = {};
            ++g_generation;
            if (g_toast_event == id && g_watch.event.id != id) ClearPendingToast();
        }

        void PruneSubscriptionsLocked(u64 now) {
            const size_t previous = g_subscription_count;
            for (size_t i = g_subscription_count; i > 0; --i)
                if (IsExpired(g_subscriptions[i - 1].event.starts_at, now)) RemoveSubscriptionLocked(i - 1);
            if (previous != g_subscription_count)
                static_cast<void>(StoreSubscriptionsLocked(SubscriptionSnapshot()));
        }

        Watch &PollSlot(size_t index) {
            return index ? g_subscriptions[index - 1] : g_watch;
        }

        bool HasSeenRoom(const AppointmentWatchRequest &event, const char *code) {
            for (size_t i = 0; i <= g_subscription_count; ++i) {
                const auto &watch = PollSlot(i);
                if (watch.event.game_id != event.game_id) continue;
                for (const auto &previous : watch.seen)
                    if (std::memcmp(previous, code, CodeLength) == 0) return true;
            }
            return false;
        }

        Watch *FindWatchLocked(u64 id) {
            const size_t index = SubscriptionIndex(id);
            if (index < g_subscription_count) return &g_subscriptions[index];
            return g_watch.event.id == id ? &g_watch : nullptr;
        }

        void RememberRoom(Watch &watch, const char *code) {
            std::memcpy(watch.seen[watch.next_seen], code, CodeLength);
            watch.next_seen = (watch.next_seen + 1) % RecentRooms;
        }

        bool CanNotify(const GroupSummaryV2 &room, const AppointmentWatchRequest &event, const Status &current) {
            const bool different_title = event.app_id && room.application_id && (room.metadata_flags & 1) &&
                event.app_id != room.application_id;
            return room.game_id == event.game_id && !different_title && room.room_access != RoomAccessHidden && room.players &&
                room.players < room.max_players && std::memcmp(room.code, current.code, CodeLength) != 0;
        }

        void DiscardPendingAlert() {
            g_pending_begin = (g_pending_begin + 1) % PendingCapacity;
            --g_pending_count;
        }

        void AcceptPushEvent(const AppointmentPushFrame &frame, u64 generation) {
            Status current{};
            GetStatus(&current);
            std::scoped_lock lock(g_watch_lock);
            if (generation != g_generation || !frame.appointment_id || !frame.delivery_id) return;
            Watch *watch = FindWatchLocked(frame.appointment_id);
            if (!watch || !InAlertWindow(watch->event.starts_at, NowLocked()) ||
                !CanNotify(frame.group, watch->event, current)) return;
            if (std::find(g_seen_delivery, g_seen_delivery + RecentDeliveries, frame.delivery_id) !=
                g_seen_delivery + RecentDeliveries) return;
            g_seen_delivery[g_next_delivery] = frame.delivery_id;
            g_next_delivery = (g_next_delivery + 1) % RecentDeliveries;
            const PendingAlert alert{frame.group, frame.appointment_id, MonotonicMs()};
            for (size_t i = 0; i < g_pending_count; ++i) {
                auto &pending = g_pending_alerts[(g_pending_begin + i) % PendingCapacity];
                if (pending.group.game_id == frame.group.game_id &&
                    std::memcmp(pending.group.code, frame.group.code, CodeLength) == 0) {
                    pending = alert;
                    return;
                }
            }
            if (g_pending_count == PendingCapacity) DiscardPendingAlert();
            g_pending_alerts[(g_pending_begin + g_pending_count++) % PendingCapacity] = alert;
        }

        void ServicePendingAlerts() {
            {
                std::scoped_lock lock(g_watch_lock);
                if (g_pending_toast &&
                    (os::GetSystemTick() - g_toast_at).ToTimeSpan() >= TimeSpan::FromSeconds(30))
                    ClearPendingToast();
                if (!g_pending_count) return;
            }
            if (!ToastAvailable()) return;
            Status current{};
            GetStatus(&current);
            std::scoped_lock lock(g_watch_lock);
            fs::DirectoryEntryType type;
            if (R_SUCCEEDED(fs::GetEntryType(&type, NotificationPath))) return;
            while (g_pending_count) {
                const auto &pending = g_pending_alerts[g_pending_begin];
                Watch *watch = FindWatchLocked(pending.appointment_id);
                if (!watch || MonotonicMs() - pending.received_at >= 90000 ||
                    !InAlertWindow(watch->event.starts_at, NowLocked()) ||
                    !CanNotify(pending.group, watch->event, current)) {
                    DiscardPendingAlert();
                    continue;
                }
                if (QueueToast(pending.group)) {
                    g_toast_event = pending.appointment_id;
                    RememberRoom(*watch, pending.group.code);
                    DiscardPendingAlert();
                }
                return;
            }
        }

        void Poll(const AppointmentWatchRequest &event, u64 generation, size_t slot = 0) {
            if (!ToastAvailable()) return;
            u32 offset;
            {
                std::scoped_lock lock(g_watch_lock);
                if (generation != g_generation) return;
                fs::DirectoryEntryType type;
                if (R_SUCCEEDED(fs::GetEntryType(&type, NotificationPath))) return;
                offset = PollSlot(slot).room_offset;
            }
            GroupSummaryV2 rooms[GroupPageSize]{};
            const int page_budget = slot ? 1 : 3;
            for (int scanned = 0; scanned < page_budget && offset != GroupPageEnd; ++scanned) {
                GroupPageV2 page{};
                const int count = FindGroupSummaries(offset, &page, rooms, GroupPageSize, event.game_id, true, true);
                Status current{};
                if (count > 0) GetStatus(&current);

                std::scoped_lock lock(g_watch_lock);
                if (generation != g_generation) return;
                auto &watch = PollSlot(slot);
                if (count <= 0) {
                    watch.room_offset = 0;
                    return;
                }
                for (s32 i = 0; i < count; ++i) {
                    const auto &room = rooms[i];
                    if (!CanNotify(room, event, current) || HasSeenRoom(event, room.code)) continue;

                    if (!InAlertWindow(event.starts_at, NowLocked())) return;
                    if (QueueToast(room)) {
                        g_toast_event = event.id;
                        RememberRoom(watch, room.code);
                    }
                    return;
                }
                offset = page.next;
                watch.room_offset = offset == GroupPageEnd ? 0 : offset;
            }
        }

        void WaitForChange(u64 generation, TimeSpan delay) {
            std::scoped_lock lock(g_watch_lock);
            if (generation == g_generation) g_watch_changed.TimedWait(g_watch_lock, delay);
        }

        void ReportAlertState(u64 generation, u32 state) {
            std::scoped_lock lock(g_watch_lock);
            if (generation != g_generation) return;
            g_alert_generation = generation;
            g_alert_state = state;
        }

        void SampleLegacyClock() {
            AppointmentRequest request{};
            request.op = AppointmentList;
            os::GenerateRandomBytes(request.participant, sizeof(request.participant));
            if (std::all_of(request.participant, request.participant + sizeof(request.participant),
                            [](u8 value) { return value == 0; }))
                request.participant[0] = 1;
            AppointmentResponse response{};
            ExchangeAppointment(request, &response);
            if (response.status == AppointmentOk) SyncAppointmentClock(response.now);
        }

        void LegacyIteration(u64 generation) {
            AppointmentWatchRequest event{};
            size_t slot = 0;
            u64 wait = 5;
            {
                std::scoped_lock lock(g_watch_lock);
                if (generation != g_generation) return;
                const u64 now = NowLocked();
                if (now) {
                    wait = 30;
                    const size_t slots = g_subscription_count + 1;
                    size_t active = 0;
                    for (size_t n = 0; n < slots; ++n) {
                        const size_t candidate = (g_next_poll + n) % slots;
                        const auto &scheduled = PollSlot(candidate).event;
                        if (!scheduled.id || IsExpired(scheduled.starts_at, now) ||
                            (!candidate && SubscriptionIndex(scheduled.id) < g_subscription_count)) continue;
                        const u64 until = scheduled.starts_at > now ? scheduled.starts_at - now : 0;
                        if (until > APPOINTMENT_EARLY_SECONDS) {
                            wait = std::min(wait, until - APPOINTMENT_EARLY_SECONDS);
                            continue;
                        }
                        if (!active++) {
                            slot = candidate;
                            event = scheduled;
                        }
                    }
                    if (active) {
                        g_next_poll = (slot + 1) % slots;
                        wait = active > 1 ? 1 : 5;
                    }
                }
            }
            if (event.id) Poll(event, generation, slot);
            WaitForChange(generation, TimeSpan::FromSeconds(wait));
        }

        void DisconnectPush(PushSession &session) {
            if (session.fd >= 0) CloseAppointmentPush(session.fd);
            session.fd = -1;
            session.acknowledged = false;
        }

        void RetryPush(PushSession &session) {
            DisconnectPush(session);
            session.retry_at = MonotonicMs() + session.retry_delay;
            session.retry_delay = std::min<u32>(30000, session.retry_delay * 2);
            ReportAlertState(session.generation, AppointmentAlertWaiting);
        }

        // False means the relay explicitly lacks streaming support.
        bool StepPush(PushSession &session, const AppointmentPushSubscriptions &subscriptions, u64 generation) {
            const u64 now = MonotonicMs();
            if (session.generation != generation) {
                DisconnectPush(session);
                session.generation = generation;
                if (!session.unsupported) {
                    session.retry_at = 0;
                    session.retry_delay = 1000;
                }
            }
            if (session.unsupported && now < session.retry_at) {
                ReportAlertState(generation, AppointmentAlertLegacy);
                return false;
            }
            if (session.fd < 0) {
                if (now < session.retry_at) {
                    WaitForChange(generation, TimeSpan::FromMilliSeconds(std::min<u64>(1000, session.retry_at - now)));
                    return true;
                }
                session.fd = OpenAppointmentPush(subscriptions, &session.route);
                session.unsupported = session.fd == -2;
                if (session.unsupported) {
                    session.retry_at = MonotonicMs() + 30000;
                    ReportAlertState(generation, AppointmentAlertLegacy);
                    SampleLegacyClock();
                    return false;
                }
                if (session.fd < 0) {
                    RetryPush(session);
                    return true;
                }
                session.last_frame_at = MonotonicMs();
                session.ping_at = session.last_frame_at + 8000;
                session.ack_deadline = session.last_frame_at + 10000;
                ReportAlertState(generation, AppointmentAlertWaiting);
                return true;
            }
            if ((!session.acknowledged && now >= session.ack_deadline) || now - session.last_frame_at >= 20000) {
                RetryPush(session);
                return true;
            }
            if (now >= session.ping_at) {
                if (!PingAppointmentPush(session.fd, session.route)) {
                    RetryPush(session);
                    return true;
                }
                session.ping_at = now + 8000;
            }
            AppointmentPushFrame frame{};
            const int received = ReadAppointmentPush(session.fd, session.route, &frame, 1000);
            if (received < 0) {
                RetryPush(session);
                return true;
            }
            if (received > 0) session.last_frame_at = MonotonicMs();
            if (received == 1) {
                SyncAppointmentClock(frame.now);
                if (!frame.appointment_id && !frame.delivery_id) {
                    session.acknowledged = true;
                    session.retry_delay = 1000;
                    ReportAlertState(generation, AppointmentAlertConnected);
                } else if (session.acknowledged) {
                    AcceptPushEvent(frame, generation);
                }
            }
            return true;
        }

        void WorkerIteration(PushSession &session) {
            AppointmentPushSubscriptions subscriptions{};
            u64 generation;
            {
                std::scoped_lock lock(g_watch_lock);
                const u64 now = NowLocked();
                if (now) {
                    if (g_watch.event.id && IsExpired(g_watch.event.starts_at, now)) ClearWatch();
                    PruneSubscriptionsLocked(now);
                }
                for (size_t i = 0; i < g_subscription_count; ++i)
                    subscriptions.ids[subscriptions.count++] = g_subscriptions[i].event.id;
                if (g_watch.event.id && SubscriptionIndex(g_watch.event.id) == g_subscription_count)
                    subscriptions.ids[subscriptions.count++] = g_watch.event.id;
                generation = g_generation;
            }
            if (!subscriptions.count) {
                DisconnectPush(session);
                session = {};
                std::scoped_lock lock(g_watch_lock);
                if (generation == g_generation) {
                    g_pending_begin = g_pending_count = 0;
                    g_alert_state = AppointmentAlertWaiting;
                    g_watch_changed.Wait(g_watch_lock);
                }
                return;
            }
            ServicePendingAlerts();
            if (!StepPush(session, subscriptions, generation)) LegacyIteration(generation);
        }

        void Worker(void *) {
            // Retire a file left behind by a reboot or interrupted SD write.
            static_cast<void>(fs::DeleteFile(NotificationPath));
            static_cast<void>(fs::DeleteFile(TemporaryPath));
            PushSession session{};
            for (;;) WorkerIteration(session);
        }

        bool StartWorkerLocked() {
            if (g_worker_started) return true;
            if (R_FAILED(os::CreateThread(&g_worker, Worker, nullptr, g_worker_stack, sizeof(g_worker_stack), os::DefaultThreadPriority)))
                return false;
            os::StartThread(&g_worker);
            g_worker_started = true;
            return true;
        }

        void AssignWatchLocked(const AppointmentWatchRequest &request, bool explicit_watch) {
            if (SameEvent(g_watch.event, request)) {
                g_watch.explicit_watch |= explicit_watch;
            } else {
                ClearWatch();
                g_watch.event = request;
                g_watch.explicit_watch = explicit_watch;
            }
            g_watch_changed.Signal();
        }
    }

    void SyncAppointmentClock(u64 server_now) {
        if (!server_now) return;
        std::scoped_lock lock(g_watch_lock);
        if (server_now <= NowLocked()) return;
        g_relay_time = server_now;
        g_relay_tick = MonotonicMs();
    }

    u32 AppointmentAlertState() {
        if (!ToastAvailable()) return AppointmentAlertDisabled;
        std::scoped_lock lock(g_watch_lock);
        return g_alert_generation == g_generation ? g_alert_state : static_cast<u32>(AppointmentAlertWaiting);
    }

    u32 SetAppointmentWatch(const AppointmentWatchRequest &request, bool explicit_watch) {
        if (!request.id || request.enabled > 1 || request.reserved) return AppointmentInvalid;
        if (!request.enabled) {
            std::scoped_lock lock(g_watch_lock);
            if (g_watch.event.id == request.id) {
                ClearWatch();
                g_watch_changed.Signal();
            }
            return AppointmentOk;
        }
        if (!ToastAvailable()) return APPOINTMENT_ALERTS_DISABLED;
        std::scoped_lock lock(g_watch_lock);
        if (!ValidWindow(request, NowLocked())) return AppointmentInvalid;
        if (!StartWorkerLocked()) return AppointmentUnavailable;
        AssignWatchLocked(request, explicit_watch);
        return AppointmentOk;
    }

    u64 GetAppointmentWatch() {
        std::scoped_lock lock(g_watch_lock);
        return g_watch.event.id;
    }

    void SetReadyAppointment(const AppointmentWatchRequest &request) {
        std::scoped_lock lock(g_watch_lock);
        const u64 now = NowLocked();
        if (!ValidWindow(request, now) || !InAlertWindow(request.starts_at, now)) return;
        g_ready_event = request;
        g_ready_until = now + ReadyLeaseSeconds;
        if (StartWorkerLocked()) AssignWatchLocked(request, false);
    }

    void ClearReadyAppointment(u64 id) {
        std::scoped_lock lock(g_watch_lock);
        if (g_ready_event.id == id) {
            g_ready_event = {};
            g_ready_until = 0;
        }
        if (g_watch.event.id == id && !g_watch.explicit_watch) {
            ClearWatch();
            g_watch_changed.Signal();
        }
    }

    void CancelAppointmentReady(u64 id) {
        ClearReadyAppointment(id);
    }

    u64 ReadyAppointmentForRoom(u64 game_id) {
        std::scoped_lock lock(g_watch_lock);
        const u64 now = NowLocked();
        return g_ready_event.id && game_id == g_ready_event.game_id &&
            now < g_ready_until && InAlertWindow(g_ready_event.starts_at, now) ? g_ready_event.id : 0;
    }

    void InitializeAppointmentSubscriptions() {
        std::scoped_lock lock(g_watch_lock);
        if (LoadSubscriptionsLocked() && g_subscription_count)
            static_cast<void>(StartWorkerLocked());
    }

    void GetAppointmentSubscriptions(AppointmentSubscriptions *out) {
        *out = {};
        std::scoped_lock lock(g_watch_lock);
        if (!LoadSubscriptionsLocked()) return;
        PruneSubscriptionsLocked(NowLocked());
        if (g_subscription_count) static_cast<void>(StartWorkerLocked());
        out->count = static_cast<u32>(g_subscription_count);
        for (size_t i = 0; i < g_subscription_count; ++i)
            out->ids[i] = g_subscriptions[i].event.id;
    }

    u32 SetAppointmentSubscription(const AppointmentWatchRequest &request) {
        if (!request.id || request.enabled > 1 || request.reserved) return AppointmentInvalid;
        std::scoped_lock lock(g_watch_lock);
        const u64 now = NowLocked();
        if (request.enabled && !ValidWindow(request, now)) return AppointmentInvalid;
        if (!LoadSubscriptionsLocked()) return AppointmentStorage;
        PruneSubscriptionsLocked(now);
        const size_t index = SubscriptionIndex(request.id);
        const bool exists = index < g_subscription_count;
        if (!request.enabled && !exists) return AppointmentOk;
        if (request.enabled && exists && SameEvent(g_subscriptions[index].event, request)) {
            static_cast<void>(StartWorkerLocked());
            return AppointmentOk;
        }
        if (request.enabled && !exists && g_subscription_count == APPOINTMENT_SUBSCRIPTION_LIMIT)
            return AppointmentLimit;

        SavedSubscriptions state = SubscriptionSnapshot();
        if (request.enabled) {
            state.events[index] = SaveEvent(request);
            if (!exists) ++state.count;
        } else {
            for (size_t i = index + 1; i < state.count; ++i) state.events[i - 1] = state.events[i];
            state.events[--state.count] = {};
        }
        if (!StoreSubscriptionsLocked(state)) return AppointmentStorage;

        if (request.enabled) {
            if (!exists) ++g_subscription_count;
            g_subscriptions[index] = {};
            g_subscriptions[index].event = request;
            ++g_generation;
            static_cast<void>(StartWorkerLocked());
        } else {
            RemoveSubscriptionLocked(index);
        }
        g_watch_changed.Signal();
        return AppointmentOk;
    }

}
