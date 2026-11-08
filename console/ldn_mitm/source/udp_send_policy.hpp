#pragma once
#include <cstddef>
namespace ams::mitm::lanywhere {
    enum class SendMode { Legacy, Fragment, TooLarge };
    constexpr SendMode ChooseSendMode(std::size_t size, bool fragments) {
        return size > 65507 ? SendMode::TooLarge : size <= 1100 ? SendMode::Legacy :
               fragments ? SendMode::Fragment : size <= 1455 ? SendMode::Legacy : SendMode::TooLarge;
    }
}
