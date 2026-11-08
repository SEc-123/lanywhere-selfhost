#include "../source/relay_queue.hpp"
#include <cassert>
#include <vector>

int main() {
    using ams::mitm::lanywhere::RelayQueue;
    RelayQueue q;
    const uint8_t data[] = {1,2,3,4};
    uint8_t out[4]{}; uint32_t ip{}; uint16_t port{};
    assert(q.Push(42, 7, 8, data, sizeof(data)));
    assert(q.Take(8, out, 2, &ip, &port, true) == 2 && ip == 42 && port == 7 && out[1] == 2);
    assert(q.Has(8));
    assert(q.Take(8, out, sizeof(out), &ip, &port, false) == 4 && out[3] == 4);
    assert(!q.Has(8));
    std::vector<uint8_t> large(65507, 0x5a);
    for (int i=0;i<5;i++) assert(q.Push(i, 7, 8, large.data(), large.size()));
    // 5 * 65507 exceeds the byte budget: the oldest datagram is evicted.
    assert(q.Take(8, out, sizeof(out), &ip, &port, false) == 4 && ip == 1);
    q.Clear();
    assert(!q.Has(8));
    for (int i=0;i<129;i++) assert(q.Push(i, 7, 8, data, sizeof(data)));
    assert(q.Take(8, out, sizeof(out), &ip, &port, false) == 4 && ip == 1);
    q.Clear();
}
