#define _DARWIN_C_SOURCE
#define _POSIX_C_SOURCE 200809L
#include "../source/title_inventory.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct { bool fail_list,fail_second,skip_second,nolcid_first; unsigned generation; } Fake;
static bool list(void *ctx,uint32_t offset,uint64_t *ids,size_t cap,size_t *count)
{
    Fake *f=ctx;if(f->fail_list)return false;assert(cap>=2);
    if(offset){*count=0;return true;}ids[0]=0x101;ids[1]=0x202;*count=2;return true;
}
static TitleInventoryLoad load(void *ctx,uint64_t id,GameCacheRecord *out)
{
    Fake *f=ctx;if(id==0x202 && f->fail_second)return TitleLoadFailed;
    if(id==0x202 && f->skip_second)return TitleLoadSkip;
    memset(out,0,sizeof(*out));out->application_id=id;
    if (!(id==0x101 && f->nolcid_first)) {
        out->local_communication_ids[0]=0xabc;out->local_communication_ids[1]=id==0x101?0x111:0x222;
    }
    snprintf(out->names.english,sizeof(out->names.english),id==0x101?(f->generation?"Host A2":"Host A"):"Host B");
    snprintf(out->names.chinese,sizeof(out->names.chinese),id==0x101?(f->generation?"游戏甲二":"游戏甲"):"游戏乙");
    return TitleLoadFound;
}
static bool list_many(void *ctx,uint32_t offset,uint64_t *ids,size_t cap,size_t *count)
{
    const bool fail_second_page=*(bool *)ctx;
    if(fail_second_page && offset>=32)return false;
    size_t remain=offset<65?65-offset:0;*count=remain<cap?remain:cap;
    for(size_t i=0;i<*count;i++)ids[i]=0x1000+offset+i;
    return true;
}
static TitleInventoryLoad load_many(void *ctx,uint64_t id,GameCacheRecord *out)
{
    (void)ctx;memset(out,0,sizeof(*out));out->application_id=id;out->local_communication_ids[0]=id+0x1000;
    snprintf(out->names.english,sizeof(out->names.english),"Game %llx",(unsigned long long)id);
    snprintf(out->names.chinese,sizeof(out->names.chinese),"游戏 %llx",(unsigned long long)id);
    return TitleLoadFound;
}
static bool read_at(void *ctx,uint64_t off,void *out,size_t n)
{
    FILE *f=ctx;return fseek(f,(long)off,SEEK_SET)==0 && fread(out,1,n,f)==n;
}
static GameCacheResult lookup(const char *path,uint64_t program,uint64_t lcid,GameIdentity *out,uint64_t *gen)
{
    FILE *f=fopen(path,"rb");assert(f);assert(fseek(f,0,SEEK_END)==0);long size=ftell(f);assert(size>=0);
    GameCacheResult result=game_cache_lookup(read_at,f,(uint64_t)size,program,lcid,out,gen);fclose(f);return result;
}
static void sha_test(void)
{
    static const uint8_t expected[32]={0xba,0x78,0x16,0xbf,0x8f,0x01,0xcf,0xea,0x41,0x41,0x40,0xde,0x5d,0xae,0x22,0x23,
        0xb0,0x03,0x61,0xa3,0x96,0x17,0x7a,0x9c,0xb4,0x10,0xff,0x61,0xf2,0x00,0x15,0xad};
    uint8_t result[32];GameIdentitySha256 s;gi_sha256_init(&s);gi_sha256_update(&s,"a",1);gi_sha256_update(&s,"bc",2);gi_sha256_final(&s,result);
    assert(memcmp(expected,result,sizeof(result))==0);
    static const uint8_t million_a[32]={0xcd,0xc7,0x6e,0x5c,0x99,0x14,0xfb,0x92,0x81,0xa1,0xc7,0xe2,0x84,0xd7,0x3e,0x67,
        0xf1,0x80,0x9a,0x48,0xa4,0x97,0x20,0x0e,0x04,0x6d,0x39,0xcc,0xc7,0x11,0x2c,0xd0};
    char chunk[1000];memset(chunk,'a',sizeof(chunk));gi_sha256_init(&s);
    for(int i=0;i<1000;i++)gi_sha256_update(&s,chunk,sizeof(chunk));
    gi_sha256_final(&s,result);assert(memcmp(million_a,result,sizeof(result))==0);
}
static void resign(FILE *f)
{
    uint8_t head[GAME_CACHE_HEADER_SIZE],raw[GAME_CACHE_RECORD_SIZE];
    assert(fseek(f,0,SEEK_SET)==0 && fread(head,1,sizeof(head),f)==sizeof(head));
    GameIdentitySha256 hash;gi_sha256_init(&hash);gi_sha256_update(&hash,head,32);
    for(uint32_t i=0;i<gi_get32(head+20);i++) {
        assert(fread(raw,1,sizeof(raw),f)==sizeof(raw));gi_sha256_update(&hash,raw,sizeof(raw));
    }
    gi_sha256_final(&hash,head+32);
    assert(fseek(f,0,SEEK_SET)==0 && fwrite(head,1,sizeof(head),f)==sizeof(head) && fflush(f)==0);
}
int main(void)
{
    sha_test();char dir[]="/tmp/switch-inventory-XXXXXX";assert(mkdtemp(dir));
    char path[512],previous[512],tmp[512];snprintf(path,sizeof(path),"%s/cache.bin",dir);
    snprintf(previous,sizeof(previous),"%s/cache.bin.previous",dir);snprintf(tmp,sizeof(tmp),"%s/cache.bin.tmp",dir);
    Fake fake={0};TitleInventoryBackend backend={&fake,list,load};GameIdentity out;uint64_t generation=0;
    assert(title_inventory_refresh_at(path,&backend));
    assert(lookup(path,0x101,0xabc,&out,&generation)==GameCacheFound && generation==1 && out.application_id==0x101 && !strcmp(out.english,"Host A"));
    assert(lookup(path,0x999,0xabc,&out,NULL)==GameCacheAmbiguous && out.application_id==0);
    assert(lookup(path,0x999,0x222,&out,NULL)==GameCacheFound && out.application_id==0x202);
    assert(lookup(path,0x101,0x222,&out,NULL)==GameCacheFound && out.application_id==0x101);
    assert(lookup(path,0x999,0x777,&out,NULL)==GameCacheUnknown && out.application_id==0);
    fake.generation=1;fake.fail_second=true;
    assert(title_inventory_refresh_at(path,&backend));
    assert(lookup(path,0x101,0x111,&out,&generation)==GameCacheFound && generation==2 && !strcmp(out.english,"Host A2"));
    assert(lookup(path,0x202,0x222,&out,NULL)==GameCacheFound && !strcmp(out.english,"Host B"));
    assert(lookup(previous,0x101,0x111,&out,&generation)==GameCacheFound && generation==1);
    fake.fail_list=true;assert(!title_inventory_refresh_at(path,&backend));
    assert(access(tmp,F_OK)!=0 && lookup(path,0x101,0x111,&out,&generation)==GameCacheFound && generation==2);
    FILE *f=fopen(path,"r+b");assert(f);assert(fseek(f,100,SEEK_SET)==0);int b=fgetc(f);assert(b!=EOF);assert(fseek(f,100,SEEK_SET)==0);fputc(b^1,f);fclose(f);
    assert(lookup(path,0x101,0x111,&out,NULL)==GameCacheInvalid);
    fake.fail_list=false;assert(title_inventory_refresh_at(path,&backend));
    assert(lookup(path,0x202,0x222,&out,NULL)==GameCacheFound && !strcmp(out.english,"Host B"));
    assert(lookup(previous,0x101,0x111,&out,NULL)==GameCacheFound);
    assert(unlink(path)==0);fake.fail_list=true;
    assert(!title_inventory_refresh_at(path,&backend));
    assert(access(path,F_OK)!=0 && lookup(previous,0x202,0x222,&out,NULL)==GameCacheFound);
    fake.fail_list=false;fake.fail_second=false;fake.skip_second=true;
    assert(title_inventory_refresh_at(path,&backend));
    assert(lookup(path,0x202,0x222,&out,NULL)==GameCacheUnknown);
    /* Even a rehashed cache with injected bidi controls must be rejected. */
    f=fopen(path,"r+b");assert(f);assert(fseek(f,GAME_CACHE_HEADER_SIZE+72,SEEK_SET)==0);
    const unsigned char bidi[]={0xe2,0x80,0xae};assert(fwrite(bidi,1,sizeof(bidi),f)==sizeof(bidi));resign(f);fclose(f);
    assert(lookup(path,0x101,0x111,&out,NULL)==GameCacheInvalid);
    unlink(path);unlink(previous);
    bool fail_page=false;TitleInventoryBackend many={&fail_page,list_many,load_many};
    assert(title_inventory_refresh_at(path,&many));
    assert(lookup(path,0x1040,0x2040,&out,&generation)==GameCacheFound && generation==1 && out.application_id==0x1040);
    fail_page=true;assert(!title_inventory_refresh_at(path,&many));
    assert(lookup(path,0x1040,0x2040,&out,&generation)==GameCacheFound && generation==1);
    unlink(path);
    Fake no_lcid={0};no_lcid.nolcid_first=true;TitleInventoryBackend no_lcid_backend={&no_lcid,list,load};
    assert(title_inventory_refresh_at(path,&no_lcid_backend));
    assert(lookup(path,0x101,0,&out,NULL)==GameCacheFound && out.application_id==0x101 && !strcmp(out.english,"Host A"));
    assert(lookup(path,0x999,0x111,&out,NULL)==GameCacheUnknown && !out.application_id);
    unlink(path);rmdir(dir);
    puts("Title inventory: SHA, dual IDs, ambiguity, failure preservation and recovery passed");
}
