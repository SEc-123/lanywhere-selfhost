#pragma once
#include <cstdint>
namespace ams::mitm::bsd {
    constexpr int32_t NativeNonblock = 0x800, NativeDontWait = 0x80;
    constexpr int32_t NativeAgain = 11, NativeMessageSize = 90, NativeHostUnreachable = 113;
    constexpr bool NativeWouldNotBlock(int32_t file_flags, int32_t message_flags) {
        return (file_flags & NativeNonblock) || (message_flags & NativeDontWait);
    }
    constexpr int32_t NativeSendError(bool message_too_large) {
        return message_too_large ? NativeMessageSize : NativeHostUnreachable;
    }
}
