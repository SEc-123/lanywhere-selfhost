#pragma once
#include <algorithm>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>

namespace ams::mitm::lanywhere {
    // Caller serializes access. Both message count and allocated bytes are bounded.
    class RelayQueue {
        struct Packet { uint16_t dst{}, src{}, size{}; uint32_t ip{}; uint8_t *data{}; };
        static constexpr std::size_t MaxCount = 128, MaxBytes = 256 * 1024, MaxPayloadBytes = 65507;
        Packet packets[MaxCount]{};
        std::size_t head{}, count{}, bytes{};
    public:
        RelayQueue(const RelayQueue &) = delete;
        RelayQueue &operator=(const RelayQueue &) = delete;
        RelayQueue() = default;
        void Clear() {
            while (count) {
                auto &p = packets[head]; std::free(p.data); p.data = nullptr;
                head = (head + 1) % MaxCount; --count;
            }
            head = bytes = 0;
        }
        bool Push(uint32_t ip, uint16_t src, uint16_t dst, const uint8_t *data, std::size_t size) {
            if (size > MaxPayloadBytes || (size && !data)) return false;
            while (count && (count == MaxCount || bytes + size > MaxBytes)) {
                auto &old = packets[head]; bytes -= old.size; std::free(old.data); old.data = nullptr;
                head = (head + 1) % MaxCount; --count;
            }
            auto *copy = static_cast<uint8_t *>(std::malloc(size ? size : 1));
            if (!copy) return false;
            if (size) std::memcpy(copy, data, size);
            packets[(head + count) % MaxCount] = {dst, src, static_cast<uint16_t>(size), ip, copy};
            bytes += size; ++count;
            return true;
        }
        // Returns -1 when empty, otherwise copied byte count. Peek does not consume.
        long Take(uint16_t port, void *buffer, std::size_t size, uint32_t *ip, uint16_t *src, bool peek) {
            for (std::size_t i = 0; i < count; ++i) {
                auto &p = packets[(head + i) % MaxCount];
                if (p.dst != port) continue;
                const std::size_t n = std::min<std::size_t>(p.size, size);
                if (n) std::memcpy(buffer, p.data, n);
                *ip = p.ip; *src = p.src;
                if (peek) return static_cast<long>(n);
                bytes -= p.size; std::free(p.data);
                for (std::size_t j = i; j + 1 < count; ++j)
                    packets[(head + j) % MaxCount] = packets[(head + j + 1) % MaxCount];
                --count; packets[(head + count) % MaxCount].data = nullptr;
                return static_cast<long>(n);
            }
            return -1;
        }
        bool Has(uint16_t port) const {
            for (std::size_t i = 0; i < count; ++i) if (packets[(head + i) % MaxCount].dst == port) return true;
            return false;
        }
    };
}
