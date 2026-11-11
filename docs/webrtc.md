# Restricted local WebRTC

The viewer can receive continuous screen video and internal audio from a managed
Android emulator. This version deliberately supports **same-host viewing only**.
It does not enable public/LAN browser access, STUN, TURN, or a generic gateway.
Pax's remote media relay is a separate integration and is not implemented here.

## Architecture and security decisions

```text
authenticated local viewer -- bounded HTTP offer/answer --> runtime on 127.0.0.1
        |                                                  |
        | DTLS/SRTP audio/video                  private stdin/stdout
        |                                                  |
        +---------------------------- per-lease Python media process
                                                           |
                                            authenticated loopback gRPC
                                                           |
                                            owned Android emulator
```

We do not run Google's sample HTTP gateway, expose arbitrary emulator gRPC, or
use the emulator's native `Rtc` service. The pinned upstream source exposes
input/ADB data channels without a reliable per-peer revoke RPC; see
[the source review](webrtc-upstream.md). Instead the media process uses aiortc
and calls only `streamScreenshot` and `streamAudio`. Mouse, keyboard and other
device control remain on the existing frame-bound, serialized HTTP action API.

Boundary enforcement:

- WebRTC is disabled by default and requires explicit operator configuration.
- The existing control HTTP listener stays on exact `127.0.0.1:PORT` with no CORS.
  Browser media requests require a live operator cookie **and exact Origin**;
  the node-held operator bearer is available for a future trusted Pax adapter.
  Agent/MCP session credentials cannot open media peers.
- Every lease is bound to one runtime session and exact browser login identity.
  At most one peer per device; the total cannot exceed the configured device cap.
- Client JSON contains only a complete receive-only audio/video SDP. It cannot
  choose a host, port, gRPC method, discovery file, ICE server, token or process.
- SDP size, media count, codecs, DTLS fingerprints and ICE fields are checked.
  SCTP/data channels, incoming media, renegotiation, ICE restarts, remote hosts,
  related addresses, TCP candidates and non-host candidates are rejected.
- Only exact addresses assigned to the runtime host are accepted, with UDP
  ports 32768–65535. A browser's UUID mDNS candidate is expanded to a bounded,
  deduplicated set of those exact host addresses before reaching the media
  library. This does not resolve client names, contact DNS/mDNS or open port
  5353; it cannot introduce destinations outside the existing host allowlist.
  Both Node and Python independently validate SDP, with at most 32 candidates
  after expansion and BUNDLE normalization.
- Every actual UDP packet also passes a source/destination check for an exact
  host-owned IP and high port. This includes ICE peer-reflexive discovery, which
  can otherwise introduce a new destination after SDP validation. The reviewed
  aiortc/aioice versions are pinned; an unreviewed version fails closed.
- ICE servers are empty. No hidden fallback to public Google STUN/TURN is used.
  This policy can fail on some browser/network configurations; it fails closed
  and leaves the screenshot preview available.
- The Python process has no HTTP/control listener and no client-provided code.
  It creates authenticated DTLS/SRTP UDP sockets for media; this is not an OS
  firewall. Initial media is muted and browser mic/camera permissions are denied.
- Emulator gRPC uses a fixed port (`console port + 3000`) with both `-grpc` and
  `-grpc-use-jwt`, plus a runtime-owned policy granting only the two media RPCs.
  The JWT mode forces the SDK listener to loopback; bare `-grpc` is forbidden.
  An explicit console `-port` otherwise suppresses automatic gRPC startup. Only
  numeric `127.0.0.1` and `::1` at that fixed port are probed. Discovery verifies the owned
  process, AVD, ports and private paths. ES256 private keys stay in memory; the
  public JWK must be acknowledged before a 60-second method-scoped JWT is used.
  The emulator inherits umask 0077 for its discovery/key files; the SDK's Tink
  validator requires omitting the optional JWT `typ` header.
- Credentials travel only over private parent/child pipes, not argv, URLs,
  browser state or logs. SDK proto files are compiled locally and checksummed.
- Default leases expire in 30 seconds unless renewed; a peer lasts at most ten
  minutes. Logout and login replacement invalidate the old identity before
  awaiting teardown, preventing concurrent opens during revocation. Identity
  expiry, takeover/release, device stop/destroy,
  emulator exit and runtime shutdown revoke the media process. The process
  receives EOF/SIGTERM, then SIGKILL if necessary; confirmed exit is required.
  Merely closing signaling or expiring a JWT is not counted as revocation.
- If process exit cannot be confirmed, the lease reservation remains and the
  operation fails. Release does not clear the existing human hold, and destroy
  does not remove device data. Revocation attempts continue for other peers.

Previously received data cannot be retracted. Same-user host shell access can
bypass local credentials. This feature is not a malware sandbox or a guarantee
against vulnerabilities in the emulator, codecs, Python dependencies or OS.

## Setup

Install the Android SDK and create a clean template first. Then explicitly
prepare the Python environment and compile the **installed emulator's** proto:

```sh
node scripts/setup-webrtc.cjs --config /absolute/config.json --python /absolute/python3.12
```

The setup tool prints `pythonPath` and `protoDir`, not credentials. Use them in
the config (replace the example paths):

```json
{
  "webrtc": {
    "enabled": true,
    "pythonPath": "/private/runtime-data/webrtc/venv/bin/python",
    "protoDir": "/private/runtime-data/webrtc/proto",
    "leaseSeconds": 30,
    "maxLifetimeSeconds": 600,
    "maxWidth": 720,
    "maxHeight": 1280,
    "fps": 15
  }
}
```

Run `doctor`, restart the runtime and restart the managed emulator so the narrow
gRPC launch policy applies. In the local viewer choose **实时预览**, then
**打开声音** if desired. Closing or hiding the page closes the local peer and
requests server revocation; the server's lease handles uncooperative clients.

No packages, licenses or SDK binaries are installed automatically by `serve`.
Record the deployed SDK and dependency versions. SDK discovery or JWT policy
differences produce an explicit failure rather than unauthenticated fallback.

## Local API

Operator-authenticated, session-bound routes:

| Route | JSON |
| --- | --- |
| `POST /v1/admin/sessions/:session/live` | `{offer:"complete SDP"}` |
| `POST /v1/admin/sessions/:session/live/:lease/renew` | `{}` |
| `POST /v1/admin/sessions/:session/live/:lease/close` | `{}` |

Open returns `{id,sessionId,answer:{type:"answer",sdp},expiresAt,hardExpiresAt,
mode:"local-media-only"}`. IDs are not credentials. There is no trickle-candidate,
arbitrary signal, URL proxy or native `Rtc` endpoint. The initial JSON body is
capped at 64 KiB; all other control bodies remain capped at 16 KiB. Neither raw
SDP nor credentials are recorded in the audit log.

## Validation

```sh
npm test
/absolute/webrtc/venv/bin/python test/webrtc-worker.test.py
AGENT_MOBILE_WEBRTC_PYTHON=/absolute/webrtc/venv/bin/python \
AGENT_MOBILE_PLAYWRIGHT_MODULE=/absolute/project-with-playwright/package.json \
AGENT_MOBILE_CHROME=/absolute/ChromeExecutable \
npm run test:webrtc
```

Node tests exercise policy, authorization and lifecycle with disposable test
processes. Python tests use real aiortc peers and synthetic video/tone audio,
including socket cleanup. The opt-in Chrome test traverses the authenticated
HTTP interface and actual media worker in default Chrome, verifies decoded video,
non-silent audio and no SCTP, and checks that logout reaps the media process.
Synthetic sources alone do not prove Android gRPC capture. The actual Intel Mac
SDK acceptance now covers decoded 720×1280 video and known internal audio in
default Chrome: average audio power 0.01387 (about -18.6 dBFS), no SCTP, and
confirmed worker exit on logout. Anonymous media calls, a wrong-method audience,
and an unrelated RPC were rejected by the real emulator. See
[the deployment acceptance record](acceptance.md) for exact versions, scope,
recording level differences, the successful full lifecycle check, and limits of
multi-VM testing under heavy host load.

The real SDK/browser check can be repeated on an otherwise idle deployment host:

```sh
AGENT_MOBILE_TEST_CONFIG=/absolute/private-acceptance-config.json \
AGENT_MOBILE_TEST_AUDIO_APK=/absolute/tone.apk \
AGENT_MOBILE_PLAYWRIGHT_MODULE=/absolute/project-with-playwright/package.json \
AGENT_MOBILE_CHROME=/absolute/ChromeExecutable \
npm run test:webrtc:emulator
```
