#include "../source/udp_port_policy.hpp"
#include <arpa/inet.h>
#include <cassert>
#include <cerrno>
#include <sys/socket.h>
#include <unistd.h>

int main() {
    using namespace ams::mitm::bsd;
    int fd = socket(AF_INET, SOCK_DGRAM, 0); assert(fd >= 0);
    auto get = [&]() -> PortResult {
        sockaddr_in addr{}; socklen_t n=sizeof(addr);
        if (getsockname(fd, reinterpret_cast<sockaddr *>(&addr), &n)) return {0,errno};
        return {ntohs(addr.sin_port),0};
    };
    auto bind_ephemeral = [&] {
        sockaddr_in addr{}; addr.sin_family=AF_INET;
        return bind(fd,reinterpret_cast<sockaddr *>(&addr),sizeof(addr)) ? errno : 0;
    };
    auto before = ResolveUdpPort(false,get,bind_ephemeral,EADDRNOTAVAIL);
    assert(before.port == 0 && before.error == 0);
    auto bound = ResolveUdpPort(true,get,bind_ephemeral,EADDRNOTAVAIL);
    assert(bound.port != 0 && bound.error == 0 && get().port == bound.port);
    assert(ResolveUdpPort(true,get,bind_ephemeral,EADDRNOTAVAIL).port == bound.port);
    close(fd);
    // A competing successful bind must win over the failed bind attempt.
    int queries = 0;
    auto race = ResolveUdpPort(true,[&]() -> PortResult { return {static_cast<uint16_t>(++queries == 1 ? 0 : 40000),0}; },
                              [] { return EINVAL; },EADDRNOTAVAIL);
    assert(race.port == 40000 && race.error == 0);
    auto failed = ResolveUdpPort(true,[]() -> PortResult { return {0,0}; },[] { return EACCES; },EADDRNOTAVAIL);
    assert(failed.port == 0 && failed.error == EACCES);
}
