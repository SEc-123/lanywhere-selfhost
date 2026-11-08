#include "../source/virtual_receive.hpp"
#include "../source/relay_queue.hpp"
#include "../source/bsd_ipc_abi.hpp"
#include <cassert>
#include <cerrno>

int main() {
    using namespace ams::mitm::bsd;
    assert(NativeWouldNotBlock(0x800, 0));
    assert(!NativeWouldNotBlock(0x4000, 0)); // newlib O_NONBLOCK is not the IPC flag
    assert(NativeWouldNotBlock(0, 0x80));
    assert(NativeAgain == 11 && NativeMessageSize == 90 && NativeHostUnreachable == 113);
    assert(NativeSendError(true) == 90 && NativeSendError(false) == 113);
    ams::mitm::lanywhere::RelayQueue queue;
    int64_t now = 0; int waits = 0; bool active = true; bool peek = false;
    ReceiveResult out{};
    auto clock = [&] { return now; };
    auto is_active = [&] { return active; };
    auto relay = [&](ReceiveResult *result) {
        uint8_t data[4]; uint32_t ip; uint16_t src;
        long n = queue.Take(12, data, sizeof(data), &ip, &src, peek);
        if (n < 0) return false;
        *result = {static_cast<int>(n), 0, 16}; return true;
    };
    auto native = [] { return ReceiveResult{-1, EAGAIN, 0}; };
    auto wait = [&](int slice) {
        ++waits; now += slice;
        if (now >= 10 && !queue.Has(12)) { const uint8_t p[] = {9,8}; assert(queue.Push(1,2,12,p,2)); }
        return 0;
    };
    assert(WaitVirtualReceive(true, 0, EAGAIN, clock, is_active, relay, native, wait, &out));
    assert(out.ret == -1 && out.error == EAGAIN && waits == 0);
    peek = true;
    assert(WaitVirtualReceive(false, 30, EAGAIN, clock, is_active, relay, native, wait, &out));
    assert(out.ret == 2 && out.addrlen == 16 && now == 10 && queue.Has(12));
    peek = false;
    assert(WaitVirtualReceive(false, 30, EAGAIN, clock, is_active, relay, native, wait, &out));
    assert(out.ret == 2 && !queue.Has(12));
    now = 0; waits = 0;
    assert(WaitVirtualReceive(false, 13, EAGAIN, clock, is_active, relay, native,
        [&](int slice) { ++waits; now += slice; return 0; }, &out));
    assert(out.ret == -1 && out.error == EAGAIN && now == 13 && waits == 3);
    auto ready_native = [] { return ReceiveResult{4, 0, 7}; };
    assert(WaitVirtualReceive(false, 0, EAGAIN, clock, is_active, relay, ready_native, wait, &out));
    assert(out.ret == 4 && out.addrlen == 7);
    active = false;
    assert(!WaitVirtualReceive(false, 0, EAGAIN, clock, is_active, relay, native, wait, &out));
    queue.Clear();
}
