// SPDX-License-Identifier: GPL-2.0-only
#pragma once
#include "lanywhere_relay.hpp"

namespace ams::mitm::lanywhere {

    u32 SetAppointmentWatch(const AppointmentWatchRequest &request, bool explicit_watch);
    u64 GetAppointmentWatch();
    void CancelAppointmentReady(u64 id);

    void InitializeAppointmentSubscriptions();
    void GetAppointmentSubscriptions(AppointmentSubscriptions *out);
    u32 SetAppointmentSubscription(const AppointmentWatchRequest &request);
    void SyncAppointmentClock(u64 server_now);
    u32 AppointmentAlertState();

    void SetReadyAppointment(const AppointmentWatchRequest &request);
    void ClearReadyAppointment(u64 id);
    u64 ReadyAppointmentForRoom(u64 game_id);

}
