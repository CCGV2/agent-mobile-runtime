# Security boundary

This runtime isolates ordinary third-party Android apps from the user's normal
phone data. It is not a malware analysis sandbox or proof of hypervisor security.

## Implemented boundaries

- Explicit, operator-selected templates; private device, SD-card and artifact data.
- Templates are trusted operator input and must contain no personal accounts.
- No inherited host credentials in emulator/scrcpy subprocess environments; real
  host microphone and camera integrations disabled in managed AVD configuration.
- Managed emulator IDs and exact AVD-name verification for ADB UI operations;
  no real-device discovery, arbitrary shell, URLs, or filesystem tools for agents.
- Loopback-only authenticated API, strict Host/Origin checks, bounded request
  bodies, generated artifact names and separate operator/session credentials.
- Local viewer uses a bearer-authenticated, two-minute one-use login link and a
  30-minute HttpOnly/SameSite=Strict cookie. The long-lived operator credential is
  never embedded in HTML/JavaScript or stored in browser storage. Browser code
  removes the login fragment before exchanging it. Service restart revokes web
  sessions. The viewer is an operator surface, not an Agent tool.
- Device input is serialized. No automatic retries of uncertain side effects.
- MCP attaches through an owner-only Unix socket in a private same-account
  directory. Session keys route trusted local launchers; they are not passwords
  or multi-user identity. Fixed-session credentials remain authenticated, and
  generated client entries contain no administrator token.
- Only one MCP connection can own a phone at a time, across keyed and fixed
  launch modes. Idle auto-owned phones are reclaimed after a bounded grace
  period. A disconnect during dispatched work retires the auto-owned phone;
  cleanup must confirm termination before deletion or replacement. Operator-
  created phones remain persistent. See [session semantics](docs/sessions.md).
- Operator takeover blocks subsequent agent observations and input and stops
  recording. In-flight transfers/previously returned data cannot be retracted.
- Destruction revokes the session credential and deletes its private device tree.
- Recorded PIDs are only checked for liveness, never used as signal authority.

## Not provided

- **Host/LAN network isolation.** A guest can access reachable network services,
  including the emulator's host alias. App package checks are not a firewall.
- **Isolation from same-user host shell access.** A host agent with filesystem
  access can read tokens or call ADB directly. For that threat model run this
  service under another OS account or on a dedicated remote host, with restricted
  tool access and an authenticated, narrow node bridge.
- **Cloud account isolation.** Signing into an account exposes whatever the app
  can access from that account. Deleting a device does not undo external actions.
- Tamper-proof auditing, guaranteed secure erasure, encrypted artifact storage,
  OS-enforced resource quotas, or protection from emulator/hypervisor exploits.
- Stop/revoke cannot undo an already-dispatched input or reclaim returned media.

## Optional WebRTC

See [docs/webrtc.md](docs/webrtc.md) for the enforced boundary. This is a
same-host, outgoing-media-only peer, disabled by default. It exposes neither
Google's sample gateway nor the emulator's native RTC/data/ADB channels.
Browser SDP and actual UDP source/destination addresses are restricted to exact
host-owned IPs and high ports. No ICE servers or remote relay are configured;
peer lifetime is tied to operator identity and device lifecycle. Actual
child-process exit is required on revocation. UDP media
sockets still exist and depend on DTLS/SRTP and the pinned media stack; these
checks are not an OS network firewall or protection from same-user shell access.

Do not publish the control port, emulator console, ADB port, data directory or
credential files, or forward the private MCP socket to untrusted users. A Pax
bridge must enforce node ownership and a fixed
operation allowlist; it must not be an arbitrary local network proxy. The API
alone is not a multi-user identity service.

Keep SDK, emulator, scrcpy, Node and FFmpeg updated and record the versions used
for real acceptance. Do not submit credentials, app data, recordings or private
screenshots in public vulnerability reports.
