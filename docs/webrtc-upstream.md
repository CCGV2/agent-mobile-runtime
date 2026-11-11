# Media-only WebRTC and upstream boundary

The emulator provides real-time image/audio gRPC streams. This runtime relays
those streams through an owned `aiortc` peer instead of exposing the emulator's
built-in WebRTC peer directly to the browser. The Python worker is a private
stdin/stdout child process and has no HTTP/WebSocket listener.

## Why the upstream demo is not launched wholesale

The Google emulator WebRTC demo is useful for protocol research and UI
reference. Its example gateway is not this runtime's authenticated local
operator service. More importantly, the built-in emulator RTC peer has a wider
control surface and different lifetime from its signaling connection:

- The v2 `Rtc` service exposes `RequestRtcStream`, `SendJsepMessage`,
  `ReceiveJsepMessageStream` and deprecated `ReceiveJsepMessage`; there is no
  close/delete/read-only RPC.
- Canceling `ReceiveJsepMessageStream` exits the message-reading loop; it does
  not call the media bridge's disconnect function.
- `Participant::IncomingMessage` handles candidate/start/SDP messages; sending
  `bye` is not a server-side close operation in the inspected source.
- `Participant::Initialize` creates mouse, keyboard, touch **and ADB** data
  channels. Hiding controls in a page does not remove those capabilities.

Pinned primary sources inspected:

- [aemu v2 RTC contract, f66f2331258c29208b0dbadaacdc96f44f328ae0](https://android.googlesource.com/platform/hardware/google/aemu/+/f66f2331258c29208b0dbadaacdc96f44f328ae0/protos/services/webrtc/rtc_service_v2.proto)
- [QEMU RtcServiceV2, e26e03e3aefbc827e6b4e030c14fe3ce11946d54](https://android.googlesource.com/platform/external/qemu/+/e26e03e3aefbc827e6b4e030c14fe3ce11946d54/android/android-webrtc/android-webrtc/android/emulation/control/RtcServiceV2.cpp)
- [QEMU Participant at the same commit](https://android.googlesource.com/platform/external/qemu/+/e26e03e3aefbc827e6b4e030c14fe3ce11946d54/android/android-webrtc/android-webrtc/emulator/webrtc/Participant.cpp)
- [QEMU Switchboard at the same commit](https://android.googlesource.com/platform/external/qemu/+/e26e03e3aefbc827e6b4e030c14fe3ce11946d54/android/android-webrtc/android-webrtc/emulator/webrtc/Switchboard.cpp)
- [Image/audio contract at the pinned aemu commit](https://android.googlesource.com/platform/hardware/google/aemu/+/f66f2331258c29208b0dbadaacdc96f44f328ae0/protos/services/emulator-controller/emulator_controller.proto)

Those sources inform the design. Setup compiles the **installed SDK's**
`emulator/lib/emulator_controller.proto`; it does not assume a future SDK is wire
compatible with an arbitrary main branch. The generated Python files and SDK
proto SHA-256 are recorded; workers reject modified generated files.

Actual SDK startup requires another detail: explicit console `-port` suppresses
automatic gRPC initialization. This runtime supplies a fixed `-grpc` port only
together with `-grpc-use-jwt` and the narrow policy. The authenticated builder
forces loopback, preferring IPv4 on the tested SDK. Bare `-grpc` remains unsafe.
The actual 37.2.13 process was observed listening only at `127.0.0.1:8554` for
console 5554; both anonymous media RPCs were rejected. Relevant primary sources:

- [Console port argument handling](https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/android-qemu2-glue/main.cpp)
- [Conditional gRPC initialization](https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/android-qemu2-glue/qemu-setup.cpp)
- [JWT forces local credentials and loopback binding](https://android.googlesource.com/platform/external/qemu/+/refs/heads/emu-master-dev/android/android-grpc/services-stack/src/android/emulation/control/GrpcServices.cpp)

## Explicit setup

No Python packages are installed by `serve`, `open` or an Agent tool. An operator
can run the following after installing an SDK whose emulator ships the proto:

```sh
node scripts/setup-webrtc.cjs --config /absolute/config.json \
  --python /usr/local/bin/python3.12
```

This creates a private venv and generated proto directory under
`DATA/webrtc`. It prints `pythonPath` and `protoDir` for local WebRTC
configuration. Direct dependencies are pinned in `webrtc/requirements.txt`, and
setup uses the full version set in `webrtc/requirements.lock` with binary wheels
only. `--sdk`
and `--output` override absolute SDK/output paths. An already prepared Python
environment can be used with `--skip-install`. Stop the service while replacing
generated protocol code or dependencies.

## Worker protocol and media

The parent launches `webrtc/worker.py` with fixed nonsecret arguments:
`--proto-dir`, a loopback-only `--grpc-address`, bounded `--width`, `--height`,
`--fps`, and `--max-lifetime` (at most 600 seconds). Initial private NDJSON is:

```json
{"type":"start","offer":"COMPLETE SDP OFFER","authorization":{"streamScreenshot":"Bearer METHOD_SCOPED_JWT","streamAudio":"Bearer METHOD_SCOPED_JWT"}}
```

Only one initial offer is accepted, followed only by `{"type":"close"}` or
EOF. No trickle candidates, renegotiation, incoming media, datachannels or
commands are supported. Credentials are supplied over stdin, never in argv,
HTML or logs. Responses are an SDP `answer`, `ready`, bounded connection state,
`closed`, or sanitized error codes.

The worker calls only `EmulatorController.streamScreenshot` (PNG, bounded main
display size) and `EmulatorController.streamAudio` (48 kHz, stereo, little-endian
signed 16-bit samples). Video retains only the latest frame; audio retains at
most 200 ms. It encodes outgoing RTP via aiortc. Parent lease expiry, process
termination, stdin EOF and explicit close terminate the owned peer, closing its
RTP sockets and authenticated source streams. The worker independently enforces
its maximum lifetime. Authorization must also be enforced in the parent before
launching or forwarding SDP.

## Local ICE policy

There are no STUN/TURN servers. Both peers must be on the same host. Candidates
are UDP host candidates only, component 1, with ports 32768–65535, and addresses
must exactly match an IP assigned to this machine (or loopback). TCP, relay,
server-reflexive, peer-reflexive and arbitrary host candidates in SDP are rejected.
Chrome commonly masks local addresses using UUID mDNS names. The parent expands
only that strict name form to the existing exact host IP allowlist, retaining
the validated high port and transport fields. Expansion is deduplicated and
the final SDP remains capped at 32 candidates. No DNS/mDNS query is sent and no
extra resolver port is opened. The worker accepts numeric addresses only.

SDP validation alone cannot enforce the network boundary: ICE can learn a
peer-reflexive destination from authenticated incoming STUN. The worker therefore
guards every actual UDP source and destination before STUN/DTLS/RTP/RTCP handling.
Only exact host-owned numeric IPs and high ports pass. This adapter is gated on
the reviewed aiortc/aioice versions; replacing them requires another review.

Literal loopback-only candidates do not work in ordinary Chrome/aiortc: browsers
usually advertise host interfaces/mDNS and aioice excludes loopback during
enumeration. This host-owned-address policy allows local playback without
turning signaling into a general network probe. It is not remote/Pax media
transport and does not install a guest or host firewall.

## Verification

`python3 test/webrtc-worker.test.py` runs policy tests with stdlib only. When the
pinned dependencies are installed, an additional synthetic audio/video peer test
negotiates two real aiortc peers on the same host and checks closure; it does not
require an Android SDK. It is not evidence that a real emulator produces usable
audio/video, which still needs separate SDK acceptance on the deployment host.
