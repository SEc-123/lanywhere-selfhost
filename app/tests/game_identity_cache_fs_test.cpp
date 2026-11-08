#include "../../console/ldn_mitm/source/game_identity_cache.cpp"
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>

static void write_cache(const char *path,uint64_t id,uint64_t lcid,uint64_t generation)
{
    GameCacheRecord r{};r.application_id=id;r.local_communication_ids[0]=lcid;
    std::strcpy(r.names.english,"Example Game");std::strcpy(r.names.chinese,"示例游戏");
    uint8_t head[GAME_CACHE_HEADER_SIZE],raw[GAME_CACHE_RECORD_SIZE];
    game_cache_header(head,1,generation);game_cache_encode_record(&r,raw);
    GameIdentitySha256 hash;gi_sha256_init(&hash);gi_sha256_update(&hash,head,32);gi_sha256_update(&hash,raw,sizeof(raw));gi_sha256_final(&hash,head+32);
    FILE *f=std::fopen(path,"wb");assert(f);assert(std::fwrite(head,1,sizeof(head),f)==sizeof(head));assert(std::fwrite(raw,1,sizeof(raw),f)==sizeof(raw));assert(!std::fclose(f));
}

int main() {
    char dir[]="/tmp/switch-cache-fs-XXXXXX";assert(mkdtemp(dir));assert(!setenv("SWITCH_IDENTITY_TEST_ROOT",dir,1));
    char path[512],previous[512];std::snprintf(path,sizeof(path),"%s/game-titles.bin",dir);std::snprintf(previous,sizeof(previous),"%s/game-titles.bin.previous",dir);
    write_cache(previous,0x101,0xdef,1);write_cache(path,0x202,0xabc,2);
    GameIdentity out{};
    using ams::mitm::lanywhere::GameIdentityCacheLookup;
    using ams::mitm::lanywhere::GameIdentityCacheFingerprint;
    uint8_t current[32], fingerprint[32];
    assert(GameIdentityCacheFingerprint(current));
    assert(GameIdentityCacheLookup(0x202,0xabc,&out)==GameCacheFound && out.application_id==0x202);
    /* Valid primary with no match must not consult a stale previous generation. */
    assert(GameIdentityCacheLookup(0x101,0xdef,&out)==GameCacheUnknown && !out.application_id);
    FILE *f=std::fopen(path,"r+b");assert(f);assert(!std::fseek(f,100,SEEK_SET));int b=std::fgetc(f);assert(b!=EOF);assert(!std::fseek(f,100,SEEK_SET));std::fputc(b^1,f);std::fclose(f);
    /* Header-only hint deliberately cannot detect a payload-only modification. */
    assert(GameIdentityCacheFingerprint(fingerprint) && !std::memcmp(current,fingerprint,32));
    assert(GameIdentityCacheLookup(0x101,0xdef,&out)==GameCacheFound && out.application_id==0x101);
    assert(!unlink(path));assert(GameIdentityCacheLookup(0x101,0xdef,&out)==GameCacheFound && out.application_id==0x101);
    assert(GameIdentityCacheFingerprint(fingerprint) && std::memcmp(current,fingerprint,32));
    assert(!unlink(previous));assert(!GameIdentityCacheFingerprint(fingerprint));
    assert(GameIdentityCacheLookup(0x101,0xabc,&out)==GameCacheInvalid && !out.application_id);
    assert(!rmdir(dir));std::puts("Module cache: validated primary, corruption/missing fallback passed");
}
