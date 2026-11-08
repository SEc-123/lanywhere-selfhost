#pragma once
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

/* Host fixture only: no Switch path may escape the temporary test directory. */
#define R_SUCCEEDED(x) ((x) == 0)
#define R_FAILED(x) ((x) != 0)
namespace ams {
    using u64 = uint64_t;
    using u8 = uint8_t;
    using s64 = int64_t;
    namespace fs {
        using FileHandle = std::FILE *;
        enum { OpenMode_Read = 0 };
        inline int OpenFile(FileHandle *out, const char *path, int) {
            const char *root = std::getenv("SWITCH_IDENTITY_TEST_ROOT");
            const char *prefix = "sdmc:/lanywhere/";
            if (!root || std::strncmp(path,prefix,std::strlen(prefix))) return 1;
            std::string local = std::string(root) + "/" + (path + std::strlen(prefix));
            *out = std::fopen(local.c_str(),"rb"); return *out ? 0 : 1;
        }
        inline int GetFileSize(s64 *size, FileHandle file) {
            if(std::fseek(file,0,SEEK_END))return 1;
            long n=std::ftell(file);if(n<0)return 1;*size=n;return 0;
        }
        inline int ReadFile(size_t *actual,FileHandle file,s64 off,void *out,size_t n) {
            if(std::fseek(file,static_cast<long>(off),SEEK_SET))return 1;
            *actual=std::fread(out,1,n,file);return std::ferror(file)?1:0;
        }
        inline void CloseFile(FileHandle file) { std::fclose(file); }
    }
}
