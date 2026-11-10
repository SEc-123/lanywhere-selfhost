/* Public appointments control frame and Switch IPC layout. GPL-2.0-only. */
#ifndef LANYWHERE_APPOINTMENTS_H
#define LANYWHERE_APPOINTMENTS_H

#include <stddef.h>
#include <stdint.h>

#define APPOINTMENT_IPC_EXCHANGE 13
#define APPOINTMENT_IPC_ROOMS 14
#define APPOINTMENT_IPC_SET_WATCH 15
#define APPOINTMENT_IPC_GET_WATCH 16
#define APPOINTMENT_IPC_SUBSCRIPTIONS 22
#define APPOINTMENT_IPC_SUBSCRIBE 23
#define APPOINTMENT_IPC_ALERT_STATE 26
#define APPOINTMENT_SUBSCRIPTION_LIMIT 24
#define APPOINTMENT_PUSH_SUBSCRIPTION_LIMIT (APPOINTMENT_SUBSCRIPTION_LIMIT + 1)
#define APPOINTMENT_PUSH_CAPABILITY 4096u
#define APPOINTMENT_PUSH_REQUEST_TYPE 0x29
#define APPOINTMENT_PUSH_EVENT_TYPE 0xa9
#define APPOINTMENT_ALERTS_DISABLED 6  /* IPC 15 only, never a wire status. */
#define APPOINTMENT_REQUEST_TYPE 0x26
#define APPOINTMENT_RESPONSE_TYPE 0xa6
#define APPOINTMENT_PAGE_SIZE 6
#define APPOINTMENT_END UINT32_MAX
#define APPOINTMENT_EARLY_SECONDS 1800
#define APPOINTMENT_ACTIVE_SECONDS 7200

enum AppointmentOperation {
    AppointmentList = 1,
    AppointmentCreate,
    AppointmentFollow,
    AppointmentUnfollow
};

enum AppointmentStatus {
    AppointmentOk,
    AppointmentUnavailable,
    AppointmentInvalid,
    AppointmentLimit,
    AppointmentNotFound,
    AppointmentStorage
};

enum AppointmentAlertStatus {
    AppointmentAlertDisabled,
    AppointmentAlertWaiting,
    AppointmentAlertConnected,
    AppointmentAlertLegacy
};

/* Integers are little-endian. All reserved bytes must be zero. */
typedef struct {
    uint8_t op;
    uint8_t reserved[3];
    uint32_t offset;
    uint8_t participant[16];
    uint64_t id;
    uint64_t starts_at;
    uint64_t game_id;
    uint64_t app_id;
} AppointmentRequest;

typedef struct {
    uint64_t id;
    uint64_t starts_at;
    uint64_t game_id;
    uint64_t app_id;
    uint32_t interested;
    uint8_t followed;
    uint8_t reserved[3];
} AppointmentRow;

typedef struct {
    uint32_t status;
    uint32_t count;
    uint32_t next;
    uint32_t reserved;
    uint64_t now;
    AppointmentRow rows[APPOINTMENT_PAGE_SIZE];
} AppointmentResponse;

typedef struct {
    uint64_t game_id;
    uint32_t offset;
    uint32_t reserved;
} AppointmentRoomsRequest;

typedef struct {
    uint64_t id;
    uint64_t starts_at;
    uint64_t game_id;
    uint64_t app_id;
    uint32_t enabled;
    uint32_t reserved;
} AppointmentWatchRequest;

typedef struct {
    uint32_t count;
    uint32_t reserved;
    uint64_t ids[APPOINTMENT_SUBSCRIPTION_LIMIT];
} AppointmentSubscriptions;

/* The extra slot carries a separate temporary Ready watch. */
typedef struct {
    uint32_t count;
    uint32_t reserved;
    uint64_t ids[APPOINTMENT_PUSH_SUBSCRIPTION_LIMIT];
} AppointmentPushSubscriptions;

#if defined(__cplusplus)
static_assert(sizeof(AppointmentRequest) == 56 && offsetof(AppointmentRequest, id) == 24);
static_assert(sizeof(AppointmentRow) == 40 && offsetof(AppointmentRow, followed) == 36);
static_assert(sizeof(AppointmentResponse) == 264 && offsetof(AppointmentResponse, rows) == 24);
static_assert(sizeof(AppointmentRoomsRequest) == 16);
static_assert(sizeof(AppointmentWatchRequest) == 40);
static_assert(sizeof(AppointmentSubscriptions) == 200);
static_assert(sizeof(AppointmentPushSubscriptions) == 208);
#else
_Static_assert(sizeof(AppointmentRequest) == 56 && offsetof(AppointmentRequest, id) == 24, "appointment request");
_Static_assert(sizeof(AppointmentRow) == 40 && offsetof(AppointmentRow, followed) == 36, "appointment row");
_Static_assert(sizeof(AppointmentResponse) == 264 && offsetof(AppointmentResponse, rows) == 24, "appointment response");
_Static_assert(sizeof(AppointmentRoomsRequest) == 16, "appointment rooms request");
_Static_assert(sizeof(AppointmentWatchRequest) == 40, "appointment watch request");
_Static_assert(sizeof(AppointmentSubscriptions) == 200, "appointment subscriptions");
_Static_assert(sizeof(AppointmentPushSubscriptions) == 208, "appointment push subscriptions");
#endif

#endif
