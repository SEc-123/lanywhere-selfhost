#pragma once
#include "../preview/switch.h"

typedef struct { unsigned signals; } UEvent;
typedef struct { int locked; } Mutex;
typedef struct { int unused; } Service;
enum { SfBufferAttr_HipcMapAlias = 1, SfBufferAttr_In = 2, SfBufferAttr_Out = 4 };
enum {
    HidNpadButton_AnyLeft = HidNpadButton_Left, HidNpadButton_AnyRight = 1u << 13,
    HidNpadButton_AnyUp = 1u << 14, HidNpadButton_AnyDown = 1u << 15
};
typedef struct {
    unsigned buffer_attrs[2];
    struct { void *pointer; size_t size; } buffers[2];
} AppointmentTestDispatch;
Result mock_appointment_dispatch(Service *, unsigned, AppointmentTestDispatch);
Result mock_appointment_dispatch_in_out(Service *, unsigned, const void *, size_t, void *, size_t);
Result mock_appointment_dispatch_out(Service *, unsigned, void *, size_t);
#define serviceDispatch(service, command, ...) \
    mock_appointment_dispatch(service, command, (AppointmentTestDispatch){__VA_ARGS__})
#define serviceDispatchInOut(service, command, input, output) \
    mock_appointment_dispatch_in_out(service, command, &(input), sizeof(input), &(output), sizeof(output))
#define serviceDispatchOut(service, command, value) \
    mock_appointment_dispatch_out(service, command, &(value), sizeof(value))

static inline void mutexInit(Mutex *mutex) { mutex->locked = 0; }
static inline void mutexLock(Mutex *mutex) { mutex->locked++; }
static inline void mutexUnlock(Mutex *mutex) { mutex->locked--; }
static inline void ueventSignal(UEvent *event) { event->signals++; }

typedef struct { u16 year; u8 month, day, hour, minute, second, pad; } TimeCalendarTime;
typedef struct { s32 offset; } TimeCalendarAdditionalInfo;
Result timeToCalendarTimeWithMyRule(u64 utc, TimeCalendarTime *out, TimeCalendarAdditionalInfo *);
Result timeToPosixTimeWithMyRule(const TimeCalendarTime *, u64 *, s32 capacity, s32 *count);
