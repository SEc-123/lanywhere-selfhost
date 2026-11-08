#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include "relay_config.h"

#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void write_text(const char *path, const char *text)
{
    FILE *file = fopen(path, "wb");
    assert(file);
    assert(fputs(text, file) >= 0);
    assert(fclose(file) == 0);
}

static void assert_contents(const char *path, const char *expected)
{
    char text[1024];
    FILE *file = fopen(path, "rb");
    assert(file);
    const size_t length = fread(text, 1, sizeof(text), file);
    assert(!ferror(file));
    assert(fclose(file) == 0);
    assert(length == strlen(expected));
    assert(memcmp(text, expected, length) == 0);
}

int main(void)
{
    char directory[] = "/tmp/lanywhere-config-XXXXXX";
    assert(mkdtemp(directory));
    char path[96], backup[96];
    snprintf(path, sizeof(path), "%s/config.ini", directory);
    snprintf(backup, sizeof(backup), "%s/config.ini.bak", directory);

    assert(relay_config_ipv4_valid("203.0.113.10"));
    assert(!relay_config_ipv4_valid("0.0.0.0"));
    assert(!relay_config_ipv4_valid("255.255.255.255"));
    assert(!relay_config_ipv4_valid("203.0.011.10"));
    assert(!relay_config_ipv4_valid("203.0.113"));
    assert(!relay_config_ipv4_valid("203.0.113.256"));
    assert(!relay_config_ipv4_valid("203.0.113.10:1"));
    uint16_t port;
    assert(relay_config_parse_port("65535", &port) && port == 65535);
    assert(relay_config_parse_port("1", &port) && port == 1);
    assert(!relay_config_parse_port("0", &port));
    assert(!relay_config_parse_port("65536", &port));
    assert(!relay_config_parse_port("11460x", &port));

    RelayConfig config;
    assert(relay_config_load(path, &config) == RelayConfigNotSet);
    assert(config.port == RELAY_DEFAULT_PORT && config.public_groups);
    assert(relay_config_save_endpoint(path, "203.0.113.10", 11460));
    assert_contents(path, "server=203.0.113.10\nport=11460\n");

    write_text(path, "# keep me\r\npublic=0\r\napodo=Jugadór\r\nserver=old\rport=broken\rserver=198.51.100.2\r\nother=keep");
    assert(relay_config_load(path, &config) == RelayConfigInvalid);
    assert(!config.public_groups);
    assert(relay_config_save_endpoint(path, "192.0.2.10", 65535));
    assert_contents(path, "# keep me\r\npublic=0\r\napodo=Jugadór\r\nother=keep\nserver=192.0.2.10\nport=65535\n");
    assert(relay_config_load(path, &config) == RelayConfigReady);
    assert(strcmp(config.server, "192.0.2.10") == 0 && config.port == 65535 && !config.public_groups);

    assert(relay_config_save_public(path, true));
    assert(relay_config_save_nickname(path, "New Nick"));
    assert(!relay_config_save_nickname(path, "New\nserver=192.0.2.9"));
    assert_contents(path, "# keep me\r\nother=keep\nserver=192.0.2.10\nport=65535\npublic=1\napodo=New Nick\n");
    assert(rename(path, backup) == 0);
    assert(relay_config_load(path, &config) == RelayConfigReady);
    assert(access(backup, F_OK) != 0);

    write_text(path, "server=198.51.100.2\n");
    assert(relay_config_load(path, &config) == RelayConfigReady && config.port == RELAY_DEFAULT_PORT);
    char large[520];
    memset(large, 'a', sizeof(large) - 1);
    large[sizeof(large) - 1] = '\0';
    write_text(path, large);
    assert(relay_config_load(path, &config) == RelayConfigFileError);
    assert(!relay_config_save_endpoint(path, "192.0.2.10", 11460));
    assert_contents(path, large);

    assert(remove(path) == 0);
    assert(rmdir(directory) == 0);
    puts("LANywhere relay config tests passed");
    return 0;
}
