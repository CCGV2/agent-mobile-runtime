# Real Android acceptance

The SDK was installed and real deployment checks were performed on 2026-11-10
on an Intel Mac using Hypervisor.Framework. No physical phone or personal account
was used. SDK/tools, dedicated templates and test credentials remain in private
runtime storage; installation did not change the global shell or system Java.

| Component | Tested version |
| --- | --- |
| Node / Python / existing JDK | 24.18.0 / 3.12 / Corretto 17.0.3 |
| SDK command-line tools / Platform Tools | 22.0 / 37.0.1 |
| Emulator | 37.2.13.0, build 16740729 |
| System image | AOSP Android 35 default x86_64, revision 2 |
| Platform / Build Tools | Android 35 revision 2 / 35.0.0 |
| scrcpy / FFmpeg | 5.0.1 / 6.1.1 |
| Media peer | aiortc 1.16.0, aioice 0.13.0, gRPC 1.85.1 |

Actual checks covered managed boot, Settings, PNG and UI XML; a screen recording
with both tracks and FFmpeg mean volume above -60 dB; graceful service
stop/restart; real JWT gRPC capture; and default Chrome showing 720×1280 video
with internal audio average power 0.01387 (about -18.6 dBFS). Logout confirmed the
media process exited. The real SDK rejected anonymous media calls, cross-method
JWT audiences and an unrelated RPC. Its media listener was observed only on
127.0.0.1, with private discovery/JWK permissions and no bearer-token fallback.

Pax audio file transfer also preserved a recognizable 440 Hz fixture tone.
The scrcpy `output` path was quieter: measured mean -47.63 dBFS, RMS 136 and
peak 196 in decoded 16-bit mono. This passes the existing -60 dB mean-volume
criterion, but an additional peak >256 check did not pass. It is not a claim of
equal gain across SDK and scrcpy capture routes or full audio-quality coverage.

The full disposable `test:emulator` check subsequently passed in **142.17 seconds,
exit 0, no skipped assertions**, with the host idle and only one VM running.
The tone APK was supplied: both media tracks and the -60 dB mean-volume assertion
passed. The first device was destroyed; a replacement booted and had no installed
fixture; then it was destroyed too. The temporary private runtime directory was
removed and its dedicated ADB/VM/gRPC listeners were closed. No runtime code or
assertion was changed to obtain this final single-VM pass.

The persistent demo uses the same retained device ID and was restored to Settings
with the fixture uninstalled and guest media volume at its original level. Earlier
resource contention produced a transient System UI ANR, which was dismissed and
checked absent. Multi-emulator performance under heavy host load and arbitrary
third-party App compatibility remain unverified.

Linux setup and compatibility verification are recorded separately in
[linux.md](linux.md). Linux SDK preparation, Node/Python tests and synthetic
Chromium media have been exercised in an isolated Linux container. That
environment has no KVM, so **real Linux emulator boot, lifecycle and internal
Android audio are not claimed as passed**. macOS acceptance above does not
substitute for that deployment-host check.

Repeat acceptance on the intended deployment host; unit/protocol tests alone
cannot prove that an actual emulator or its internal audio works.

1. Install Node 22+, Android SDK Emulator/Platform Tools, a host-compatible
   Android 13+ system image, scrcpy, FFmpeg/ffprobe. Verify hardware acceleration.
2. Create a dedicated clean AVD and keep it stopped. It may first complete OS
   initialization without any account or App data, then stop with confirmed
   process exit. Never copy live disks. The provisioner deliberately excludes
   snapshots and QCOW overlays; preparing a warmed baseline requires flattening
   the stopped data, encryption-key and SD-card overlays together into
   self-contained base images, preserving their original formats. Confirm that
   they have no backing-file dependency. Do not include personal accounts,
   links, snapshots or external writable data partitions.
3. Configure its `.avd` directory in a config copied from `examples/config.json`.
4. Run `node bin/agent-mobile.cjs --config /absolute/config.json doctor`.
5. Run the disposable lifecycle acceptance:

```sh
AGENT_MOBILE_TEST_CONFIG=/absolute/config.json npm run test:emulator
```

The test creates a temporary private runtime root, clones the configured
template, boots only its own AVD, launches Settings, reads XML/PNG, destroys it,
and boots a replacement to check that the installed fixture does not persist.
It does not use the normal service's data directory or a real phone. It uses
the configured private ADB/emulator ports; stop any conflicting test service
first. An occupied port fails instead of attaching to another device.

## Audible internal audio

For a complete recording test, build the offline fixture supplied in
`test/fixtures`. It plays a continuous 440 Hz media tone, has no Internet
permission, and uses only a disposable test signing key. Requires an existing
JDK, SDK platform 34+, stable Build Tools and `zip`:

```sh
ANDROID_SDK_ROOT=/absolute/Android/sdk node test/fixtures/build.cjs
AGENT_MOBILE_TEST_CONFIG=/absolute/config.json \
AGENT_MOBILE_TEST_AUDIO_APK=/absolute/agent-mobile-runtime/test/fixtures/build/tone.apk \
npm run test:emulator
```

This installs only the test APK into the private device, starts a five-second
screen+internal-audio recording, launches the tone App, verifies both media
tracks, and runs FFmpeg volume analysis (mean volume must exceed -60 dB).
Without `AGENT_MOBILE_TEST_AUDIO_APK`, the test explicitly reports that audible
capture was not tested. Real app compatibility must still be checked separately.

If cleanup cannot confirm emulator termination, the temporary directory is
retained and reported for manual recovery; it is never recursively removed
under a possibly live emulator. Record emulator/scrcpy versions, host/architecture,
image API/ABI and acceptance output before claiming deployment support.
