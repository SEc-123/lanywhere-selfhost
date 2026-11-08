#include "../source/lcid_policy.hpp"
#include "../source/public_scan_pages.hpp"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <vector>
using namespace ams::mitm::ldn;
bool read_cache(void *ctx,uint64_t offset,void *out,size_t size) {
    const auto &v=*static_cast<std::vector<uint8_t>*>(ctx);
    if(offset>v.size()||size>v.size()-offset)return false;
    std::memcpy(out,v.data()+offset,size);return true;
}
std::vector<uint8_t> encode(std::vector<GameCacheRecord> records) {
    std::vector<uint8_t> v(64+records.size()*328);game_cache_header(v.data(),records.size(),1);
    for(size_t i=0;i<records.size();i++)game_cache_encode_record(&records[i],v.data()+64+i*328);
    GameIdentitySha256 hash;gi_sha256_init(&hash);gi_sha256_update(&hash,v.data(),32);
    gi_sha256_update(&hash,v.data()+64,v.size()-64);gi_sha256_final(&hash,v.data()+32);return v;
}
int main() {
    // These ordered LCID patterns were observed in the two target SD records;
    // no other user's installed titles are needed by this fixture.
    GameCacheRecord dying{},violet{};
    dying.application_id=0x01008C8012920000ULL;violet.application_id=0x01008F6008C5E000ULL;
    for(size_t i=0;i<8;i++){dying.local_communication_ids[i]=dying.application_id;violet.local_communication_ids[i]=violet.application_id;}
    violet.local_communication_ids[0]=0x0100A3D008C5C000ULL;
    std::strcpy(dying.names.english,"Dying Light");std::strcpy(dying.names.chinese,"消逝的光芒");
    std::strcpy(violet.names.english,"Pokemon Violet");std::strcpy(violet.names.chinese,"宝可梦 紫");
    auto data=encode({dying,violet});GameCacheRecord record{};
    assert(game_cache_get_record(read_cache,&data,data.size(),violet.application_id,&record,nullptr)==GameCacheFound);
    assert(record.local_communication_ids[0]==violet.local_communication_ids[0]);
    auto a=ResolveGameLcid(UINT64_MAX,true,GameCacheFound,dying);
    auto b=ResolveGameLcid(UINT64_MAX,true,GameCacheFound,record);
    assert(a.error==LcidPolicyError::None && a.wire==dying.application_id);
    assert(b.error==LcidPolicyError::None && b.wire==0x0100A3D008C5C000ULL && b.wire!=violet.application_id);
    assert(a.wire!=b.wire);
    for(auto *r:{&dying,&violet}) {
        auto legacy=ResolveGameLcid(UINT64_MAX,false,GameCacheFound,*r);
        assert(legacy.error==LcidPolicyError::None && legacy.wire==UINT64_MAX && legacy.canonical==r->local_communication_ids[0]);
    }
    for(auto status:{GameCacheInvalid,GameCacheUnknown,GameCacheAmbiguous}) {
        assert(ResolveGameLcid(UINT64_MAX,true,status,record).error==LcidPolicyError::Unavailable);
        auto external=ResolveGameLcid(UINT64_MAX,false,status,record);
        assert(external.error==LcidPolicyError::None && external.wire==UINT64_MAX && external.canonical==0);
        assert(ResolveGameLcid(42,true,status,record).wire==42); // Stock explicit-ID load-failure behavior.
    }
    for(bool self:{false,true}) {
        assert(ResolveGameLcid(violet.application_id,self,GameCacheFound,violet).wire==violet.application_id);
        assert(ResolveGameLcid(dying.application_id,self,GameCacheFound,violet).error==LcidPolicyError::NotAllowed);
        assert(ResolveGameLcid(0,self,GameCacheFound,violet).error==LcidPolicyError::NotAllowed);
    }
    auto bad=violet;bad.local_communication_ids[0]=0;
    assert(ResolveGameLcid(UINT64_MAX,true,GameCacheFound,bad).error==LcidPolicyError::Unavailable);
    assert(ResolveGameLcid(UINT64_MAX,false,GameCacheFound,bad).wire==UINT64_MAX);
    bad.local_communication_ids[0]=UINT64_MAX;
    assert(ResolveGameLcid(UINT64_MAX,true,GameCacheFound,bad).error==LcidPolicyError::Unavailable);
    auto duplicate=encode({violet,bad});
    assert(game_cache_get_record(read_cache,&duplicate,duplicate.size(),violet.application_id,&record,nullptr)==GameCacheAmbiguous);
    auto sentinel_cache=encode({bad});GameIdentity identity{};
    assert(game_cache_lookup(read_cache,&sentinel_cache,sentinel_cache.size(),0,UINT64_MAX,&identity,nullptr)==GameCacheUnknown);
    assert(game_cache_lookup(read_cache,&sentinel_cache,sentinel_cache.size(),violet.application_id,UINT64_MAX,&identity,nullptr)==GameCacheFound);
    assert(game_cache_get_record(read_cache,&data,data.size(),violet.application_id+1,&record,nullptr)==GameCacheUnknown); // No subprogram mask.
    data[32]^=1;
    assert(game_cache_get_record(read_cache,&data,data.size(),violet.application_id,&record,nullptr)==GameCacheInvalid);
    std::puts("LCID dual policy: exact-cache integrity, target defaults, cross-game isolation, external raw wire and failure cases passed");
}
