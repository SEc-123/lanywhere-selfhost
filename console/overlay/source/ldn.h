/* Modified by LANywhere Self-host, 2026-11-07 to 2026-11-08. */
#pragma once
#include <switch.h>
#include "../../../common/room_passcode.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    Service s;
} LdnMitmConfigService;

Result ldnMitmGetVersion(LdnMitmConfigService *s, char *version);
Result ldnMitmGetLogging(LdnMitmConfigService *s, u32 *enabled);
Result ldnMitmSetLogging(LdnMitmConfigService *s, u32 enabled);
Result ldnMitmGetEnabled(LdnMitmConfigService *s, u32 *enabled);
Result ldnMitmSetEnabled(LdnMitmConfigService *s, u32 enabled);
Result ldnMitmGetConfigFromService(Service* s, LdnMitmConfigService *out);
/* Nonblocking Atmosphere SM queries; avoid waiting on an absent named service. */
Result lanywhereOverlayHasService(bool *present, bool config);

/* Mirrors the existing native IPC v5 status ABI; no network sockets are opened. */
#define LANYWHERE_OVERLAY_IPC_MAJOR 5
typedef struct {
    u8 state, my_index, member_count, padding;
    u32 my_ip;
    char code[8];
    u64 game_id;
    u32 packets_sent, packets_received;
    char error[64];
} LanywhereOverlayStatus;
typedef struct {
    u64 game_id;
    u32 ttl_seconds;
    u8 mode, state, players, target;
    char room[8];
    char error[64];
} LanywhereOverlayMatch;
#ifdef __cplusplus
static_assert(sizeof(LanywhereOverlayStatus) == 96 && sizeof(LanywhereOverlayMatch) == 88);
#else
_Static_assert(sizeof(LanywhereOverlayStatus) == 96 && sizeof(LanywhereOverlayMatch) == 88, "native status IPC ABI");
#endif
Result lanywhereOverlayGetProtocol(Service *s, u32 *version);
Result lanywhereOverlayGetStatus(Service *s, LanywhereOverlayStatus *out);
Result lanywhereOverlayGetMatch(Service *s, LanywhereOverlayMatch *out);
Result lanywhereOverlayGetPasscodeHost(Service *s, RoomPasscodeHost *out);
Result lanywhereOverlaySetRoomAccess(Service *s, const RoomAccessChange *change, u32 *status);

#ifdef __cplusplus
}
#endif
