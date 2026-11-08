#pragma once
#include <cstdint>

namespace ams::mitm::ldn {
    template<class Filter, class Info>
    bool MatchesPublicFilter(const Filter &filter, const Info &info, uint32_t game, uint32_t session,
                             uint32_t network_type, uint32_t ssid, uint32_t scene) {
        return (!(filter.flag & game) || filter.networkId.intentId.localCommunicationId == info.networkId.intentId.localCommunicationId) &&
               (!(filter.flag & session) || filter.networkId.sessionId == info.networkId.sessionId) &&
               (!(filter.flag & network_type) || filter.networkType == info.common.networkType) &&
               (!(filter.flag & ssid) || filter.ssid == info.common.ssid) &&
               (!(filter.flag & scene) || filter.networkId.intentId.sceneId == info.networkId.intentId.sceneId);
    }
    // fetch(offset, &next) invokes the consumer for each item and returns its count or -1.
    // Return -1 only when the first page failed; otherwise preserve already collected results.
    template<class Fetch, class Complete>
    int CollectPublicPages(Fetch fetch, Complete complete, uint32_t end, unsigned max_pages) {
        uint32_t offset = 0;
        int total = 0;
        for (unsigned page = 0; page < max_pages; ++page) {
            uint32_t next = end;
            const int count = fetch(offset, &next);
            if (count < 0) return page == 0 ? -1 : total;
            total += count;
            if (complete() || next == end) return total;
            if (count == 0 || next <= offset) return -1;
            offset = next;
        }
        return total;
    }
}
