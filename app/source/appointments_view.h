#pragma once

#include <switch.h>
#include "game_catalog.h"

#define APPOINTMENT_TOUCH_ROW (1ULL << 60)
#define APPOINTMENT_TOUCH_JOIN (1ULL << 57)
#define APPOINTMENT_TOUCH_JOINED (1ULL << 56)

typedef void (*AppointmentTouchZone)(int x, int y, int w, int h, u64 action);
typedef enum { AppointmentStay, AppointmentBack, AppointmentFindRooms } AppointmentAction;

void appointments_init(UEvent *wake);
void appointments_open(bool worker_available, bool resume);
void appointments_close(void);
bool appointments_active(void);
bool appointments_list_active(void);
bool appointments_worker_exchange(Service *service);
bool appointments_tick(u64 monotonic_ms);
void appointments_capture_touch(u64 action);
AppointmentAction appointments_input(u64 down, u64 held, u64 monotonic_ms,
                                     bool inventory_loading, bool inventory_failed, u64 *game_id);
void appointments_draw(const GameCatalog *catalog, AppointmentTouchZone touch);
