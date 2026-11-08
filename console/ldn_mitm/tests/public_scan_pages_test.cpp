#include "../source/public_scan_pages.hpp"
#include <cassert>
#include <cstdint>
#include <vector>

struct Intent { uint64_t localCommunicationId; uint16_t sceneId; };
struct NetworkId { Intent intentId; uint64_t sessionId; };
struct Filter { uint32_t flag; NetworkId networkId; uint32_t networkType, ssid; };
struct Network { NetworkId networkId; struct { uint32_t networkType, ssid; } common; };

int main() {
    using ams::mitm::ldn::CollectPublicPages;
    using ams::mitm::ldn::MatchesPublicFilter;
    constexpr uint32_t end = UINT32_MAX;
    std::vector<int> accepted;
    unsigned calls = 0;
    // The six first rooms fail the game filter; the seventh passes.
    auto fetch = [&](uint32_t offset, uint32_t *next) {
        ++calls;
        const Filter filter{0x37, {{42, 2}, 6}, 3, 4};
        const int count = offset == 0 ? 6 : 1;
        if (offset) assert(offset == 6);
        for (int i=0;i<count;i++) {
            const Network room{{{42, static_cast<uint16_t>(offset ? 2 : 1)}, 6}, {3,4}};
            if (MatchesPublicFilter(filter, room, 1, 2, 4, 16, 32)) accepted.push_back(offset + i + 1);
        }
        *next = offset ? end : 6;
        return count;
    };
    assert(CollectPublicPages(fetch, [&] { return accepted.size() == 8; }, end, 16) == 7);
    assert(calls == 2 && accepted.size() == 1 && accepted[0] == 7);
    calls = 0;
    assert(CollectPublicPages([&](uint32_t offset, uint32_t *next) {
        ++calls; *next = offset + 6; return 6;
    }, [] { return false; }, end, 3) == 18 && calls == 3);
    assert(CollectPublicPages([](uint32_t, uint32_t*) { return -1; }, [] { return false; }, end, 3) == -1);
    assert(CollectPublicPages([](uint32_t offset, uint32_t *next) { *next = offset; return 1; }, [] { return false; }, end, 3) == -1);
}
