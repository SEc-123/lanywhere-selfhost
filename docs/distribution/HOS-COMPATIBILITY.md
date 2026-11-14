# HOS 23.5.0 compatibility

[Issue #1](https://github.com/SEc-123/lanywhere-selfhost/issues/1) reports HOS 23.5.0 as unsupported. The report does not identify the installed LANywhere package, Atmosphère version, bootloader, failure stage or result code.

## Confirmed startup blocker

The public 0.5.7 build pins Atmosphère-libs to `cf48d233`, whose firmware ceiling is 23.0.1. The sysmodule reads the HOS version from Exosphère during `__appInit`. The library aborts on an unrecognized major or newer minor version. On a supported Atmosphère boot chain that reports 23.5.0, this abort precedes SD mounting, module logs, network initialization and registration of `ldn:u`, `bsd:u` and `lanywhr`. The Album app and overlay therefore cannot connect to that instance of the module. [0.5.7 firmware ceiling](https://github.com/SEc-123/lanywhere-selfhost/blob/v0.5.7/console/Atmosphere-libs/libvapours/include/vapours/ams/ams_target_firmware.h) · [Startup check](https://github.com/SEc-123/lanywhere-selfhost/blob/v0.5.7/console/Atmosphere-libs/libstratosphere/source/hos/hos_version_api.cpp#L105)

The candidate imports the five files changed by Atmosphère-libs commit `75c6889`, which recognizes HOS 23.5.0. The version check itself is unchanged. Keep the pinned libnx commit `b156b477`, devkitA64 r29.2/GCC 15.2.0 and Switch tools 1.13.1. The host comparison runs the actual version check with both upstream headers and the pinned libnx version setter. It simulates the firmware response from Exosphère. It reproduces the old rejection and demonstrates acceptance after the update. [Upstream change](https://github.com/Atmosphere-NX/Atmosphere-libs/commit/75c688910baf76c0f5e62a3a7fe90bc0dc7f70a1)

The pinned libnx still reads and stores the firmware number correctly. The BSD and NIFM initialization paths contain no 23.0 or 23.5 firmware gate, and the NS app metadata path still uses its existing service. Their behavior on the actual 23.5.0 services remains a hardware check. [BSD](https://github.com/switchbrew/libnx/blob/b156b4774fb2df7b93402169509266da7547fc4c/nx/source/services/bsd.c#L213) · [NIFM](https://github.com/switchbrew/libnx/blob/b156b4774fb2df7b93402169509266da7547fc4c/nx/source/services/nifm.c#L18) · [NS](https://github.com/switchbrew/libnx/blob/b156b4774fb2df7b93402169509266da7547fc4c/nx/source/services/ns.c#L460)

HOS 23.5.0 needs an appropriate host boot chain. Atmosphère 1.12.2 added basic support and subsequently replaced its `fusee.bin` to fix a nogc patch failure. Hekate 6.5.5 also added support and received a FAT32 NOGC fix. Record the boot path and exact build for the test. [Atmosphère 1.12.2](https://github.com/Atmosphere-NX/Atmosphere/releases/tag/1.12.2) · [Hekate 6.5.5](https://github.com/CTCaer/hekate/releases/tag/v6.5.5)

## Distinguish the failure stage

| Stage | Evidence to collect |
| --- | --- |
| System or module startup | Check if HOME loads with the LANywhere boot flag disabled, then repeat with the candidate enabled. Record the exact Atmosphère, bootloader, HOS and emuMMC or sysMMC versions. For a fatal error, retain the result code, program ID and matching Atmosphère crash or fatal report. LANywhere uses title ID `4200000000000010`, shared with ldn_mitm. |
| Album app or overlay startup | Record whether the homebrew menu opens and whether the NRO or OVL reaches its own UI. Verify the three binaries came from the same package and that the target SD files match its hashes. Record the loader version for overlay failures. |
| Local IPC or relay | Record the exact UI message. The app opens local service `lanywhr`, then command 10 checks IPC ABI 5. The overlay also requires ABI 5. A missing service and a failed capability handshake give different UI states. A successful handshake permits testing lobby and appointment network requests separately. A shared ABI does not uniquely identify the installed release. |
| In-game connection | Record the game and version on both consoles, Local Wireless mode, selected relay and whether host, scan, join or traffic fails. The existing private LDN commands return NotSupported. A successful menu or lobby check does not verify a game session. |

For local IPC diagnostics, `0xE15` is SM NotRegistered and `0x1BA0A` is CMIF UnknownCommandId. The app can fall back to legacy lobby pagination when the unified lobby command is unavailable. A matched major version can still have missing optional appointment commands. Keep the raw result and distinguish it from a remote relay timeout or rate limit. A missing game icon alone can be investigated in `lanywhere/icon-status.log`. None of these result values was reported in Issue #1.

## Verification matrix

| HOS | Atmosphère / boot chain | LANywhere | Test and status |
| --- | --- | --- | --- |
| 19.0.1 | Existing compatible emuMMC setup | 0.5.7 and candidate | Both guards accept the mocked version. Repeat boot and appointment checks on a known working older console. |
| 23.0.0 / 23.0.1 | Known working 1.12.0 / 1.12.1 setup for the respective firmware | 0.5.7 and candidate | Both firmware checks pass in the host fixture. Repeat boot, Album, overlay and a game host/join on hardware as a regression comparison. |
| 23.5.0 | 1.12.2 with corrected fusee, or the updated Hekate 6.5.5 boot path | Disabled, 0.5.7, candidate | Establish clean HOME boot first. Old guard rejects and new guard accepts in host comparison. Test candidate cold boot and reboot, control service, appointments, overlay and two-console Local Wireless. Physical test pending. |
| 23.5.0 | 1.12.2 tested boot chain | Matched candidate, then intentional ABI mismatch | Check command 10 and the app/overlay error state. Check loaded artifact hashes across reboots. Physical test pending. |
| 23.6.0 / 24.0.0 | Simulated version input | Candidate | Host fixture confirms that the guard still rejects an unrecognized newer minor or major version. |

The prior 0.5.7 emuMMC acceptance covered boot, appointment buttons and reboot. Its exact HOS/Atmosphère pair was not recorded during that run. This candidate has no 23.5.0 hardware execution evidence yet. The confirmed source defect explains a startup failure on the published 0.5.7 package under those conditions. The current report does not establish that this was the reporter's actual error.

Run the version comparison on a developer machine with the pinned, clean libnx source checkout and the 0.5.7 tag available:

```sh
python3 scripts/toolchain/test-hos-startup-guard.py . /path/to/libnx v0.5.7
```
