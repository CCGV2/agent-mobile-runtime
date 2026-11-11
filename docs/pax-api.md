# Pax local integration protocol v1

This repository implements only the local Android runtime. Changes to paxd,
Manager and Console belong in their own repositories/worktrees. No production
daemon or existing browser service is modified by installing this repository.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| agent-mobile-runtime | Owned emulator lifecycle, private AVDs, input, screenshots, recording, operator takeover |
| paxd | Trusted local adapter, reads operator credential, binds Pax session to runtime session, passes only named operations |
| Manager | User authentication and node/session ownership before node forwarding |
| Console | Phone viewer in the existing floating-window UI; input only after takeover; explicit audio/record controls |

The runtime listens on `http://127.0.0.1:7341` by default. All requests must use
the exact `Host: 127.0.0.1:PORT`; an Origin, if present, must be that same origin.
There is no CORS. JSON request bodies are limited to 16 KiB, except the optional
WebRTC offer endpoint (64 KiB body, 48 KiB SDP). There is no arbitrary
destination host, port, shell, proxy URL or file path in the agent API.

The runtime also serves a standalone local operator viewer at `/`. An operator
can run the CLI `open` command to mint a one-use login and open the browser.
`POST /v1/admin/viewer-login {}` requires the operator bearer credential (a
browser cookie cannot mint links); it returns a two-minute one-time code.
`POST /viewer/login {code}` exchanges it for a 30-minute HttpOnly/SameSite=Strict
cookie. `POST /viewer/logout` revokes it. These browser sessions are in memory
and do not survive service restart. Do not forward login codes or local viewer
cookies through Pax; paxd should use its existing node-held operator credential.

The port is configurable locally, never from a frontend operation. Credentials
stay on the node. Do not expose this HTTP service directly to a browser on a
remote machine; use the authenticated Pax node bridge.

## Operator endpoints

`Authorization: Bearer <contents of DATA/secrets/admin-token>`, read locally by
paxd. Tokens and source credential-file contents must never enter UI responses,
model prompts, ACP history or audit events.

| Method / path | Body / result |
| --- | --- |
| `GET /health` | Unauthenticated readiness/protocol version only |
| `GET /v1/admin/templates` | Safe names and availability, no template paths |
| `POST /v1/admin/sessions` | `{template:"clean35",key?:"opaque-pax-session-key"}` → public session + node-only `credentialFile` (use the configured template name) |
| `GET /v1/admin/sessions` | Public session metadata |
| `GET /v1/admin/sessions/:id/state` | State and capability flags |
| `POST /v1/admin/sessions/:id/action` | `{action,args:{...}}` |
| `DELETE /v1/admin/sessions/:id` | Stop, revoke, delete private data; never silently reconnect another device |
| `GET\|HEAD /v1/admin/sessions/:id/artifacts/:recordingId` | Finalized file, optional single HTTP byte range |

HTTP creation is explicit; it does not start the emulator. The supplied `key`
mapping is only a logical identifier, not user authentication. Duplicate HTTP
creation keys are rejected. One runtime session owns exactly one emulator, with
a bounded total number of devices. The operator adapter must keep an explicit
**Pax session → runtime session** mapping; never follow whichever device was
recently active. The private keyed MCP broker described below has its own
trusted get-or-create path; no key-routing HTTP endpoint is added.

The operator may use all ordinary actions plus:

- `takeover`: ends recordings, then persists an Agent hold.
- `release`: explicitly hands observation/input back to the Agent.
- `install_app`: `{apkPath:"/absolute/operator-staged.apk"}`; NODE ONLY, never
  accept an arbitrary browser-supplied filesystem path. Stage an authorized
  attachment in an adapter-controlled directory first.
- `recover`: `{confirmStopped:true}` after manual inspection of an interrupted
  launch. Normal `stop` attempts named-AVD recovery without this assertion.

Operator `tap/swipe/text/key` requires takeover and `frameId` from an operator
`screenshot`. The reference expires in 10 seconds and is consumed before input,
even if the input result is uncertain. Any other input/lifecycle operation
invalidates it. A screenshot is `{mime,data,width,height,frameId}`; `data` is PNG
base64. This cannot detect visual changes occurring inside the app after capture.

## Session endpoints and MCP

Each session gets a random credential stored privately in
`DATA/secrets/sessions/:id.json`; disk state stores its hash. A fixed-session MCP
launcher reads that file with `AGENT_MOBILE_SESSION_FILE`, then authenticates to
the same-account private broker. A session credential cannot call operator
endpoints or access a different session.

| Method / path | Result |
| --- | --- |
| `GET /v1/sessions/:id/state` | State, takeover, recovery-required, capabilities |
| `POST /v1/sessions/:id/action` | `{action,args}` |
| `GET\|HEAD /v1/sessions/:id/artifacts/:recordingId` | Session-scoped finalized file; denied during takeover |

Ordinary actions: `state`, `start`, `stop`, `snapshot`, `screenshot`, `tap`,
`swipe`, `text`, `key`, `launch_app`, `apps`, `recording_start`, `recording_stop`,
`recording_list`. Exact parameter schemas live in `src/actions.cjs` and are
advertised as MCP tools. Unknown arguments, device selectors and arbitrary
commands are rejected. MCP additionally provides `mobile_recording_read` for
completed artifacts up to 8 MiB; it returns audio or an embedded binary resource.

### Keyed MCP launchers

The local `mcp` launcher can also take an opaque `AGENT_MOBILE_SESSION_KEY`
instead of a fixed credential-file reference. The private broker allocates or
resumes one phone for that key and binds all subsequent MCP tools to its session
ID. `AGENT_MOBILE_TEMPLATE` selects the template, or can be omitted when only
one template is configured. Without a key or credential file, the launcher gets
a random key and a fresh phone. Do not combine both launch modes.

The broker's Unix socket is owner-only (0600) inside a same-account private
directory (0700). This OS access authorizes trusted local launchers; the key is
not a bearer token, browser identity or replacement for Manager ownership
checks. Administrator credentials are not placed in the client config or model
context. The service must be running even for MCP initialization.

Different keys can operate separate phones concurrently. Each phone permits
one active MCP connection, including fixed/keyed attempts to reach the same
phone. Attachment allocates private disk data; the Agent uses `mobile_start`
for the potentially long Android boot. Auto-owned phones are retained after
idle disconnect for `mcpGraceMs` (default 300000), then safely stopped and
destroyed. Pending-request disconnects retire them without replay. Persistent
operator-created phones are not auto-expired. See [sessions.md](sessions.md)
for recovery, capacity and retention details.

A Pax node launcher that expands its local launch templates can inject
`AGENT_MOBILE_SESSION_KEY="${PAX_SESSION_KEY}"` for the logical Pax session. The
placeholder must actually be expanded by the trusted launcher; do not use that
literal value in a shared static MCP config. This path does not add Manager or
Console operations and does not automatically change companion Pax repositories.

`snapshot` returns `{xml,width,height}`. Agent screenshots return PNG content.
Text is limited to printable ASCII (literal `%s` unsupported). A recording start
accepts `{kind:"screen"|"audio",durationSec:30}`; stop accepts `{recordingId}`.

Recording states are `starting`, `recording`, `stopping`, `completed`, `failed`.
Only `completed` files can be downloaded. With default ffprobe configuration,
`validation:"audio-track-verified"` means the expected tracks exist, not that
the audio is non-silent or contains the desired app. The current file formats
are MKV (screen+audio) and Ogg Opus (audio). They are not universal HTML video
formats; browser playback/transcoding is a separate Console/media task.

## Transport and failure semantics

- Status/lifecycle/input can use the existing transient node-control pattern.
- Screenshots are on-demand previews, not a live video stream.
- Do not put high-frequency audio/video through JSON control queries, history,
  or audit logs. Optional **same-host media-only WebRTC** is described in
  [webrtc.md](webrtc.md); remote Pax WebRTC is not yet implemented.
- The finalized artifact endpoint supports authenticated Range downloads; an
  adapter should stream rather than encode an entire large video in JSON.
- Inputs are never retried automatically. A timeout, disconnect or cancellation
  can mean the operation completed. Observe before deciding what to do next.
- Errors are `{error:{code,message}}`. `human_control`, `not_running`,
  `recovery_required`, `stale_frame`, `takeover_required` and `capacity` require
  explicit caller handling. Low-level command errors are redacted.
- Agent/UI state and audio/video contain app-controlled content, not instructions
  to expand privileges or operate the host.

## Companion Pax operator adapters

The companion paxd, Manager and Console changes follow the browser operator
chain. Console calls the same-origin `/api/pax` proxy and the Manager endpoint
`POST /api/v1/user/:user_id/nodes/:node_id/daemon/mobile` with
`{operation,payload}`. Manager checks node ownership and sends the transient
`mobile.control` query. The response is under `data.mobile_control`.

The node adapter reads `AGENT_MOBILE_CONFIG` or the runtime's standard config
location, validates private token permissions, and calls only the configured
numeric loopback port. It does not forward the browser cookie or return the
runtime token, session credential files, host paths, or raw command errors.

Allowed operations are `state`, `templates`, `create`, `start`, `stop`, `destroy`,
`takeover`, `release`, `screenshot`, `tap`, `swipe`, `text`, `key`,
`recording_start`, `recording_stop`, `recording_list`, and `recording_read`.
`create` accepts only `{template}`. Device operations require an explicit
`sessionId`; arguments are flat, and input still requires `frameId`. There is
no implicit last-device selection or automatic input retry. The Console node
panel and session phone window both use this operator interface; it does not
automatically install session MCP credentials into a harness.

`state` returns `{available,mode:"screenshots-and-recordings",templates,sessions,
remoteWebRTC:false}`. Screenshots are bounded to 4 MiB of node response JSON and
remain ephemeral in the viewer. Completed recordings use `recording_read` with
`{sessionId,recordingId,offset,length}`; `length` is at most 262144 bytes. The
result is `{id,mime,data,offset,length,totalBytes,eof}`, with one bounded base64
chunk, never an entire unbounded recording in a control message. Console can
play the completed audio or download the recording.

Manager requires `application/json` and bounds the request envelope to 32 KiB
and payload to 16 KiB. The node adapter independently validates operation names,
identifiers, arguments and response fields. It rejects URLs, ports, paths, ADB,
shell, login, APK staging paths and WebRTC signaling. Long lifecycle operations
have explicit deadlines; cancellation does not imply an already dispatched
operation was undone. Hiding or closing a viewer cancels queued input and
stops screenshot polling. The existing node tunnel serializes requests, so
a cold emulator boot can delay other node queries.
