/* Modified by LANywhere Self-host, 2026-11-07 to 2026-11-08. */
#include "ldn.h"
#include <switch/sf/tipc.h>
#include <string.h>

/* Atmosphere SM extension ABI, as in Atmosphere-NX sm_ams.os.horizon.c
 * (GPL-2.0): 65004 HasMitm, 65100 HasService; the result is one byte. */
Result lanywhereOverlayHasService(bool *present, bool config) {
    *present = false;
    u8 value = 0;
    const SmServiceName name = smEncodeName(config ? "ldn:u" : "lanywhr");
    Result rc = tipcDispatchInOut(smGetServiceSessionTipc(), config ? 65004 : 65100, name, value);
    if (R_SUCCEEDED(rc)) *present = (value & 1) != 0;
    return rc;
}

Result ldnMitmGetConfigFromService(Service* s, LdnMitmConfigService *out) {
    return serviceDispatch(s, 65000,
        .out_num_objects = 1,
        .out_objects = &out->s
    );
}

Result ldnMitmGetLogging(LdnMitmConfigService *s, u32 *enabled) {
    *enabled = 0;
    u32 value = 0;
    Result rc = serviceDispatchOut(&s->s, 65002, value);
    if (R_SUCCEEDED(rc)) *enabled = value != 0;
    return rc;
}

Result ldnMitmSetLogging(LdnMitmConfigService *s, u32 enabled) {
    return serviceDispatchIn(&s->s, 65003, enabled);
}

Result ldnMitmGetEnabled(LdnMitmConfigService *s, u32 *enabled) {
    *enabled = 0;
    u32 value = 0;
    Result rc = serviceDispatchOut(&s->s, 65004, value);
    if (R_SUCCEEDED(rc)) *enabled = value != 0;
    return rc;
}

Result ldnMitmSetEnabled(LdnMitmConfigService *s, u32 enabled) {
    return serviceDispatchIn(&s->s, 65005, enabled);
}

Result ldnMitmGetVersion(LdnMitmConfigService *s, char *version) {
    char version_s[32] = {0};
    memset(version, 0, 32);
    Result rc = serviceDispatchOut(&s->s, 65001, version_s);
    if (R_SUCCEEDED(rc)) {
        memcpy(version, version_s, 31);
        version[31] = '\0';
    }
    return rc;
}

Result lanywhereOverlayGetProtocol(Service *s, u32 *version) {
    *version = 0;
    return serviceDispatchOut(s, 10, *version);
}
Result lanywhereOverlayGetStatus(Service *s, LanywhereOverlayStatus *out) {
    memset(out, 0, sizeof(*out));
    LanywhereOverlayStatus value = {0};
    Result rc = serviceDispatchOut(s, 3, value);
    if (R_FAILED(rc)) return rc;
    if (value.state > 3 || value.member_count > 8 || (value.state == 2 && value.my_index >= 8))
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    value.code[6] = value.code[7] = '\0';
    value.error[63] = '\0';
    *out = value;
    return 0;
}
Result lanywhereOverlayGetMatch(Service *s, LanywhereOverlayMatch *out) {
    memset(out, 0, sizeof(*out));
    LanywhereOverlayMatch value = {0};
    Result rc = serviceDispatchOut(s, 9, value);
    if (R_FAILED(rc)) return rc;
    if (value.state > 8 || value.mode > 2 || value.players > 8 || value.target > 8)
        return MAKERESULT(Module_Libnx, LibnxError_BadInput);
    value.room[6] = value.room[7] = '\0';
    value.error[63] = '\0';
    *out = value;
    return 0;
}
