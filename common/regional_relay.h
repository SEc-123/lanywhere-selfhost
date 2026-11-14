/* Regional room routing. SPDX-License-Identifier: GPL-2.0-only */
#ifndef LANYWHERE_REGIONAL_RELAY_H
#define LANYWHERE_REGIONAL_RELAY_H

#include <stdint.h>
#include "room_passcode.h"

#define REGION_PROVIDER_EU "relay-eu"
#define REGION_PROVIDER_COMMUNITY "relay-community"
#define REGIONAL_LOBBY_CAPABILITY 8192u
#define COMMUNITY_LOBBY_CAPABILITY 16384u
#define REGIONAL_ENDPOINT_SIZE 7
#define COMMUNITY_LOBBY_REQUEST_SIZE 22
#define REGIONAL_WIRE_EU_ENABLED 0x40u
#define REGIONAL_WIRE_COMMUNITY_ENABLED 0x80u
#define REGIONAL_WIRE_ENABLED_MASK (REGIONAL_WIRE_EU_ENABLED | REGIONAL_WIRE_COMMUNITY_ENABLED)
#define REGIONAL_LOBBY_REQUEST_TYPE 0x2a
#define REGIONAL_LOBBY_RESPONSE_TYPE 0xaa
#define REGIONAL_LOBBY_IPC_LIST 27
#define RELAY_REGION_IPC_GET 28
#define RELAY_REGION_IPC_SET 29
#define REGIONAL_PASSCODE_IPC_GET 30
#define REGIONAL_PASSCODE_IPC_UNLOCK 31
#define RELAY_REGIONS_IPC_GET 32
#define COMMUNITY_LOBBY_IPC_LIST 33
#define RELAY_REGION_COMMUNITY_ACTIVE (1u << 16)
#define RELAY_COMMUNITY_UNREACHABLE_DESCRIPTION 2

enum RelayRegion {
    RelayRegionDefault = 0,
    RelayRegionEurope = 1,
    RelayRegionCommunity = 2,
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
