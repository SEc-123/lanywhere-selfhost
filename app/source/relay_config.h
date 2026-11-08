#pragma once

#include <stdbool.h>
#include <stdint.h>
#include "../../common/relay_profile.h"

#define RELAY_CONFIG_DIR "sdmc:/lanywhere"
#define RELAY_CONFIG_PATH RELAY_CONFIG_DIR "/config.ini"
#define RELAY_DEFAULT_PORT 11460
#define RELAY_IPV4_SIZE 16

typedef enum {
    RelayConfigNotSet,
    RelayConfigReady,
    RelayConfigInvalid,
    RelayConfigFileError,
} RelayConfigState;

typedef struct {
    char server[RELAY_IPV4_SIZE];
    uint16_t port;
    bool public_groups;
    char provider[33];
} RelayConfig;

bool relay_config_ipv4_valid(const char *server);
bool relay_config_parse_port(const char *text, uint16_t *port);
RelayConfigState relay_config_load(const char *path, RelayConfig *config);
bool relay_config_save_endpoint(const char *path, const char *server, uint16_t port);
bool relay_config_save_public(const char *path, bool public_groups);
bool relay_config_save_nickname(const char *path, const char *nickname);
bool relay_config_save_provider(const char *path, const char *provider);
