/* Regional room routing. SPDX-License-Identifier: GPL-2.0-only */
#ifndef LANYWHERE_REGIONAL_RELAY_H
#define LANYWHERE_REGIONAL_RELAY_H

#include <stdint.h>
#include "room_passcode.h"

#define REGION_PROVIDER_EU "relay-eu"
#define REGIONAL_LOBBY_CAPABILITY 8192u
#define REGIONAL_LOBBY_REQUEST_TYPE 0x2a
#define REGIONAL_LOBBY_RESPONSE_TYPE 0xaa
#define REGIONAL_LOBBY_IPC_LIST 27
#define RELAY_REGION_IPC_GET 28
#define RELAY_REGION_IPC_SET 29
#define REGIONAL_PASSCODE_IPC_GET 30
#define REGIONAL_PASSCODE_IPC_UNLOCK 31

enum RelayRegion {
    RelayRegionDefault = 0,
    RelayRegionEurope = 1,
};

typedef struct {
    RoomPasscodeLookup lookup;
    uint32_t region;
    uint32_t reserved;
} RegionalPasscodeLookup;

typedef struct {
    RoomAccessUnlock unlock;
    uint32_t region;
    uint32_t reserved;
} RegionalAccessUnlock;

#if defined(__cplusplus)
static_assert(sizeof(RegionalPasscodeLookup) == 24);
static_assert(sizeof(RegionalAccessUnlock) == 48);
#else
_Static_assert(sizeof(RegionalPasscodeLookup) == 24, "regional password lookup");
_Static_assert(sizeof(RegionalAccessUnlock) == 48, "regional password unlock");
#endif

#endif
