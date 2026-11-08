#include "../source/udp_reassembly.hpp"
#include "../source/udp_fragment_writer.hpp"
#include "../source/udp_send_policy.hpp"
#include <cassert>
#include <vector>

int main() {
    using namespace ams::mitm::lanywhere;
    for (std::size_t n : {1101u, 1200u, 1400u, 1455u}) {
        assert(ChooseSendMode(n,false) == SendMode::Legacy);
        assert(ChooseSendMode(n,true) == SendMode::Fragment);
    }
    assert(ChooseSendMode(1100,false) == SendMode::Legacy);
    assert(ChooseSendMode(1456,false) == SendMode::TooLarge);
    assert(ChooseSendMode(65507,true) == SendMode::Fragment);
    assert(ChooseSendMode(65508,true) == SendMode::TooLarge);
    static FragmentAssembly assembly;
    std::vector<uint8_t> original(65507), actual;
    for (std::size_t i=0;i<original.size();++i) original[i]=static_cast<uint8_t>(i * 37);
    unsigned delivered=0;
    auto deliver = [&](const uint8_t *p, std::size_t n, uint32_t ip, uint16_t sp, uint16_t dp) {
        ++delivered; actual.assign(p,p+n); assert(ip==1 && sp==2 && dp==3);
    };
    // Reordered chunks and a duplicate never cause early delivery.
    assert(assembly.Push(1,2,3,9,original.size(),1100,original.data()+1100,1100,0,deliver));
    assert(assembly.Push(1,2,3,9,original.size(),1100,original.data()+1100,1100,1,deliver));
    for (std::size_t i=0;i<original.size();i+=1100) {
        if (i==1100) continue;
        const auto n=std::min<std::size_t>(1100,original.size()-i);
        assert(assembly.Push(1,2,3,9,original.size(),i,original.data()+i,n,2,deliver));
    }
    assert(delivered==1 && actual==original);
    assert(!assembly.Push(1,2,3,9,original.size(),0,original.data(),1,3,deliver));
    // A conflicting overlap discards the whole incomplete assembly.
    assert(assembly.Push(1,2,3,10,8,0,original.data(),4,4,deliver));
    assert(!assembly.Push(1,2,3,10,8,2,original.data()+2,4,5,deliver));
    assert(assembly.Push(1,2,3,99,8,0,original.data(),6,5,deliver));
    assert(!assembly.Push(1,2,3,99,8,2,original.data()+2,2,5,deliver));
    assembly.Reset();
    assert(assembly.Push(1,2,3,11,8,0,original.data(),4,10,deliver));
    assert(assembly.Push(1,2,3,12,8,0,original.data(),4,10,deliver));
    assert(!assembly.Push(1,2,3,13,8,0,original.data(),4,10,deliver));
    assert(assembly.Push(1,2,3,13,8,0,original.data(),4,2010,deliver));
    assert(!assembly.Push(1,2,3,14,8,7,original.data(),2,2010,deliver));
    assembly.Reset(); delivered = 0; actual.clear();
    const auto u16 = [](const uint8_t *p) { return static_cast<uint16_t>(p[0] | p[1] << 8); };
    const auto u32 = [](const uint8_t *p) { return uint32_t(p[0]) | uint32_t(p[1])<<8 | uint32_t(p[2])<<16 | uint32_t(p[3])<<24; };
    assert(WriteFragments(0x0a0d0001,2,3,50,original.data(),original.size(), [&](const uint8_t *p, std::size_t n) {
        assert(n > 16 && n <= 1116 && u32(p) == 0x0a0d0001);
        return assembly.Push(1,u16(p+4),u16(p+6),u32(p+8),u16(p+12),u16(p+14),p+16,n-16,3000,deliver);
    }));
    assert(delivered == 1 && actual == original);
    assert(!WriteFragments(1,2,3,51,original.data(),1101,[](const uint8_t *, std::size_t) { return false; }));
    assembly.Reset();
    for (unsigned i=0;i<128;i++) assert(assembly.Push(1,2,3,60,130,i,original.data()+i,1,1,deliver));
    assert(!assembly.Push(1,2,3,60,130,128,original.data()+128,1,1,deliver));
    assembly.Reset();
    auto discard = [](const uint8_t *, std::size_t, uint32_t, uint16_t, uint16_t) {};
    for (unsigned i=0;i<2048;i++) assert(assembly.Push(1,2,3,100+i,1,0,original.data(),1,1,discard));
    assert(!assembly.Push(1,2,3,99999,1,0,original.data(),1,1,discard));
    assert(assembly.Push(1,2,3,99999,1,0,original.data(),1,2001,discard));
}
