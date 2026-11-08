#pragma once
#include <cstddef>
#include <cstdint>
#include <cstring>

namespace ams::mitm::lanywhere {
    constexpr std::size_t MaxUdpPayload = 65507, FragmentChunk = 1100;
    // Fixed bounded storage avoids allocating on untrusted UDP input.
    class FragmentAssembly {
        struct Slot {
            bool used{};
            uint32_t source{}, id{};
            uint16_t src_port{}, dst_port{}, total{};
            uint64_t started{};
            std::size_t count{};
            unsigned ranges{};
            struct Range { uint16_t offset, size; } fragments[128]{};
            uint8_t data[MaxUdpPayload]{};
            uint8_t received[(MaxUdpPayload + 7) / 8]{};
        } slots[2];
        struct Replay { bool used{}; uint32_t source{}, id{}; uint64_t expires{}; } replay[2048];
        static bool bit(const Slot &s, std::size_t n) { return (s.received[n / 8] >> (n % 8)) & 1; }
    public:
        void Reset() { for (auto &s : slots) s.used = false; for (auto &r : replay) r.used = false; }
        template<class Deliver>
        bool Push(uint32_t source, uint16_t src_port, uint16_t dst_port, uint32_t id,
                  uint16_t total, uint16_t offset, const uint8_t *data, std::size_t size,
                  uint64_t now_ms, Deliver deliver) {
            if (!data || !total || total > MaxUdpPayload || !size || size > FragmentChunk ||
                offset >= total || size > static_cast<std::size_t>(total - offset)) return false;
            for (auto &s : slots) if (s.used && now_ms - s.started >= 2000) s.used = false;
            Replay *free_replay = nullptr;
            for (auto &r : replay) {
                if (r.used && now_ms >= r.expires) r.used = false;
                if (r.used && r.source == source && r.id == id) return false;
                if (!r.used && !free_replay) free_replay = &r;
            }
            Slot *slot = nullptr, *empty = nullptr;
            for (auto &s : slots) {
                if (s.used && s.source == source && s.id == id) slot = &s;
                if (!s.used && !empty) empty = &s;
            }
            if (!slot) {
                if (!empty) return false;
                slot = empty; slot->used = true; slot->source = source; slot->id = id;
                slot->src_port = src_port; slot->dst_port = dst_port; slot->total = total;
                slot->started = now_ms; slot->count = 0; slot->ranges = 0;
                std::memset(slot->received, 0, sizeof(slot->received));
            } else if (slot->src_port != src_port || slot->dst_port != dst_port || slot->total != total) {
                slot->used = false; return false;
            }
            std::size_t overlap = 0;
            bool same = true;
            for (std::size_t i = 0; i < size; ++i) {
                if (bit(*slot, offset + i)) { ++overlap; same &= slot->data[offset + i] == data[i]; }
            }
            if (overlap) {
                if (overlap == size && same) {
                    for (unsigned i=0; i<slot->ranges; ++i)
                        if (slot->fragments[i].offset == offset && slot->fragments[i].size == size) return true;
                }
                slot->used = false; return false;
            }
            if (slot->ranges >= 128) { slot->used = false; return false; }
            slot->fragments[slot->ranges++] = {offset, static_cast<uint16_t>(size)};
            std::memcpy(slot->data + offset, data, size);
            for (std::size_t i = 0; i < size; ++i) slot->received[(offset+i)/8] |= uint8_t(1u << ((offset+i)%8));
            slot->count += size;
            if (slot->count == slot->total) {
                if (!free_replay) { slot->used = false; return false; }
                deliver(slot->data, slot->total, source, src_port, dst_port);
                *free_replay = {true, source, id, now_ms + 2000};
                slot->used = false;
            }
            return true;
        }
    };
}
