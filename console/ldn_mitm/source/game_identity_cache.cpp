#include "game_identity_cache.hpp"
#include <cstring>

namespace ams::mitm::lanywhere {
    namespace {
        bool ReadAt(void *ctx, uint64_t offset, void *out, size_t size) {
            auto *file = static_cast<fs::FileHandle *>(ctx);
            size_t actual = 0;
            return R_SUCCEEDED(fs::ReadFile(&actual, *file, static_cast<s64>(offset), out, size)) && actual == size;
        }
        GameCacheResult LookupPath(const char *path, u64 program, u64 lcid, GameIdentity *out) {
            fs::FileHandle file;
            if (R_FAILED(fs::OpenFile(&file, path, fs::OpenMode_Read))) return GameCacheInvalid;
            s64 size = 0;
            GameCacheResult result = GameCacheInvalid;
            if (R_SUCCEEDED(fs::GetFileSize(&size, file)) && size >= 0)
                result = game_cache_lookup(ReadAt, &file, static_cast<u64>(size), program, lcid, out, nullptr);
            fs::CloseFile(file);
            return result;
        }
        bool FingerprintPath(const char *path, u8 out[32]) {
            fs::FileHandle file;
            if (R_FAILED(fs::OpenFile(&file, path, fs::OpenMode_Read))) return false;
            s64 size = 0;
            uint8_t header[GAME_CACHE_HEADER_SIZE];
            bool ok = R_SUCCEEDED(fs::GetFileSize(&size, file)) && size >= GAME_CACHE_HEADER_SIZE &&
                      ReadAt(&file, 0, header, sizeof(header)) &&
                      std::memcmp(header, "LNYID01\0", 8) == 0 && gi_get32(header+8) == 1 &&
                      gi_get32(header+12) == GAME_CACHE_HEADER_SIZE && gi_get32(header+16) == GAME_CACHE_RECORD_SIZE &&
                      gi_get32(header+20) <= GAME_CACHE_MAX_RECORDS &&
                      static_cast<u64>(size) == GAME_CACHE_HEADER_SIZE + static_cast<u64>(gi_get32(header+20)) * GAME_CACHE_RECORD_SIZE;
            if (ok) std::memcpy(out, header+32, 32);
            fs::CloseFile(file);
            return ok;
        }
    }
    GameCacheResult GameIdentityCacheLookup(u64 program_id, u64 local_communication_id, GameIdentity *out) {
        if (!out) return GameCacheInvalid;
        std::memset(out, 0, sizeof(*out));
        out->program_id = program_id;
        GameCacheResult result = LookupPath(GAME_CACHE_PATH, program_id, local_communication_id, out);
        if (result == GameCacheInvalid)
            result = LookupPath(GAME_CACHE_PREVIOUS_PATH, program_id, local_communication_id, out);
        return result;
    }
    GameCacheResult GameIdentityCacheExactRecord(u64 program_id, GameCacheRecord *out) {
        if (!out || !program_id) return GameCacheInvalid;
        std::memset(out, 0, sizeof(*out));
        fs::FileHandle file;
        if (R_FAILED(fs::OpenFile(&file, GAME_CACHE_PATH, fs::OpenMode_Read))) return GameCacheInvalid;
        s64 size = 0;
        GameCacheResult result = GameCacheInvalid;
        if (R_SUCCEEDED(fs::GetFileSize(&size, file)) && size >= 0)
            result = game_cache_get_record(ReadAt, &file, static_cast<u64>(size), program_id, out, nullptr);
        fs::CloseFile(file);
        return result;
    }
    bool GameIdentityCacheFingerprint(u8 out[32]) {
        if (!out) return false;
        std::memset(out, 0, 32);
        return FingerprintPath(GAME_CACHE_PATH, out) || FingerprintPath(GAME_CACHE_PREVIOUS_PATH, out);
    }
}
