# Native Linux setup and verification

The initial Linux target is **Ubuntu 24.04, x86_64, headless Android Emulator,
with usable KVM**. The runtime already isolates its Linux Android home and
gRPC discovery under its own `XDG_RUNTIME_DIR`. The Linux-specific installer
and host checks are separate from the verified Intel macOS deployment.

For the full clone-to-MCP flow, start with [the Agent quickstart](quickstart.md).
`node scripts/setup.cjs --help` selects the installation route. On Linux x86_64
it uses the private installer below; supplying `--sdk /absolute/installed/sdk`
instead prepares only a new private template/config from an installed SDK.

Linux installation, protocol tests and synthetic media tests must not be
reported as real Android acceptance. A complete Linux device and audible-media
acceptance still requires the deployment host's `/dev/kvm`. See
[the deployment acceptance checklist](acceptance.md).

## Verified scope on 2026-11-10

The compatibility environment was an isolated Debian 12 x86_64 container using
Node 22.22.2, Python 3.12.16, Chrome for Testing 152.0.7977.8 and FFmpeg 5.1.9.
It was not a KVM-capable native Ubuntu deployment.

| Check | Result and boundary |
| --- | --- |
| Runtime, authorization and lifecycle unit tests | 171/171 passed on Linux, with real FFmpeg and no skipped checks; device operations used disposable test backends. |
| Python RTP media | 12 real aiortc tests passed with synthetic sources, without an Android device. |
| Default Chromium media | Real decoded synthetic video/audio, no SCTP and actual logout process cleanup passed with the Chromium sandbox enabled. |
| Linux SDK and empty AVD preparation | Official archives, SDK packages and tool versions passed; the normalized real AVD validated, cloned and was destroyed without booting an emulator. SDK protobuf compilation and worker checksum loading passed. |
| Real Linux Android device and internal audio | Not verified: the available Docker Linux VM has no `/dev/kvm`. |

Media compatibility checks used non-root containers, dropped capabilities,
no-new-privileges, a read-only source snapshot and an isolated internal network.
They did not disable the Chromium sandbox, use privileged mode, mount the
Docker socket, or expose emulator/ADB/gRPC ports. Installation downloaded the
fixed official sources separately into disposable private container storage.
No personal Android home, host ADB key, PulseAudio session or real phone was used.

The installed Linux SDK stack was command-line tools 22.0, Platform Tools
37.0.1, Emulator 37.2.13, Android 35 platform/image revision 2, Build Tools
35.0.0 and scrcpy 5.0.1. Doctor found the template and executable dependencies
available but correctly returned `ready:false` for absent KVM. Attempted
launcher setup failed before ADB or an emulator process was spawned.

A separate Ubuntu 24.04.2 x86_64 host also passed a real KVM ioctl probe
(`KVM_GET_API_VERSION` returned 12) from a non-root container with only
`/dev/kvm` mapped and its numeric device group added. SDK installation and
Android/media acceptance were not run on that host; this probe establishes
device access, not a working Android deployment.

Real SDK preparation exposed the SDK's generated `<temp>` writable-disk
placeholder. The installer now removes only confirmed generator placeholders
and validates the complete template through the existing strict provisioner
before reporting preparation success. Arbitrary external writable paths remain
rejected. Neither preparation nor a synthetic-media pass is a real device test.

## Host prerequisites

Use a non-root service account and an operator-selected private installation
directory. Install Node 22+, Java 17+, Python 3.11-3.14, and FFmpeg/ffprobe first.
Python 3.12 is recommended for the installer and optional WebRTC worker.
Ubuntu 22.04's default Python 3.10 does not meet this setup's requirements.
The offline test APK also needs a JDK/compiler, rather than just a JRE.

The installer does not run sudo, change group membership, chmod `/dev/kvm`,
install global packages, modify the shell, or accept SDK licenses implicitly.
An administrator must enable virtualization and grant the service account
access to the existing KVM character device. Verify using that account:

```sh
uname -m
ls -l /dev/kvm
test -r /dev/kvm && test -w /dev/kvm
```

If Linux itself runs inside a VM, the outer hypervisor must expose nested
virtualization. Merely installing a KVM package or seeing a device pathname is
not proof of acceleration: the SDK's `emulator -accel-check` must also succeed.
The launcher requires acceleration and will not silently fall back to slow
software CPU emulation. ARM Linux and Linux Qt desktop windows are outside this
version's supported setup; the phone remains visible through the web viewer.

GPU software rendering is distinct from software CPU emulation. The dedicated
headless template uses software graphics and still needs KVM for the Android
CPU. Missing shared libraries must be resolved using the distribution's
packages; an SDK binary reporting a missing `.so` is not a missing-KVM result.

## Explicit private installation

First review the fixed download sources and intended operations without
creating directories or contacting the network:

```sh
node scripts/setup-linux.cjs --root "$HOME/.local/share/agent-mobile-linux" --plan
```

Then explicitly accept the SDK terms and prepare the private installation:

```sh
node scripts/setup-linux.cjs \
  --root "$HOME/.local/share/agent-mobile-linux" \
  --accept-sdk-licenses
```

The bootstrap command-line tools and official scrcpy archive are fixed releases
with SHA-256 verification. SDK packages are obtained by the official sdkmanager;
the installed revisions are recorded rather than pretending that a moving
repository package is pinned. The installation contains its own SDK, Android
home, empty dedicated AVD, data directory, and configuration. It does not import
personal AVDs, accounts, host ADB keys or running disks. Existing unowned or
ambiguous installation directories are refused.

Setup uses a fresh empty directory and does not overwrite an existing
installation. A failed installation keeps its private status/diagnostics for
inspection; it does not automatically delete or repair that directory.

For the optional media worker, prepare its private venv and installed-SDK proto:

```sh
node scripts/setup-linux.cjs \
  --root "$HOME/.local/share/agent-mobile-linux" \
  --accept-sdk-licenses \
  --with-webrtc --python /usr/bin/python3.12
```

WebRTC remains disabled until the operator explicitly enables it in the
generated config. The worker uses only screen/audio gRPC methods, JWT-scoped
credentials and exact host-owned ICE addresses; see [WebRTC](webrtc.md).
No SDK installation, license acceptance or Python download occurs in `serve`.

The installation report uses `state:"prepared"` and `prerequisitesReady` for
host preparation. Its `ready` remains false because setup never boots a device
or performs real acceptance. Start only when prerequisites are ready and the
runtime doctor returns `ready:true`; then perform the real device acceptance.
Replace the config path if a different root was selected:

```sh
node bin/agent-mobile.cjs \
  --config "$HOME/.local/share/agent-mobile-linux/config.json" doctor
node bin/agent-mobile.cjs \
  --config "$HOME/.local/share/agent-mobile-linux/config.json" serve
```

The default operator listener stays at `127.0.0.1:7341`. Use the same config
for CLI lifecycle commands, MCP and the node's `AGENT_MOBILE_CONFIG` when
connecting paxd. An SSH-only host does not gain a browser by calling `open`;
do not print login codes or weaken the origin check to compensate.

## Audio and device acceptance

Linux audio is a separate acceptance item. The runtime deliberately does not
inherit a desktop user's PulseAudio/DBus session or microphone access. Do not
mount the host user's Pulse socket, home, or `/dev/snd` just to obtain a passing
test. If a deployment needs a sound backend, provision an isolated backend and
verify it using a known internal tone; do not reuse the user's session.

On an otherwise idle host, run the complete disposable lifecycle test and the
real browser/media test described in [acceptance.md](acceptance.md) and
[webrtc.md](webrtc.md). Verify PNG, UI XML, tracks, a non-silent known tone,
stop/destroy/replacement isolation, loopback-only gRPC, anonymous/wrong-method
JWT rejection, and actual media-process exit on logout. A successful ffprobe
track check alone does not establish audible audio.

## Docker and network namespaces

The Linux runtime can only use hardware acceleration in a container if the
Linux Docker host itself provides KVM and the container receives that specific
device. No privileged container or Docker socket is required by the runtime.
Passing a pathname on a host that lacks KVM does not create it.

The existing HTTP and WebRTC restrictions are defined inside a network
namespace. Container loopback is not host loopback. A published port does not
make a service bound to the container's `127.0.0.1` reachable through its eth0;
do not change the runtime listener to `0.0.0.0` as a workaround.

Prefer native Linux for the initial deployment. A container deployment needs
paxd and the runtime in the same controlled network namespace, or an explicitly
reviewed Linux host-network arrangement. Do not publish ADB, emulator console,
or gRPC ports. Host-browser WebRTC across a container boundary is not claimed
by the current same-host media policy. Pax's authenticated screenshots and
recording-file bridge is separate from remote WebRTC.

Docker Desktop on this Intel Mac was probed and its Linux VM has no `/dev/kvm`.
It can verify Linux Node/Python behavior; it cannot provide the missing real
Linux/KVM emulator acceptance. It is not a replacement for a Linux deployment
host with virtualization exposed.

## Primary references

- [Android Emulator acceleration and KVM](https://developer.android.com/studio/run/emulator-acceleration)
- [Android command-line tools downloads](https://developer.android.com/studio)
- [scrcpy 5.0.1 Linux release instructions](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/linux.md)
