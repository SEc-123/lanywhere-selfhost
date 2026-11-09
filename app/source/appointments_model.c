#include "appointments_model.h"

bool appointment_expired(uint64_t start, uint64_t now)
{
    return start && now >= start && now - start >= APPOINTMENT_ACTIVE_SECONDS;
}

bool appointment_rooms_open(uint64_t start, uint64_t now)
{
    return start && now && (now < start ? start - now <= APPOINTMENT_EARLY_SECONDS
                                         : !appointment_expired(start, now));
}

bool appointment_response_valid(const AppointmentResponse *page, uint32_t offset)
{
    if (!page || page->status > AppointmentStorage || page->reserved ||
        page->count > APPOINTMENT_PAGE_SIZE)
        return false;
    if (page->status != AppointmentOk)
        return !page->count && page->next == APPOINTMENT_END;
    if (!page->now || (page->next != APPOINTMENT_END &&
        (!page->count || page->next <= offset || page->next - offset != page->count)))
        return false;
    for (size_t i = 0; i < page->count; i++) {
        const AppointmentRow *r = &page->rows[i];
        if (!r->id || !r->game_id || r->game_id == UINT64_MAX || !r->starts_at ||
            r->followed > 1 || (r->followed && !r->interested) ||
            r->reserved[0] || r->reserved[1] || r->reserved[2])
            return false;
    }
    return true;
}

int appointment_find_row(const AppointmentResponse *page, uint64_t id)
{
    if (!page || !id || page->count > APPOINTMENT_PAGE_SIZE) return -1;
    for (size_t i = 0; i < page->count; i++)
        if (page->rows[i].id == id) return (int)i;
    return -1;
}

AppointmentDate appointment_date_after(AppointmentDate date, unsigned days)
{
    static const int lengths[] = {31,28,31,30,31,30,31,31,30,31,30,31};
    if (date.month < 1 || date.month > 12 || date.day < 1 || days > 7)
        return (AppointmentDate){0};
    while (days--) {
        int end = lengths[date.month - 1];
        if (date.month == 2 && date.year % 4 == 0 &&
            (date.year % 100 != 0 || date.year % 400 == 0))
            end++;
        if (++date.day > end) {
            date.day = 1;
            if (++date.month > 12) {
                date.month = 1;
                date.year++;
            }
        }
    }
    return date;
}
