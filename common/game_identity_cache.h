#pragma once
#include "game_identity_text.h"
#include "game_identity_sha256.h"

/* v1, little endian: 64-byte header, then fixed 328-byte records.
 * SHA-256 covers header[0..31] followed by all records. It detects corruption,
 * not malicious edits; data on SD and metadata from peers are not authenticated. */
#define GAME_CACHE_HEADER_SIZE 64u
#define GAME_CACHE_RECORD_SIZE 328u
#define GAME_CACHE_MAX_RECORDS 4096u
#define GAME_CACHE_LCID_COUNT 8u
#define GAME_CACHE_PATH "sdmc:/lanywhere/game-titles.bin"
#define GAME_CACHE_PREVIOUS_PATH "sdmc:/lanywhere/game-titles.bin.previous"

typedef struct {
    uint64_t program_id, application_id;
    char english[GAME_IDENTITY_TITLE_CAP], chinese[GAME_IDENTITY_TITLE_CAP];
} GameIdentity;

typedef struct {
    uint64_t application_id, local_communication_ids[GAME_CACHE_LCID_COUNT];
    GameIdentityNames names;
} GameCacheRecord;

typedef enum { GameCacheInvalid = -1, GameCacheUnknown = 0, GameCacheFound = 1, GameCacheAmbiguous = 2 } GameCacheResult;
typedef bool (*GameCacheRead)(void *ctx, uint64_t offset, void *data, size_t size);

static inline uint32_t gi_get32(const uint8_t *p) { return (uint32_t)p[0]|((uint32_t)p[1]<<8)|((uint32_t)p[2]<<16)|((uint32_t)p[3]<<24); }
static inline uint64_t gi_get64(const uint8_t *p) { return gi_get32(p)|((uint64_t)gi_get32(p+4)<<32); }
static inline void gi_put32(uint8_t *p,uint32_t v) { for(unsigned i=0;i<4;i++)p[i]=(uint8_t)(v>>(8*i)); }
static inline void gi_put64(uint8_t *p,uint64_t v) { for(unsigned i=0;i<8;i++)p[i]=(uint8_t)(v>>(8*i)); }

static inline bool game_cache_name_valid(const char name[GAME_IDENTITY_TITLE_CAP])
{
    size_t n=0;while(n<GAME_IDENTITY_TITLE_CAP && name[n])n++;
    if(!n || n==GAME_IDENTITY_TITLE_CAP)return false;
    for(size_t i=n+1;i<GAME_IDENTITY_TITLE_CAP;i++)if(name[i])return false;
    char clean[GAME_IDENTITY_TITLE_CAP];
    return game_identity_safe_title((const uint8_t *)name,n,clean,sizeof(clean)) && strcmp(name,clean)==0;
}

static inline bool game_cache_record_valid(const GameCacheRecord *r)
{
    if(!r || !r->application_id || !game_cache_name_valid(r->names.english) || !game_cache_name_valid(r->names.chinese))return false;
    return true; /* An NS application may have no LCIDs; exact ProgramID still identifies it. */
}

static inline void game_cache_encode_record(const GameCacheRecord *r,uint8_t out[GAME_CACHE_RECORD_SIZE])
{
    gi_put64(out,r->application_id);
    for(size_t i=0;i<GAME_CACHE_LCID_COUNT;i++)gi_put64(out+8+8*i,r->local_communication_ids[i]);
    memcpy(out+72,r->names.english,GAME_IDENTITY_TITLE_CAP);memcpy(out+200,r->names.chinese,GAME_IDENTITY_TITLE_CAP);
}
static inline bool game_cache_decode_record(const uint8_t in[GAME_CACHE_RECORD_SIZE],GameCacheRecord *r)
{
    r->application_id=gi_get64(in);
    for(size_t i=0;i<GAME_CACHE_LCID_COUNT;i++)r->local_communication_ids[i]=gi_get64(in+8+8*i);
    memcpy(r->names.english,in+72,GAME_IDENTITY_TITLE_CAP);memcpy(r->names.chinese,in+200,GAME_IDENTITY_TITLE_CAP);
    return game_cache_record_valid(r);
}
static inline void game_cache_header(uint8_t out[GAME_CACHE_HEADER_SIZE],uint32_t count,uint64_t generation)
{
    memset(out,0,GAME_CACHE_HEADER_SIZE);memcpy(out,"LNYID01",7);gi_put32(out+8,1);gi_put32(out+12,GAME_CACHE_HEADER_SIZE);
    gi_put32(out+16,GAME_CACHE_RECORD_SIZE);gi_put32(out+20,count);gi_put64(out+24,generation);
}

/* Validates the entire file before returning a match. An exact trusted caller
 * ProgramID / NS application ID wins even without LCID; otherwise LCID must map
 * to a single unambiguous application record.
 * A matching cache record is evidence from a local cache, never an attestation. */
static inline GameCacheResult game_cache_lookup(GameCacheRead read,void *ctx,uint64_t bytes,
                                                 uint64_t program_id,uint64_t lcid,GameIdentity *out,
                                                 uint64_t *generation)
{
    if(!read || !out)return GameCacheInvalid;
    memset(out,0,sizeof(*out));out->program_id=program_id;
    uint8_t head[GAME_CACHE_HEADER_SIZE],raw[GAME_CACHE_RECORD_SIZE],digest[32];
    if(bytes<GAME_CACHE_HEADER_SIZE || !read(ctx,0,head,sizeof(head)) || memcmp(head,"LNYID01\0",8) ||
       gi_get32(head+8)!=1 || gi_get32(head+12)!=GAME_CACHE_HEADER_SIZE || gi_get32(head+16)!=GAME_CACHE_RECORD_SIZE)return GameCacheInvalid;
    const uint32_t count=gi_get32(head+20);
    if(count>GAME_CACHE_MAX_RECORDS || bytes!=GAME_CACHE_HEADER_SIZE+(uint64_t)count*GAME_CACHE_RECORD_SIZE)return GameCacheInvalid;
    GameIdentitySha256 hash;gi_sha256_init(&hash);gi_sha256_update(&hash,head,32);
    GameCacheRecord exact,unique;memset(&exact,0,sizeof(exact));memset(&unique,0,sizeof(unique));
    bool have_exact=false,have_unique=false,ambiguous_exact=false,ambiguous_unique=false;
    for(uint32_t n=0;n<count;n++) {
        if(!read(ctx,GAME_CACHE_HEADER_SIZE+(uint64_t)n*GAME_CACHE_RECORD_SIZE,raw,sizeof(raw)))return GameCacheInvalid;
        gi_sha256_update(&hash,raw,sizeof(raw));GameCacheRecord r;
        if(!game_cache_decode_record(raw,&r))return GameCacheInvalid;
        if(program_id && r.application_id==program_id) {
            if(!have_exact){exact=r;have_exact=true;}
            else if(memcmp(&exact.names,&r.names,sizeof(r.names)))ambiguous_exact=true;
        }
        bool matches=false;for(size_t i=0;i<GAME_CACHE_LCID_COUNT;i++)if(lcid && lcid!=UINT64_MAX && r.local_communication_ids[i]==lcid)matches=true;
        if(!matches)continue;
        if(!have_unique){unique=r;have_unique=true;}
        else if(unique.application_id!=r.application_id || memcmp(&unique.names,&r.names,sizeof(r.names)))ambiguous_unique=true;
    }
    gi_sha256_final(&hash,digest);if(memcmp(digest,head+32,32))return GameCacheInvalid;
    if(generation)*generation=gi_get64(head+24);
    if((have_exact && ambiguous_exact) || (!have_exact && have_unique && ambiguous_unique))return GameCacheAmbiguous;
    const GameCacheRecord *chosen=have_exact?&exact:have_unique?&unique:NULL;
    if(!chosen)return GameCacheUnknown;
    out->application_id=chosen->application_id;memcpy(out->english,chosen->names.english,sizeof(out->english));memcpy(out->chinese,chosen->names.chinese,sizeof(out->chinese));
    return GameCacheFound;
}

/* Used only to preserve a prior valid record when an individual NS read fails.
 * The entire old cache and every record are checked before returning it. */
static inline GameCacheResult game_cache_get_record(GameCacheRead read,void *ctx,uint64_t bytes,
                                                     uint64_t application_id,GameCacheRecord *out,
                                                     uint64_t *generation)
{
    if(!read || !out || !application_id)return GameCacheInvalid;
    memset(out,0,sizeof(*out));uint8_t head[GAME_CACHE_HEADER_SIZE],raw[GAME_CACHE_RECORD_SIZE],saved[GAME_CACHE_RECORD_SIZE],digest[32];
    if(bytes<GAME_CACHE_HEADER_SIZE || !read(ctx,0,head,sizeof(head)) || memcmp(head,"LNYID01\0",8) ||
       gi_get32(head+8)!=1 || gi_get32(head+12)!=GAME_CACHE_HEADER_SIZE || gi_get32(head+16)!=GAME_CACHE_RECORD_SIZE)return GameCacheInvalid;
    const uint32_t count=gi_get32(head+20);
    if(count>GAME_CACHE_MAX_RECORDS || bytes!=GAME_CACHE_HEADER_SIZE+(uint64_t)count*GAME_CACHE_RECORD_SIZE)return GameCacheInvalid;
    GameIdentitySha256 hash;gi_sha256_init(&hash);gi_sha256_update(&hash,head,32);bool found=false,ambiguous=false;
    for(uint32_t n=0;n<count;n++) {
        if(!read(ctx,GAME_CACHE_HEADER_SIZE+(uint64_t)n*GAME_CACHE_RECORD_SIZE,raw,sizeof(raw)))return GameCacheInvalid;
        gi_sha256_update(&hash,raw,sizeof(raw));GameCacheRecord rec;
        if(!game_cache_decode_record(raw,&rec))return GameCacheInvalid;
        if(rec.application_id==application_id) {
            if(!found){memcpy(saved,raw,sizeof(saved));found=true;}
            else if(memcmp(saved,raw,sizeof(saved)))ambiguous=true;
        }
    }
    gi_sha256_final(&hash,digest);if(memcmp(digest,head+32,32))return GameCacheInvalid;
    if(generation)*generation=gi_get64(head+24);
    if(ambiguous)return GameCacheAmbiguous;
    if(!found)return GameCacheUnknown;
    return game_cache_decode_record(saved,out)?GameCacheFound:GameCacheInvalid;
}

#if defined(__cplusplus)
static_assert(sizeof(GameIdentity)==272,"GameIdentity IPC size");
#else
_Static_assert(sizeof(GameIdentity)==272,"GameIdentity IPC size");
#endif
