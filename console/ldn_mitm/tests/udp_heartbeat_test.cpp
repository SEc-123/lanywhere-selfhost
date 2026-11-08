#include "../source/udp_heartbeat.hpp"
#include <cassert>

int main() {
    ams::mitm::lanywhere::HeartbeatTracker h;
    assert(!h.NeedsRegistration());
    h.Sent(1); assert(!h.Acknowledge(2));
    assert(!h.NeedsRegistration()); h.Sent(2);
    assert(!h.NeedsRegistration()); h.Sent(3);
    assert(h.NeedsRegistration());
    h.Reset(); h.Sent(4); assert(h.Acknowledge(4));
    assert(!h.NeedsRegistration());
    h.Sent(5); assert(!h.NeedsRegistration());
    assert(h.Acknowledge(5)); h.Sent(6);
    assert(!h.NeedsRegistration());
}
