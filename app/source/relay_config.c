#define _POSIX_C_SOURCE 200809L
#include "relay_config.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

// Keep the file within the size the sysmodule reads.
#define CONFIG_LIMIT 511
#define PATH_CAPACITY 512

enum ConfigField { Server, Port, Public, Nickname, Provider, FieldCount };
static const char *const keys[] = { "server=", "port=", "public=", "apodo=", "network=" };

static bool provider_valid(const char *value)
{
    return value && (!strcmp(value, "self") || !strcmp(value, "lanywhere-public") ||
        !strcmp(value, "lanplay-nl") || !strcmp(value, "lanplay-br") || !strcmp(value, "lanplay-id") ||
        !strcmp(value, "lanplay-nl-jaysea-rust") || !strcmp(value, "lanplay-nl-r3ps4j-rust") || !strcmp(value, "lanplay-nl-r3ps4j-11452") || !strcmp(value, "lanplay-de-servegame") ||
        !strcmp(value, "lanplay-cn-jax") || !strcmp(value, "lanplay-cn-gugu") ||
        !strcmp(value, "lanplay-cn-olunira") || !strcmp(value, "lanplay-cn-shanghai"));
}

bool relay_config_ipv4_valid(const char *server)
{
    if (!*server || strlen(server) >= RELAY_IPV4_SIZE)
        return false;
    unsigned address = 0;
    const char *p = server;
    for (int part = 0; part < 4; part++) {
        if (*p < '0' || *p > '9' || (*p == '0' && p[1] >= '0' && p[1] <= '9'))
            return false;
        unsigned octet = 0;
        while (*p >= '0' && *p <= '9') {
            octet = octet * 10 + (unsigned)(*p++ - '0');
            if (octet > 255)
                return false;
        }
        if (*p != (part < 3 ? '.' : '\0'))
            return false;
        if (part < 3)
            p++;
        address = (address << 8) | octet;
    }
    return address != 0 && address != UINT32_MAX;
}

bool relay_config_parse_port(const char *text, uint16_t *port)
{
    if (!*text)
        return false;
    unsigned value = 0;
    for (; *text; text++) {
        if (*text < '0' || *text > '9')
            return false;
        value = value * 10 + (unsigned)(*text - '0');
        if (value > UINT16_MAX)
            return false;
    }
    if (value == 0)
        return false;
    *port = (uint16_t)value;
    return true;
}

static bool sibling_path(char *out, const char *path, const char *suffix)
{
    int size = snprintf(out, PATH_CAPACITY, "%s%s", path, suffix);
    return size > 0 && size < PATH_CAPACITY;
}

static RelayConfigState read_file(const char *path, char *text, size_t *length)
{
    FILE *file = fopen(path, "rb");
    if (!file && errno == ENOENT) {
        // A power loss can interrupt the two renames needed on Switch's SD filesystem.
        char backup[PATH_CAPACITY];
        if (!sibling_path(backup, path, ".bak"))
            return RelayConfigFileError;
        if (rename(backup, path) == 0)
            file = fopen(path, "rb");
        else if (errno == ENOENT) {
            *length = 0;
            return RelayConfigNotSet;
        }
    }
    if (!file)
        return RelayConfigFileError;

    *length = fread(text, 1, CONFIG_LIMIT + 1, file);
    const bool read_ok = !ferror(file);
    const int close_result = fclose(file);
    if (!read_ok || close_result != 0 || *length > CONFIG_LIMIT || memchr(text, '\0', *length))
        return RelayConfigFileError;
    return RelayConfigReady;
}

static enum ConfigField config_field(const char *line, size_t length)
{
    for (enum ConfigField key = Server; key < FieldCount; key++) {
        size_t key_length = strlen(keys[key]);
        if (length >= key_length && memcmp(line, keys[key], key_length) == 0)
            return key;
    }
    return FieldCount;
}

RelayConfigState relay_config_load(const char *path, RelayConfig *config)
{
#if RELAY_PROFILE_FIXED
    *config = (RelayConfig){ .server = RELAY_PROFILE_IPV4, .port = RELAY_PROFILE_PORT, .public_groups = true, .provider = "self" };
#else
    *config = (RelayConfig){ .port = RELAY_DEFAULT_PORT, .public_groups = true, .provider = "self" };
#endif
    char text[CONFIG_LIMIT + 1];
    size_t length;
    RelayConfigState state = read_file(path, text, &length);
    if (state == RelayConfigNotSet)
        return RELAY_PROFILE_FIXED ? RelayConfigReady : state;
    if (state != RelayConfigReady)
        return state;
    text[length] = '\0';

    bool server_seen = false;
    bool port_valid = true;
    bool provider_seen = false;
    for (char *line = strtok(text, "\r\n"); line; line = strtok(NULL, "\r\n")) {
        enum ConfigField key = config_field(line, strlen(line));
        if (key == FieldCount)
            continue;
        const char *value = line + strlen(keys[key]);
        if (!RELAY_PROFILE_FIXED && key == Server) {
            server_seen = true;
            config->server[0] = '\0';
            if (relay_config_ipv4_valid(value))
                memcpy(config->server, value, strlen(value) + 1);
        } else if (!RELAY_PROFILE_FIXED && key == Port) {
            port_valid = relay_config_parse_port(value, &config->port);
            if (!port_valid)
                config->port = RELAY_DEFAULT_PORT;
        } else if (key == Public) {
            config->public_groups = value[0] != '0';
        } else if (key == Provider) {
            if (provider_seen || !provider_valid(value)) return RelayConfigInvalid;
            provider_seen = true;
            memcpy(config->provider, value, strlen(value) + 1);
        }
    }
    if (RELAY_PROFILE_FIXED)
        return RelayConfigReady;
    if (!server_seen)
        return RelayConfigNotSet;
    return config->server[0] && port_valid ? RelayConfigReady : RelayConfigInvalid;
}

static bool append(char *text, size_t *length, const char *value, size_t count)
{
    if (count > CONFIG_LIMIT - *length)
        return false;
    memcpy(text + *length, value, count);
    *length += count;
    return true;
}

static bool replace_file(const char *path, const char *text, size_t length)
{
    char temp[PATH_CAPACITY], backup[PATH_CAPACITY];
    if (!sibling_path(temp, path, ".tmp") || !sibling_path(backup, path, ".bak"))
        return false;

    FILE *file = fopen(temp, "wb");
    if (!file)
        return false;
    bool written = fwrite(text, 1, length, file) == length && fflush(file) == 0 && fsync(fileno(file)) == 0;
    if (fclose(file) != 0)
        written = false;
    if (written && rename(temp, path) == 0) {
        remove(backup);
        return true;
    }
    if (written && errno == EEXIST && (remove(backup) == 0 || errno == ENOENT) && rename(path, backup) == 0) {
        if (rename(temp, path) == 0) {
            remove(backup);
            return true;
        }
        rename(backup, path);
    }
    remove(temp);
    return false;
}

static bool save_fields(const char *path, const char *const values[FieldCount])
{
    char old[CONFIG_LIMIT + 1], output[CONFIG_LIMIT];
    size_t old_length, out_length = 0;
    RelayConfigState state = read_file(path, old, &old_length);
    if (state == RelayConfigFileError)
        return false;

    for (size_t offset = 0; offset < old_length; ) {
        const char *line = old + offset;
        size_t count = 0;
        while (offset + count < old_length && line[count] != '\r' && line[count] != '\n')
            count++;
        if (offset + count < old_length) {
            const char delimiter = line[count++];
            if (delimiter == '\r' && offset + count < old_length && line[count] == '\n')
                count++;
        }
        enum ConfigField key = config_field(line, count);
        if ((key == FieldCount || !values[key]) && !append(output, &out_length, line, count))
            return false;
        offset += count;
    }
    if (out_length && output[out_length - 1] != '\n' && !append(output, &out_length, "\n", 1))
        return false;

    for (enum ConfigField key = Server; key < FieldCount; key++) {
        const char *value = values[key];
        if (value && (!append(output, &out_length, keys[key], strlen(keys[key])) ||
                      !append(output, &out_length, value, strlen(value)) || !append(output, &out_length, "\n", 1)))
            return false;
    }
    return replace_file(path, output, out_length);
}

bool relay_config_save_endpoint(const char *path, const char *server, uint16_t port)
{
    if (!relay_config_ipv4_valid(server) || port == 0)
        return false;
    char port_text[6];
    snprintf(port_text, sizeof(port_text), "%u", (unsigned)port);
    return save_fields(path, (const char *const [FieldCount]){ [Server] = server, [Port] = port_text });
}

bool relay_config_save_public(const char *path, bool public_groups)
{
    return save_fields(path, (const char *const [FieldCount]){ [Public] = public_groups ? "1" : "0" });
}

bool relay_config_save_nickname(const char *path, const char *nickname)
{
    if (strpbrk(nickname, "\r\n"))
        return false;
    return save_fields(path, (const char *const [FieldCount]){ [Nickname] = nickname });
}

bool relay_config_save_provider(const char *path, const char *provider)
{
    if (!provider_valid(provider)) return false;
    return save_fields(path, (const char *const [FieldCount]){ [Provider] = provider });
}
