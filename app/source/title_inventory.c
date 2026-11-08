#define _POSIX_C_SOURCE 200809L
#include "title_inventory.h"
#include "nacp_titles.h"
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

enum { InventoryPathMax=512, InventoryPage=32 };

static bool read_at(void *ctx, uint64_t offset, void *out, size_t size)
{
    FILE *f=(FILE *)ctx;
    return offset <= 0x7fffffff && fseek(f,(long)offset,SEEK_SET)==0 && fread(out,1,size,f)==size;
}

static GameCacheResult open_valid(const char *path, FILE **file, uint64_t *bytes, uint64_t *generation)
{
    *file=fopen(path,"rb");
    if(!*file)return GameCacheInvalid;
    struct stat st;
    if(fstat(fileno(*file),&st)!=0 || !S_ISREG(st.st_mode) || st.st_size<0) { fclose(*file);*file=NULL;return GameCacheInvalid; }
    *bytes=(uint64_t)st.st_size;
    GameIdentity dummy;
    GameCacheResult result=game_cache_lookup(read_at,*file,*bytes,0,0,&dummy,generation);
    if(result!=GameCacheUnknown){fclose(*file);*file=NULL;return GameCacheInvalid;}
    return result;
}

static bool sibling(char out[InventoryPathMax],const char *path,const char *suffix)
{
    if(!path || !*path)return false;
    int n=snprintf(out,InventoryPathMax,"%s%s",path,suffix);
    return n>0 && n<InventoryPathMax;
}

bool title_inventory_refresh_at(const char *path,const TitleInventoryBackend *backend)
{
    char tmp[InventoryPathMax],previous[InventoryPathMax];
    if(!backend || !backend->list || !backend->load || !sibling(tmp,path,".tmp") || !sibling(previous,path,".previous"))return false;
    FILE *old=NULL,*primary=NULL,*prior=NULL;uint64_t old_bytes=0,old_generation=0,ignored_bytes=0,ignored_gen=0;
    bool primary_valid=open_valid(path,&primary,&old_bytes,&old_generation)==GameCacheUnknown;
    if(primary_valid)old=primary;
    else {
        if(open_valid(previous,&prior,&old_bytes,&old_generation)==GameCacheUnknown)old=prior;
        else {old_bytes=old_generation=0;}
    }
    if(old_generation==UINT64_MAX){if(old)fclose(old);return false;}
    FILE *f=fopen(tmp,"w+b");
    if(!f){if(old)fclose(old);return false;}
    uint8_t raw[GAME_CACHE_RECORD_SIZE],head[GAME_CACHE_HEADER_SIZE]={0};
    bool ok=fwrite(head,1,sizeof(head),f)==sizeof(head);
    uint64_t *seen=(uint64_t *)calloc(GAME_CACHE_MAX_RECORDS,sizeof(*seen));
    if(!seen)ok=false;
    uint32_t count=0,offset=0,seen_count=0;
    while(ok) {
        uint64_t ids[InventoryPage]={0};size_t n=0;
        if(!backend->list(backend->context,offset,ids,InventoryPage,&n) || n>InventoryPage || offset>UINT32_MAX-n){ok=false;break;}
        for(size_t i=0;i<n && ok;i++) {
            if(!ids[i] || seen_count>=GAME_CACHE_MAX_RECORDS){ok=false;break;}
            for(uint32_t j=0;j<seen_count;j++)if(seen[j]==ids[i]){ok=false;break;}
            if(!ok)break;
            seen[seen_count++]=ids[i];
            GameCacheRecord rec={0};
            TitleInventoryLoad status=backend->load(backend->context,ids[i],&rec);
            if(status!=TitleLoadFailed && status!=TitleLoadFound && status!=TitleLoadSkip){ok=false;break;}
            bool loaded=status==TitleLoadFound && rec.application_id==ids[i] && game_cache_record_valid(&rec);
            if(status==TitleLoadFound && !loaded){ok=false;break;}
            if(status==TitleLoadFailed && old)loaded=game_cache_get_record(read_at,old,old_bytes,ids[i],&rec,NULL)==GameCacheFound;
            if(!loaded)continue;
            if(count>=GAME_CACHE_MAX_RECORDS){ok=false;break;}
            game_cache_encode_record(&rec,raw);
            if(fwrite(raw,1,sizeof(raw),f)!=sizeof(raw)){ok=false;break;}
            count++;
        }
        offset+=(uint32_t)n;
        if(n<InventoryPage)break;
    }
    free(seen);
    if(old)fclose(old);
    if(ok && fflush(f)!=0)ok=false;
    if(ok) {
        game_cache_header(head,count,old_generation+1);GameIdentitySha256 hash;gi_sha256_init(&hash);gi_sha256_update(&hash,head,32);
        if(fseek(f,GAME_CACHE_HEADER_SIZE,SEEK_SET)!=0)ok=false;
        for(uint32_t i=0;i<count && ok;i++) {
            if(fread(raw,1,sizeof(raw),f)!=sizeof(raw))ok=false;else gi_sha256_update(&hash,raw,sizeof(raw));
        }
        if(ok) {
            gi_sha256_final(&hash,head+32);
            ok=fseek(f,0,SEEK_SET)==0 && fwrite(head,1,sizeof(head),f)==sizeof(head) && fflush(f)==0 && fsync(fileno(f))==0;
        }
    }
    if(fclose(f)!=0)ok=false;
    FILE *check=NULL;
    if(ok)ok=open_valid(tmp,&check,&ignored_bytes,&ignored_gen)==GameCacheUnknown && ignored_gen==old_generation+1;
    if(check)fclose(check);
    if(!ok){remove(tmp);return false;}

    struct stat st;bool target_exists=stat(path,&st)==0;
    if(target_exists && !S_ISREG(st.st_mode)){remove(tmp);return false;}
    if(!target_exists && errno!=ENOENT){remove(tmp);return false;}
    bool moved=false;
    if(target_exists && primary_valid) {
        if(stat(previous,&st)==0) { if(!S_ISREG(st.st_mode) || remove(previous)!=0){remove(tmp);return false;} }
        else if(errno!=ENOENT){remove(tmp);return false;}
        if(rename(path,previous)!=0){remove(tmp);return false;}
        moved=true;
    } else if(target_exists && remove(path)!=0){remove(tmp);return false;}
    if(rename(tmp,path)!=0){if(moved)rename(previous,path);remove(tmp);return false;}
    FILE *final=NULL;uint64_t final_bytes=0,final_gen=0;
    const bool committed=open_valid(path,&final,&final_bytes,&final_gen)==GameCacheUnknown && final_gen==old_generation+1;
    if(final)fclose(final);
    if(!committed){remove(path);if(moved)rename(previous,path);return false;}
    return true;
}

#ifdef __SWITCH__
#include <switch.h>
_Static_assert(offsetof(NacpStruct,local_communication_id)==0x30b0,"NACP LCID offset");
typedef struct { NsApplicationControlData *control; unsigned char *titles; } NsInventory;
static bool ns_list(void *ctx,uint32_t offset,uint64_t *ids,size_t capacity,size_t *count)
{
    (void)ctx;NsApplicationRecord records[InventoryPage];s32 n=0;
    if(capacity!=InventoryPage || offset>INT32_MAX || R_FAILED(nsListApplicationRecord(records,(s32)capacity,(s32)offset,&n)) || n<0 || (size_t)n>capacity)return false;
    for(s32 i=0;i<n;i++)ids[i]=records[i].application_id;
    *count=(size_t)n;return true;
}
static TitleInventoryLoad ns_load(void *ctx,uint64_t id,GameCacheRecord *record)
{
    NsInventory *state=(NsInventory *)ctx;u64 actual=0;
    memset(state->control,0,sizeof(*state->control));
    if(R_FAILED(nsGetApplicationControlData(NsApplicationControlSource_Storage,id,state->control,sizeof(*state->control),&actual)) || actual<sizeof(NacpStruct))return TitleLoadFailed;
    memset(record,0,sizeof(*record));record->application_id=id;
    for(size_t i=0;i<GAME_CACHE_LCID_COUNT;i++) {
        record->local_communication_ids[i]=state->control->nacp.local_communication_id[i];
    }
    int count=nacp_titles((const unsigned char *)&state->control->nacp,sizeof(NacpStruct),state->titles);
    if(count<=0 || !game_identity_select_names(state->titles,(size_t)count*NACP_TITLE_SIZE,(size_t)count,&record->names))return TitleLoadFailed;
    return game_cache_record_valid(record)?TitleLoadFound:TitleLoadFailed;
}
bool title_inventory_refresh(void)
{
    if(mkdir("sdmc:/lanywhere",0777)!=0 && errno!=EEXIST)return false;
    NsInventory state={0};
    state.control=(NsApplicationControlData *)malloc(sizeof(*state.control));
    state.titles=(unsigned char *)malloc(NACP_MAX_TITLES*NACP_TITLE_SIZE);
    bool ok=false;
    if(state.control && state.titles){TitleInventoryBackend backend={&state,ns_list,ns_load};ok=title_inventory_refresh_at(GAME_CACHE_PATH,&backend);}
    free(state.control);free(state.titles);return ok;
}
#else
bool title_inventory_refresh(void) { return false; }
#endif
