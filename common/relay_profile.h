#pragma once

/* Both Switch binaries use this profile. Set FIXED to 0 for a self-hosted
 * build that reads the relay address from SD. Rebuild the app and sysmodule
 * together after changing the profile. */
#ifndef RELAY_PROFILE_FIXED
#define RELAY_PROFILE_FIXED 1
#endif
#define RELAY_PROFILE_IPV4 "49.233.147.207"
#define RELAY_PROFILE_PORT 11460

/* Opt in with the verified public IPv4 of the Europe relay. The directory
 * must advertise the same address; an empty value leaves Europe disabled. */
#ifndef RELAY_PROFILE_EU_IPV4
#define RELAY_PROFILE_EU_IPV4 ""
#endif
#ifndef RELAY_PROFILE_EU_PORT
#define RELAY_PROFILE_EU_PORT 11460
#endif
