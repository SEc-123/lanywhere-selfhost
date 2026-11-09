/* Modified by LANywhere Self-host, 2026-11-07 to 2026-11-08. */
/*
 * LANywhere: servicio "lanywhr" para que una app (la de "Jugar en línea", o la de pruebas) cree salas, se una
 * a ellas por código, salga y consulte el estado.
 *
 * This program is free software; you can redistribute it and/or modify it under the terms and conditions of
 * the GNU General Public License, version 2, as published by the Free Software Foundation.
 */
#pragma once
#include <stratosphere.hpp>
#include "lanywhere_relay.hpp"

#define AMS_ILANYWHERE_SERVICE(C, H)                                                                                                     \
    AMS_SF_METHOD_INFO(C, H, 0, Result, CreateRoom, (u64 game_id, const ams::sf::InBuffer &nick), (game_id, nick))                 \
    AMS_SF_METHOD_INFO(C, H, 1, Result, JoinRoom,   (u64 game_id, const ams::sf::InBuffer &code, const ams::sf::InBuffer &nick),    \
                                                    (game_id, code, nick))                                                         \
    AMS_SF_METHOD_INFO(C, H, 2, Result, LeaveRoom,  (), ())                                                                         \
    AMS_SF_METHOD_INFO(C, H, 3, Result, GetStatus,  (ams::sf::Out<ams::mitm::lanywhere::Status> out), (out))               \
    AMS_SF_METHOD_INFO(C, H, 4, Result, ListGroups, (ams::sf::Out<s32> count, const ams::sf::OutBuffer &out), (count, out))     \
    AMS_SF_METHOD_INFO(C, H, 5, Result, GetNickname, (const ams::sf::OutBuffer &out), (out))                                     \
    AMS_SF_METHOD_INFO(C, H, 6, Result, PreferGroup, (const ams::sf::InBuffer &code), (code))                              \
    AMS_SF_METHOD_INFO(C, H, 7, Result, StartQuickMatch, (), ())                                                          \
    AMS_SF_METHOD_INFO(C, H, 8, Result, CancelMatch, (), ())                                                              \
    AMS_SF_METHOD_INFO(C, H, 9, Result, GetMatchStatus, (ams::sf::Out<ams::mitm::lanywhere::MatchStatus> out), (out))       \
    AMS_SF_METHOD_INFO(C, H, 10, Result, GetProtocolCapabilities, (ams::sf::Out<u32> out), (out))                         \
    AMS_SF_METHOD_INFO(C, H, 11, Result, ListGroupsPage, (u32 offset, ams::sf::Out<ams::mitm::lanywhere::GroupPage> page,  \
                                                        const ams::sf::OutBuffer &out), (offset, page, out)) \
    AMS_SF_METHOD_INFO(C, H, 12, Result, ListGroupsV2, (u32 offset, ams::sf::Out<ams::mitm::lanywhere::GroupPageV2> page, \
                                                      const ams::sf::OutBuffer &out), (offset, page, out)) \
    AMS_SF_METHOD_INFO(C, H, 13, Result, AppointmentExchange, (const ams::sf::InBuffer &request, \
                                                      const ams::sf::OutBuffer &out), (request, out)) \
    AMS_SF_METHOD_INFO(C, H, 14, Result, ListAppointmentRooms, (AppointmentRoomsRequest request, \
        ams::sf::Out<ams::mitm::lanywhere::GroupPageV2> page, const ams::sf::OutBuffer &out), (request, page, out)) \
    AMS_SF_METHOD_INFO(C, H, 15, Result, SetAppointmentWatch, (AppointmentWatchRequest request, \
        ams::sf::Out<u32> status), (request, status)) \
    AMS_SF_METHOD_INFO(C, H, 16, Result, GetAppointmentWatch, (ams::sf::Out<u64> id), (id)) \
    AMS_SF_METHOD_INFO(C, H, 17, Result, SetRoomPasscode, (RoomPasscodeChange change, ams::sf::Out<u32> status), (change, status)) \
    AMS_SF_METHOD_INFO(C, H, 18, Result, GetRoomPasscode, (RoomPasscodeLookup lookup, ams::sf::Out<RoomPasscodeReply> reply), (lookup, reply)) \
    AMS_SF_METHOD_INFO(C, H, 19, Result, GetRoomPasscodeHost, (ams::sf::Out<RoomPasscodeHost> host), (host)) \
    AMS_SF_METHOD_INFO(C, H, 20, Result, SetGameRoomAccess, (RoomAccessChange change, ams::sf::Out<u32> status), (change, status)) \
    AMS_SF_METHOD_INFO(C, H, 21, Result, UnlockGameRoom, (RoomAccessUnlock unlock, ams::sf::Out<u32> status), (unlock, status)) \
    AMS_SF_METHOD_INFO(C, H, 22, Result, ReadAppointmentSubscriptions, (const ams::sf::OutBuffer &out), (out)) \
    AMS_SF_METHOD_INFO(C, H, 23, Result, UpdateAppointmentSubscription, (AppointmentWatchRequest request, ams::sf::Out<u32> status), (request, status)) \
    AMS_SF_METHOD_INFO(C, H, 24, Result, ListUnifiedRooms, (UnifiedRoomsRequest request, ams::sf::Out<UnifiedPage> page, const ams::sf::OutBuffer &out), (request, page, out)) \
    AMS_SF_METHOD_INFO(C, H, 25, Result, SelectUnifiedLobbyRoom, (UnifiedRoomRequest request), (request))

AMS_SF_DEFINE_INTERFACE(ams::mitm::lanywhere, ILanywhereService, AMS_ILANYWHERE_SERVICE, 0x594E414C)

namespace ams::mitm::lanywhere {

    class LanywhereService {
        public:
            Result CreateRoom(u64 game_id, const sf::InBuffer &nick);
            Result JoinRoom(u64 game_id, const sf::InBuffer &code, const sf::InBuffer &nick);
            Result LeaveRoom();
            Result GetStatus(sf::Out<Status> out);
            Result ListGroups(sf::Out<s32> count, const sf::OutBuffer &out);  // count -1: sin servidor
            Result GetNickname(const sf::OutBuffer &out);
            Result PreferGroup(const sf::InBuffer &code);
            Result StartQuickMatch();
            Result CancelMatch();
            Result GetMatchStatus(sf::Out<MatchStatus> out);
            Result GetProtocolCapabilities(sf::Out<u32> out);
            Result ListGroupsV2(u32 offset, sf::Out<GroupPageV2> page, const sf::OutBuffer &out);
            Result ListGroupsPage(u32 offset, sf::Out<GroupPage> page, const sf::OutBuffer &out);
            Result AppointmentExchange(const sf::InBuffer &request, const sf::OutBuffer &out);
            Result ListAppointmentRooms(AppointmentRoomsRequest request, sf::Out<GroupPageV2> page, const sf::OutBuffer &out);
            Result SetAppointmentWatch(AppointmentWatchRequest request, sf::Out<u32> status);
            Result GetAppointmentWatch(sf::Out<u64> id);
            Result SetRoomPasscode(RoomPasscodeChange change, sf::Out<u32> status);
            Result GetRoomPasscode(RoomPasscodeLookup lookup, sf::Out<RoomPasscodeReply> reply);
            Result GetRoomPasscodeHost(sf::Out<RoomPasscodeHost> host);
            Result SetGameRoomAccess(RoomAccessChange change, sf::Out<u32> status);
            Result UnlockGameRoom(RoomAccessUnlock unlock, sf::Out<u32> status);
            Result ReadAppointmentSubscriptions(const sf::OutBuffer &out);
            Result UpdateAppointmentSubscription(AppointmentWatchRequest request, sf::Out<u32> status);
            Result ListUnifiedRooms(UnifiedRoomsRequest request, sf::Out<UnifiedPage> page, const sf::OutBuffer &out);
            Result SelectUnifiedLobbyRoom(UnifiedRoomRequest request);
    };
    static_assert(IsILanywhereService<LanywhereService>);

}
