/* Modified by LANywhere Self-host, 2026-11-07 to 2026-11-08. */
/*
 * LANywhere: servicio "lanywhr" (ver lanywhere_service.hpp).
 *
 * This program is free software; you can redistribute it and/or modify it under the terms and conditions of
 * the GNU General Public License, version 2, as published by the Free Software Foundation.
 */
#include "lanywhere_service.hpp"
#include "appointment_notifier.hpp"
#include <algorithm>
#include <cstring>

namespace ams::mitm::lanywhere {

    namespace {

        // Copia un búfer de texto del cliente a una cadena terminada en cero.
        void CopyText(char *dst, size_t dst_size, const sf::InBuffer &src) {
            const size_t n = std::min(src.GetSize(), dst_size - 1);
            std::memcpy(dst, src.GetPointer(), n);
            dst[n] = '\0';
        }

        void UseBootAppointmentParticipant(AppointmentRequest *request) {
            static constinit os::SdkMutex lock;
            static u8 participant[16]{};
            static bool initialized = false;
            std::scoped_lock guard(lock);
            if (!initialized) {
                do { os::GenerateRandomBytes(participant, sizeof(participant)); }
                while (!std::any_of(participant, participant + sizeof(participant), [](u8 value) { return value != 0; }));
                initialized = true;
            }
            std::memcpy(request->participant, participant, sizeof(participant));
        }

    }

    Result LanywhereService::CreateRoom(u64 game_id, const sf::InBuffer &nick) {
        AMS_UNUSED(nick);  // el nombre es el apodo de config.ini
        R_RETURN(lanywhere::CreateRoom(game_id));
    }

    Result LanywhereService::JoinRoom(u64 game_id, const sf::InBuffer &code, const sf::InBuffer &nick) {
        AMS_UNUSED(nick);
        char room[CodeLength + 1];
        CopyText(room, sizeof(room), code);
        R_RETURN(lanywhere::JoinRoom(room, game_id));
    }

    Result LanywhereService::LeaveRoom() {
        lanywhere::LeaveRoom();
        R_SUCCEED();
    }

    namespace {

        struct GroupList {
            GroupSummary *out;
            size_t capacity, count;
        };

        void AddGroup(const char *code, const void *data, void *user) {
            GroupList *list = static_cast<GroupList *>(user);
            if (list->count >= list->capacity) {
                return;
            }
            // NetworkInfo de ldn: id del juego en 0, máximo y jugadores en 0x66 y 0x67, nombre del nodo 0 en 0x74.
            const u8 *info = static_cast<const u8 *>(data);
            GroupSummary &g = list->out[list->count++];
            std::memset(std::addressof(g), 0, sizeof(g));
            util::Strlcpy(g.code, code, sizeof(g.code));
            std::memcpy(std::addressof(g.game_id), info, sizeof(g.game_id));
            g.max_players = info[0x66];
            g.players = info[0x67];
            std::memcpy(g.host, info + 0x68 + 12, 32);
            g.host[32] = '\0';
        }

    }

    Result LanywhereService::ListGroups(sf::Out<s32> count, const sf::OutBuffer &out) {
        GroupList list = { reinterpret_cast<GroupSummary *>(out.GetPointer()), out.GetSize() / sizeof(GroupSummary), 0 };
        const int found = lanywhere::FindGroups(0, AddGroup, std::addressof(list), true);
        count.SetValue(found < 0 ? -1 : static_cast<s32>(list.count));
        R_SUCCEED();
    }

    Result LanywhereService::PreferGroup(const sf::InBuffer &code) {
        if (code.GetSize() == 0) {
            lanywhere::CancelMatch();
            R_SUCCEED();
        }
        if (code.GetSize() != CodeLength) return ResultRelayFailed();
        char room[CodeLength + 1];
        CopyText(room, sizeof(room), code);
        R_RETURN(lanywhere::StartMatch(MatchMode::Exact, room));
    }

    Result LanywhereService::StartQuickMatch() {
        R_RETURN(lanywhere::StartMatch(MatchMode::Quick));
    }

    Result LanywhereService::CancelMatch() {
        lanywhere::CancelMatch();
        R_SUCCEED();
    }

    Result LanywhereService::GetMatchStatus(sf::Out<MatchStatus> out) {
        MatchStatus status;
        lanywhere::GetMatchStatus(&status);
        out.SetValue(status);
        R_SUCCEED();
    }

    Result LanywhereService::GetProtocolCapabilities(sf::Out<u32> out) {
        out.SetValue(ProtocolVersion);
        R_SUCCEED();
    }

    Result LanywhereService::ListGroupsPage(u32 offset, sf::Out<GroupPage> page, const sf::OutBuffer &out) {
        GroupPage result = { -1, GroupPageEnd };
        GroupList list = { reinterpret_cast<GroupSummary *>(out.GetPointer()), out.GetSize() / sizeof(GroupSummary), 0 };
        if (list.capacity >= GroupPageSize) {
            const int found = lanywhere::FindGroupsPage(0, offset, &result.next, AddGroup, &list);
            if (found >= 0) result.count = static_cast<s32>(list.count);
        }
        page.SetValue(result);
        R_SUCCEED();
    }

    Result LanywhereService::GetNickname(const sf::OutBuffer &out) {
        if (out.GetSize() > 0) {
            lanywhere::Nickname(reinterpret_cast<char *>(out.GetPointer()), out.GetSize());
        }
        R_SUCCEED();
    }

    Result LanywhereService::GetStatus(sf::Out<Status> out) {
        Status status;
        lanywhere::GetStatus(std::addressof(status));
        out.SetValue(status);
        R_SUCCEED();
    }

    Result LanywhereService::ListGroupsV2(u32 offset, sf::Out<GroupPageV2> page, const sf::OutBuffer &out) {
        GroupPageV2 result{-1, GroupPageEnd, 0, ListStatusProtocol};
        if (out.GetSize() >= GroupPageSize * sizeof(GroupSummaryV2))
            static_cast<void>(FindGroupSummaries(offset, &result, reinterpret_cast<GroupSummaryV2 *>(out.GetPointer()), out.GetSize() / sizeof(GroupSummaryV2)));
        page.SetValue(result);
        R_SUCCEED();
    }

    Result LanywhereService::AppointmentExchange(const sf::InBuffer &request, const sf::OutBuffer &out) {
        if (out.GetSize() != sizeof(AppointmentResponse)) return ResultRelayFailed();
        AppointmentResponse response{};
        response.status = AppointmentUnavailable;
        response.next = APPOINTMENT_END;
        if (request.GetSize() == sizeof(AppointmentRequest)) {
            AppointmentRequest input{};
            std::memcpy(&input, request.GetPointer(), sizeof(input));
            UseBootAppointmentParticipant(&input);
            ExchangeAppointment(input, &response);
            if (response.status == AppointmentOk && input.op == AppointmentFollow) {
                const AppointmentRow *ready = nullptr;
                for (size_t i = 0; i < response.count; ++i)
                    if (response.rows[i].id == input.id && response.rows[i].followed) ready = &response.rows[i];
                if (ready) {
                    const AppointmentWatchRequest watch{ready->id, ready->starts_at, ready->game_id, ready->app_id, 1, 0};
                    lanywhere::SetReadyAppointment(watch);
                }
            } else if (response.status == AppointmentOk && input.op == AppointmentUnfollow) {
                lanywhere::ClearReadyAppointment(input.id);
            }
        }
        std::memcpy(out.GetPointer(), &response, sizeof(response));
        R_SUCCEED();
    }

    Result LanywhereService::ListAppointmentRooms(AppointmentRoomsRequest request, sf::Out<GroupPageV2> page, const sf::OutBuffer &out) {
        GroupPageV2 result{-1, GroupPageEnd, 0, ListStatusProtocol};
        if (!request.reserved && request.game_id && request.game_id != UINT64_MAX &&
            out.GetSize() >= GroupPageSize * sizeof(GroupSummaryV2)) {
            static_cast<void>(FindGroupSummaries(request.offset, &result,
                reinterpret_cast<GroupSummaryV2 *>(out.GetPointer()), out.GetSize() / sizeof(GroupSummaryV2),
                request.game_id, true));
        }
        page.SetValue(result);
        R_SUCCEED();
    }

    Result LanywhereService::SetAppointmentWatch(AppointmentWatchRequest request, sf::Out<u32> status) {
        status.SetValue(lanywhere::SetAppointmentWatch(request, true));
        R_SUCCEED();
    }

    Result LanywhereService::GetAppointmentWatch(sf::Out<u64> id) {
        id.SetValue(lanywhere::GetAppointmentWatch());
        R_SUCCEED();
    }

    Result LanywhereService::SetRoomPasscode(RoomPasscodeChange change, sf::Out<u32> status) {
        status.SetValue(ShareRoomPasscode(change));
        R_SUCCEED();
    }

    Result LanywhereService::GetRoomPasscode(RoomPasscodeLookup lookup, sf::Out<RoomPasscodeReply> reply) {
        reply.SetValue(LookupRoomPasscode(lookup));
        R_SUCCEED();
    }

    Result LanywhereService::GetRoomPasscodeHost(sf::Out<RoomPasscodeHost> host) {
        host.SetValue(DescribeRoomPasscodeHost());
        R_SUCCEED();
    }

    Result LanywhereService::SetGameRoomAccess(RoomAccessChange change, sf::Out<u32> status) {
        status.SetValue(lanywhere::SetRoomAccess(change));
        R_SUCCEED();
    }

    Result LanywhereService::UnlockGameRoom(RoomAccessUnlock unlock, sf::Out<u32> status) {
        status.SetValue(lanywhere::UnlockRoomAccess(unlock));
        R_SUCCEED();
    }

    Result LanywhereService::ReadAppointmentSubscriptions(const sf::OutBuffer &out) {
        if (out.GetSize() != sizeof(AppointmentSubscriptions)) return ResultRelayFailed();
        AppointmentSubscriptions result{};
        GetAppointmentSubscriptions(&result);
        std::memcpy(out.GetPointer(), &result, sizeof(result));
        R_SUCCEED();
    }

    Result LanywhereService::UpdateAppointmentSubscription(AppointmentWatchRequest request, sf::Out<u32> status) {
        status.SetValue(SetAppointmentSubscription(request));
        R_SUCCEED();
    }


    Result LanywhereService::ListUnifiedRooms(UnifiedRoomsRequest request, sf::Out<UnifiedPage> page, const sf::OutBuffer &out) {
        UnifiedPage result{-1, UNIFIED_LOBBY_END, 0, 0, 0, ListStatusProtocol};
        if (out.GetSize() >= UNIFIED_LOBBY_PAGE_SIZE * sizeof(UnifiedGroup))
            FindUnifiedRooms(request, &result, reinterpret_cast<UnifiedGroup *>(out.GetPointer()), out.GetSize() / sizeof(UnifiedGroup));
        page.SetValue(result);
        R_SUCCEED();
    }

    Result LanywhereService::SelectUnifiedLobbyRoom(UnifiedRoomRequest request) {
        R_RETURN(lanywhere::SelectUnifiedRoom(request));
    }

    Result LanywhereService::GetAppointmentAlertState(sf::Out<u32> status) {
        status.SetValue(lanywhere::AppointmentAlertState());
        R_SUCCEED();
    }

}
