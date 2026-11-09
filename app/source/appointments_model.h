#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "../../common/appointments.h"

typedef struct {
    int year, month, day;
} AppointmentDate;

bool appointment_expired(uint64_t start, uint64_t now);
bool appointment_rooms_open(uint64_t start, uint64_t now);
bool appointment_response_valid(const AppointmentResponse *page, uint32_t offset);
int appointment_find_row(const AppointmentResponse *page, uint64_t id);
AppointmentDate appointment_date_after(AppointmentDate date, unsigned days);
