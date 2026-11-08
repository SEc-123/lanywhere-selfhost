#pragma once
#include <cstdint>

namespace ams::mitm::bsd {
    struct PortResult { uint16_t port; int error; };
    // get() queries this descriptor's real endpoint; bind() binds it to a real ephemeral port.
    template<class Get, class Bind>
    PortResult ResolveUdpPort(bool bind_if_needed, Get get, Bind bind, int no_port_error) {
        PortResult result = get();
        if (result.error || result.port || !bind_if_needed) return result;
        const int bind_error = bind();
        result = get(); // Another thread may have bound this descriptor while we tried.
        if (!result.port && !result.error) result.error = bind_error ? bind_error : no_port_error;
        return result;
    }
}
