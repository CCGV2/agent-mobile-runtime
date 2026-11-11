# Session keys, concurrency and reconnects

The trusted local MCP launcher can allocate or resume a private Android phone
by logical session key. Different keys get independent AVD data, Android app
state, ports, credentials and recordings. Different phones can operate
concurrently; commands for one phone are serialized.

## Start a keyed MCP connection

Keep the runtime service running using its explicit config. Generate the MCP
entry without a session ID:

```sh
node bin/agent-mobile.cjs --config /absolute/config.json mcp-config --template clean35
```

Merge that entry into the client. It contains absolute executable/config paths
and no credential contents. It does not create a phone at generation time.
The trusted launcher sets the following environment when launching MCP:

| Variable | Meaning |
| --- | --- |
| `AGENT_MOBILE_SESSION_KEY` | Optional opaque logical-task identifier, at most 200 characters. The same key resumes the same retained phone. |
| `AGENT_MOBILE_TEMPLATE` | Template name, such as `clean35`; optional when exactly one template is configured. A retained key cannot be attached using a different template. |
| `AGENT_MOBILE_SESSION_FILE` | Alternative fixed-session mode for an operator-created credential file. Do not combine it with session-key mode. |

For example, two independent launchers can use `task-a` and `task-b` as their
keys. Do not set one constant key in a global config used by every Agent.
Without a key or fixed credential file, each connection gets a random key and
a new phone. Restarting such a client creates a fresh phone rather than
resuming the old one.

The [`examples/mcp-keyed.json`](../examples/mcp-keyed.json) fragment intentionally
contains no globally fixed key. A launcher must inject the logical task's key
for reconnect behavior. Do not treat app text or model-provided tool arguments
as launch identity.

Attachment allocates a clean private AVD but does not boot Android during MCP
initialization. The Agent calls `mobile_state`, then `mobile_start` if needed,
then normal screenshot/UI/app tools. APK installation remains an operator
CLI/API action. There is no model-facing tool for choosing another key or phone.

## Exclusivity and disconnect behavior

Only one MCP connection can be active for a phone. A duplicate attachment is
rejected clearly; it cannot silently take over the existing connection. This
also applies when one connection uses a key and another uses that phone's fixed
credential file. Operator HTTP/viewer controls remain available, including
human takeover.

| Event | Auto-owned phone created by keyed MCP | Operator-created phone |
| --- | --- | --- |
| Idle disconnect | Retain for `mcpGraceMs`, then safely stop and destroy. | Preserve the phone and its data. |
| Same key reconnects during retention | Cancel expiry and resume the same phone/App state. | Reuse the explicitly mapped phone. |
| Disconnect with a tool request in flight | Retire the phone, wait for the dispatched work and confirmed cleanup, then remove it; never replay the request. | Preserve the phone; keep its MCP claim until dispatched work settles. Inspect state before continuing. |
| Cleanup cannot confirm termination | Keep the session fenced and retain its data for operator recovery. | Existing ownership/recovery rules apply. |
| Retention ends successfully | Destroy the device, revoke its credential and delete its recordings; later use of the key gets a fresh phone. | No automatic expiry. |

An in-flight operation can have completed even if the client did not receive a
result. Retirement is not an undo operation. Do not retry uncertain input
automatically or bypass a retiring/failed-cleanup fence.

The default `mcpGraceMs` is `300000` (five minutes), configurable locally from
0 to 3600000 milliseconds. Setting it to zero removes idle auto-owned phones
as soon as safe cleanup can complete. This policy applies to broker-managed
phones, not every device with a logical key: ordinary operator `session create
--key ...` creates a persistent phone.

The service persists managed-phone identity. After a service restart,
retention timers are restored for inactive managed phones. A previously
interrupted VM still requires the normal operator recovery checks; saved PIDs
are never used as signal authority. A service that is not running cannot carry
out cleanup, and this retention behavior is not a guarantee of deletion at an
exact wall-clock deadline across downtime.

## Capacity

Fresh setup configs allow two stored phones by default; the supported
`maxDevices` range is 1–8. Existing configs are not modified. If an older install
has `maxDevices:1`, change it to the intended concurrency limit before starting
the service.

Every stored phone counts, including stopped persistent phones and auto-owned
phones waiting for their grace period or safe cleanup. Capacity errors do not
attach a new task to someone else's phone. Use `session list` or the operator
viewer to inspect device IDs and explicitly remove an unused task-owned phone
when appropriate.

Per-key isolation and lifecycle behavior can be verified with protocol/unit
tests. The configured limit is not a claim that eight real emulators have
passed hardware or performance acceptance on every host. Linux and macOS ARM
real-device/media acceptance remain outside the current verified scope.

## Fixed-session compatibility

Existing operator workflows remain available:

```sh
node bin/agent-mobile.cjs --config /absolute/config.json session create --template clean35 --key persistent-task
node bin/agent-mobile.cjs --config /absolute/config.json mcp-config SESSION_ID
```

Replace `SESSION_ID` with the returned ID. The generated entry references its
private `credentialFile`, rather than putting a token into the config or prompt.
The fixed launcher authenticates that credential through the same private
broker and receives the same one-active-MCP-connection protection. The service
must be running even for initialization.

An operator-created phone can also be found through its existing logical key;
it stays operator-owned and does not gain automatic expiry merely because a
keyed MCP connection attached to it. Duplicate ordinary HTTP `session create`
requests still fail; keyed get-or-create happens inside the trusted local MCP
broker, not through a new public key-routing endpoint.

## Pax launch templates

For a node launcher that supports `${PAX_SESSION_KEY}` expansion, the optional
environment template can include:

```json
{
  "AGENT_MOBILE_SESSION_KEY": "${PAX_SESSION_KEY}",
  "AGENT_MOBILE_TEMPLATE": "clean35"
}
```

Use this only where the trusted launcher actually expands the placeholder.
Pasting it literally into an ordinary static client config would give every
connection the same key. Do not pass the key through a browser request as
identity or replace Pax user/node ownership checks with it.

The operator bridge described in [pax-api.md](pax-api.md) still uses its fixed
operation allowlist and explicit runtime session IDs. Keyed MCP adds no Manager
endpoint, browser-facing proxy, ADB route or remote WebRTC signaling. Companion
Pax repositories are configured separately.

## Authorization boundary

A key is routing metadata, not a password or user identity. The broker listens
on an owner-only Unix socket (0600) in a private same-account directory (0700),
not a TCP endpoint. Only trusted local launchers under the runtime's OS account
should have access. Fixed-session credentials are still checked; operator
credentials are not embedded in generated MCP configs or sent to the model.

This does not isolate mutually untrusted agents that share unrestricted host
shell/filesystem access as the same OS user. See [SECURITY.md](../SECURITY.md)
for account separation and the remaining host/network boundary.
