#pragma once
#include "udp_reassembly.hpp"
#include <algorithm>

namespace ams::mitm::lanywhere {
    // Sends fragment bodies after the 9-byte authenticated UDP header.
    template<class Send>
    bool WriteFragments(uint32_t dst, uint16_t src_port, uint16_t dst_port, uint32_t id,
                        const uint8_t *data, std::size_t size, Send send) {
        if (!data || size <= FragmentChunk || size > MaxUdpPayload) return false;
        uint8_t body[16 + FragmentChunk];
        auto p16 = [](uint8_t *p, uint16_t v) { p[0]=v; p[1]=v>>8; };
        auto p32 = [](uint8_t *p, uint32_t v) { for (int i=0;i<4;++i) p[i]=v>>(i*8); };
        p32(body, dst); p16(body+4, src_port); p16(body+6, dst_port);
        p32(body+8, id); p16(body+12, static_cast<uint16_t>(size));
        for (std::size_t offset=0; offset<size; offset+=FragmentChunk) {
            const auto n = std::min<std::size_t>(FragmentChunk, size-offset);
            p16(body+14, static_cast<uint16_t>(offset));
            std::memcpy(body+16, data+offset, n);
            if (!send(body, 16+n)) return false;
        }
        return true;
    }
}
