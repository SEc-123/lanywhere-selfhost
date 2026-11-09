#pragma once
#include "../preview/switch.h"

typedef struct { unsigned signals; } UEvent;
typedef struct { bool locked; } Mutex;
typedef struct { int unused; } Service;
typedef struct { unsigned limit; const char *header, *subtext; } SwkbdConfig;

void mutexInit(Mutex *);
void mutexLock(Mutex *);
void mutexUnlock(Mutex *);
void ueventSignal(UEvent *);
Result mock_password_dispatch(Service *, unsigned, const void *, size_t, void *, size_t);
#define serviceDispatchInOut(service, command, input, output) \
    mock_password_dispatch(service, command, &(input), sizeof(input), &(output), sizeof(output))
#define serviceDispatchOut(service, command, output) \
    mock_password_dispatch(service, command, NULL, 0, &(output), sizeof(output))

Result swkbdCreate(SwkbdConfig *, int);
void swkbdConfigMakePresetPassword(SwkbdConfig *);
void swkbdConfigSetHeaderText(SwkbdConfig *, const char *);
void swkbdConfigSetSubText(SwkbdConfig *, const char *);
void swkbdConfigSetStringLenMax(SwkbdConfig *, unsigned);
Result swkbdShow(SwkbdConfig *, char *, size_t);
void swkbdClose(SwkbdConfig *);
