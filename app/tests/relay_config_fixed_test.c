#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include "relay_config.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#if !RELAY_PROFILE_FIXED
#error "This test requires a fixed relay profile"
#endif

static void write_config(const char *path, const void *data, size_t size)
{
    FILE *file = fopen(path, "wb");
    assert(file);
    assert(fwrite(data, 1, size, file) == size);
    assert(fclose(file) == 0);
}

static void assert_fixed(const char *path, bool public_groups)
{
    RelayConfig config;
    assert(relay_config_load(path, &config) == RelayConfigReady);
    assert(strcmp(config.server, RELAY_PROFILE_IPV4) == 0);
    assert(config.port == RELAY_PROFILE_PORT);
    assert(config.public_groups == public_groups);
}

int main(void)
{
    char directory[] = "/tmp/lanywhere-fixed-config-XXXXXX";
    assert(mkdtemp(directory));
    char path[96];
    snprintf(path, sizeof(path), "%s/config.ini", directory);

    assert_fixed(path, true);
    assert(access(path, F_OK) != 0);

    const char preferences[] = "public=0\napodo=Player\n";
    write_config(path, preferences, sizeof(preferences) - 1);
    assert_fixed(path, false);

    const char stale[] = "server=198.51.100.2\nport=65535\npublic=0\napodo=Player\n";
    write_config(path, stale, sizeof(stale) - 1);
    assert_fixed(path, false);
    assert(relay_config_save_public(path, true));
    assert_fixed(path, true);
    const char expected[] = "server=198.51.100.2\nport=65535\napodo=Player\npublic=1\n";
    char stored[sizeof(expected)];
    FILE *file = fopen(path, "rb");
    assert(file);
    assert(fread(stored, 1, sizeof(stored), file) == sizeof(expected) - 1);
    assert(!ferror(file));
    assert(fclose(file) == 0);
    assert(memcmp(stored, expected, sizeof(expected) - 1) == 0);

    const char invalid[] = "server=broken\nport=not-a-port\npublic=0\napodo=Player\n";
    write_config(path, invalid, sizeof(invalid) - 1);
    assert_fixed(path, false);

    const char corrupt[] = "public=0\n\0";
    write_config(path, corrupt, sizeof(corrupt) - 1);
    RelayConfig decoded;
    assert(relay_config_load(path, &decoded) == RelayConfigFileError);
    const char external[] = "apodo=Player\nnetwork=lanywhere-public\n";
    write_config(path, external, sizeof(external) - 1);
    assert(relay_config_load(path, &decoded) == RelayConfigReady && !strcmp(decoded.provider, "lanywhere-public"));
    assert(relay_config_save_provider(path, "lanplay-nl"));
    assert(relay_config_load(path, &decoded) == RelayConfigReady && !strcmp(decoded.provider, "lanplay-nl"));
    const char *new_networks[] = {"lanplay-cn-jax", "lanplay-cn-gugu", "lanplay-cn-olunira", "lanplay-cn-shanghai"};
    for (size_t i=0; i<sizeof(new_networks)/sizeof(new_networks[0]); i++) {
        assert(relay_config_save_provider(path, new_networks[i]));
        assert(relay_config_load(path, &decoded) == RelayConfigReady && !strcmp(decoded.provider, new_networks[i]));
        assert(relay_config_save_public(path, true));
        assert(relay_config_load(path, &decoded) == RelayConfigReady && !strcmp(decoded.provider, new_networks[i]));
    }
    assert(!relay_config_save_provider(path, "arbitrary-host"));
    const char duplicate[] = "network=lanplay-nl\nnetwork=self\n";
    write_config(path, duplicate, sizeof(duplicate)-1);
    assert(relay_config_load(path, &decoded) == RelayConfigInvalid);
    const char unknown[] = "network=unlisted\n";
    write_config(path, unknown, sizeof(unknown)-1);
    assert(relay_config_load(path, &decoded) == RelayConfigInvalid);
    char oversize[512];memset(oversize, 'a', sizeof(oversize));
    write_config(path, oversize, sizeof(oversize));
    assert(relay_config_load(path, &decoded) == RelayConfigFileError);

    assert(remove(path) == 0);
    assert(rmdir(directory) == 0);
    puts("LANywhere fixed relay config tests passed");
    return 0;
}
