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

}
