/* LANywhere game stream framing. GPL-2.0-only; see the project LICENSE. */
#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace ams::mitm::tcpstream {
constexpr uint8_t Command = 0x24, Response = 0xa4;
constexpr uint32_t Capability = 128, LegacyCapability = 256, MemberFeature = 2;
constexpr size_t HeaderBytes = 32, PrefixBytes = 4, MaxChunk = 1024;
constexpr uint16_t MaxWindow = 32768, LocalWindow = 16384;
enum class Op : uint8_t { Open=1, OpenOk=2, Data=3, Fin=4, Reset=5, Window=6, LegacyReady=7 };
enum class Reason : uint16_t { Protocol=1, Unsupported=2, Capacity=3, Refused=4,
    Timeout=5, Closed=6, Session=7, Backpressure=8 };
struct Frame {
    uint32_t peer=0, id=0;
    uint64_t nonce=0, seq=0;
    Op op=Op::Reset;
    uint8_t owner=0;
    uint16_t source_port=0, destination_port=0, aux=0, size=0;
    const uint8_t *data=nullptr;
};
inline uint16_t Get16(const uint8_t *p) { return p[0] | uint16_t(p[1])<<8; }
inline uint32_t Get32(const uint8_t *p) { return Get16(p) | uint32_t(Get16(p+2))<<16; }
inline uint64_t Get64(const uint8_t *p) { return Get32(p) | uint64_t(Get32(p+4))<<32; }
inline void Put16(uint8_t *p,uint16_t n) { p[0]=n;p[1]=n>>8; }
inline void Put32(uint8_t *p,uint32_t n) { Put16(p,n);Put16(p+2,n>>16); }
inline void Put64(uint8_t *p,uint64_t n) { Put32(p,n);Put32(p+4,n>>32); }
inline bool Valid(const Frame &f) {
    if (!f.peer || !f.id || !f.nonce || f.owner>1 || (f.size && !f.data)) return false;
    const bool no_ports=!f.source_port && !f.destination_port;
    switch(f.op) {
        case Op::Open: return !f.owner && !f.seq && f.source_port && f.destination_port &&
            f.size==32 && f.aux && f.aux<=MaxWindow;
        case Op::OpenOk: case Op::LegacyReady:
            return f.owner==1 && !f.seq && no_ports && !f.size && f.aux && f.aux<=MaxWindow;
        case Op::Data: return no_ports && !f.aux && f.size && f.size<=MaxChunk;
        case Op::Fin: return no_ports && !f.aux && !f.size;
        case Op::Window: return no_ports && !f.size && f.aux<=MaxWindow;
        case Op::Reset: return no_ports && !f.seq && !f.size && f.aux>=1 && f.aux<=8;
        default: return false;
    }
}
inline bool Parse(const void *buffer,size_t size,Frame *out) {
    if (!buffer || !out || size<PrefixBytes+HeaderBytes || size>PrefixBytes+HeaderBytes+MaxChunk) return false;
    const auto *b=static_cast<const uint8_t *>(buffer),*h=b+PrefixBytes;
    if (h[0]!=1 || h[3]) return false;
    Frame f;f.peer=Get32(b);f.op=static_cast<Op>(h[1]);f.owner=h[2];f.id=Get32(h+4);
    f.nonce=Get64(h+8);f.seq=Get64(h+16);f.source_port=Get16(h+24);
    f.destination_port=Get16(h+26);f.size=Get16(h+28);f.aux=Get16(h+30);f.data=h+HeaderBytes;
    if (size!=PrefixBytes+HeaderBytes+f.size || !Valid(f)) return false;
    *out=f;return true;
}
inline size_t Encode(void *buffer,size_t capacity,const Frame &f) {
    const size_t bytes=PrefixBytes+HeaderBytes+f.size;
    if (!buffer || capacity<bytes || !Valid(f)) return 0;
    auto *b=static_cast<uint8_t *>(buffer),*h=b+PrefixBytes;
    std::memset(b,0,PrefixBytes+HeaderBytes);Put32(b,f.peer);h[0]=1;h[1]=static_cast<uint8_t>(f.op);h[2]=f.owner;
    Put32(h+4,f.id);Put64(h+8,f.nonce);Put64(h+16,f.seq);Put16(h+24,f.source_port);
    Put16(h+26,f.destination_port);Put16(h+28,f.size);Put16(h+30,f.aux);
    if(f.size)std::memcpy(h+HeaderBytes,f.data,f.size);
    return bytes;
}
}
