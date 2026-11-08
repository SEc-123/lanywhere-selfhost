#pragma once

/* IPC v5 GroupPage.reserved: zero on success, bounded reason on count == -1.
 * Older clients still treat these negative pages as an unavailable list.
 * Values are shared by the native service and app; no wire layout changes. */
enum LanywhereListStatus {
    ListStatusOk = 0,
    ListStatusNetwork = 1,
    ListStatusUnavailable = 2,
    ListStatusBusy = 3,
    ListStatusTimeout = 4,
    ListStatusProtocol = 5,
    ListStatusConfig = 6,
    ListStatusPaused = 7,
    ListStatusUpdate = 8
};

static inline unsigned lanywhere_list_error_status(unsigned code) {
    switch (code) {
        case 7: return ListStatusBusy;
        case 8: return ListStatusUpdate;
        case 11: return ListStatusUnavailable;
        case 6: return ListStatusPaused;
        case 13: return ListStatusTimeout;
        default: return ListStatusProtocol;
    }
}

static inline int lanywhere_list_status_valid(unsigned status) {
    return status >= ListStatusNetwork && status <= ListStatusUpdate;
}
