#!/usr/bin/env python3
"""Compile the shipped Atmosphère startup guard against the old and refreshed headers."""
from pathlib import Path
import argparse
import hashlib
import re
import subprocess
import tempfile


parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("project", type=Path)
parser.add_argument("libnx", type=Path)
parser.add_argument("old_ref")
parser.add_argument("new_ref", nargs="?")
args = parser.parse_args()
args.project = args.project.resolve()
args.libnx = args.libnx.resolve()

prefix = "console/Atmosphere-libs/"
target_path = "libvapours/include/vapours/ams/ams_target_firmware.h"
types_path = "libstratosphere/include/stratosphere/hos/hos_types.hpp"
guard_path = "libstratosphere/source/hos/hos_version_api.cpp"
shim_path = "libstratosphere/source/init/init_libnx_shim.os.horizon.cpp"
shim_hos_path = "libstratosphere/source/hos/hos_stratosphere_api.cpp"


def source(ref, path):
    if ref is None:
        return (args.project / prefix / path).read_text()
    return subprocess.check_output(["git", "-C", args.project, "show", f"{ref}:{prefix}{path}"]).decode()


def guard(text):
    match = re.search(r"^    void InitializeVersionInternal\(bool allow_approximate\) \{\n.*?^    \}", text, re.M | re.S)
    assert match, "could not extract InitializeVersionInternal"
    return match.group()


def run(ref, max_version, accepts_23_5):
    target = source(ref, target_path)
    types = source(ref, types_path)
    body = guard(source(ref, guard_path))
    launch = source(ref, shim_path)
    stratosphere = source(ref, shim_hos_path)
    assert launch.index("::ams::hos::InitializeForStratosphere();") < launch.index("::ams::Main();")
    assert "hos::InitializeVersionInternal(CanAllowTemporaryApproximateVersion());" in stratosphere
    revision = subprocess.check_output(["git", "-C", args.project, "rev-parse", ref or "HEAD"], text=True).strip()
    if ref is None:
        revision += " + worktree"
    with tempfile.TemporaryDirectory(prefix="hos-guard-") as temp:
        work = Path(temp)
        (work / "ams_target_firmware.h").write_text(target)
        (work / "hos_types.hpp").write_text(types)
        (work / "vapours.hpp").write_text(
            '#pragma once\n#include <cstdint>\nusing u32 = std::uint32_t;\n#include "ams_target_firmware.h"\n'
        )
        (work / "guard.cpp").write_text(MOCKS + body + CASES)
        subprocess.run(
            ["cc", "-std=c11", "-Wall", "-Wextra", "-Werror", "-I", args.libnx / "nx/include/switch",
             "-c", args.libnx / "nx/source/runtime/hosversion.c", "-o", work / "hosversion.o"],
            check=True,
        )
        subprocess.run(
            ["c++", "-std=c++20", "-Wall", "-Wextra", "-Werror", "-I", work, "-I", args.libnx / "nx/include",
             work / "guard.cpp", work / "hosversion.o", "-o", work / "test"],
            check=True,
        )
        print(f"source {revision} max={max_version} guard_sha256={hashlib.sha256(body.encode()).hexdigest()}", flush=True)
        subprocess.run([work / "test", max_version, str(int(accepts_23_5))], check=True)
    return body


MOCKS = r'''
#include <cassert>
#include <cstdio>
#include <mutex>
#include <string_view>
#include "hos_types.hpp"
extern "C" {
#include <switch/runtime/hosversion.h>
}

#define ATMOSPHERE_OS_HORIZON 1
#define AMS_ABORT_UNLESS(expr) do { if (!(expr)) throw #expr; } while (false)

namespace ams::hos {
struct ExosphereApiInfo {
    u32 firmware;
    u32 GetTargetFirmware() const { return firmware; }
};
static u32 mock_firmware;
static std::mutex g_hos_init_lock;
static Version g_hos_version;
static bool g_set_hos_version;

static ExosphereApiInfo GetExosphereApiInfo(bool) { return {mock_firmware}; }
static bool IsUnitTestProgramForSetVersion() { return false; }
'''

CASES = r'''
}

static void check(u32 major, u32 minor, u32 micro, bool should_accept) {
    using namespace ams::hos;
    mock_firmware = ATMOSPHERE_TARGET_FIRMWARE(major, minor, micro);
    g_hos_version = {};
    g_set_hos_version = false;
    hosversionSet(0);
    bool accepted = false;
    try {
        InitializeVersionInternal(false);
        accepted = true;
    } catch (const char *expression) {
        assert(std::string_view(expression) == "is_safely_tryable_version");
    }
    assert(accepted == should_accept);
    assert(hosversionIsAtmosphere() == accepted);
    assert(hosversionGet() == (accepted ? MAKEHOSVERSION(major, minor, micro) : 0));
    std::printf("HOS %u.%u.%u -> %s\n", major, minor, micro,
                accepted ? "accepted and forwarded to libnx" : "startup guard rejected before libnx");
}

int main(int argc, char **argv) {
    using namespace ams::hos;
    assert(argc == 3);
    const bool refreshed = std::string_view(argv[2]) == "1";
    assert(std::string_view(argv[1]) == (refreshed ? "23.5.0" : "23.0.1"));
    assert(Version_Max == (refreshed ? ATMOSPHERE_TARGET_FIRMWARE(23, 5, 0)
                                     : ATMOSPHERE_TARGET_FIRMWARE(23, 0, 1)));
    check(19, 0, 1, true);
    check(22, 5, 0, true);
    check(23, 0, 0, true);
    check(23, 0, 1, true);
    check(23, 0, 2, true);
    check(23, 5, 0, refreshed);
    check(23, 5, 1, refreshed);
    check(23, 6, 0, false);
    check(24, 0, 0, false);
}
'''

assert subprocess.check_output(["git", "-C", args.libnx, "rev-parse", "HEAD"], text=True).strip() == "b156b4774fb2df7b93402169509266da7547fc4c"
assert not subprocess.check_output(["git", "-C", args.libnx, "status", "--porcelain", "--untracked-files=no"], text=True).strip()
before = run(args.old_ref, "23.0.1", False)
after = run(args.new_ref, "23.5.0", True)
assert before == after, "startup guard implementation changed"
print("PASS: upstream firmware ceiling changes acceptance; guard and launch order are intact.")
print("Scope: host mocks the Exosphere response and fatal handling, and compiles the pinned libnx version API. Hardware boot and IPC require a physical Switch.")
