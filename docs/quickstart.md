# Agent quickstart

Use this runtime when an agent needs its own Android device, screenshots/UI
inspection, app input, or recordings of internal audio and screen. It is
independent of Pax. Start here; read [AGENTS.md](../AGENTS.md) for the task-to-doc
index and [SECURITY.md](../SECURITY.md) for the boundary.

After the user sends a phone-preparation request, follow the
[Agent preparation playbook](agent-preparation.md). The Agent owns dependency
checks and Android startup. Console can put preparation instructions in the
current chat draft; the user reviews, edits and sends them through the normal
conversation flow. The button itself does not send a message, install tools or
start Android. Console then observes the runtime without a long boot request.

## 1. Get the runtime and choose an installation route

```sh
git clone https://github.com/CCGV2/agent-mobile-runtime.git
cd agent-mobile-runtime
node --version
```

Use Node **22 or newer**. The checkout is the runtime; there are no npm
third-party dependencies to install. `npm ci --ignore-scripts` is optional and
does not install Android SDK tools.

| Host | Route and prerequisites |
| --- | --- |
| Linux x86_64 | Fresh private SDK: Node 22+, Java 17+, Python 3.11–3.14, FFmpeg/ffprobe, and readable/writable `/dev/kvm`. Ubuntu 24.04 is the initial target. See [Linux setup](linux.md) for shared libraries and KVM checks. |
| macOS Intel or Apple Silicon | Use an explicitly selected existing SDK with Emulator, Platform Tools, command-line `avdmanager` and the matching Android 35 default system image; Java 17+, scrcpy and FFmpeg/ffprobe must be installed. See [macOS setup](macos.md) for exact packages and paths. ARM preparation does not imply real-device acceptance. |
| Windows, Linux ARM, iOS | No supported bootstrap route in this version. |

Both routes create a **new private root and clean template**. They do not import
personal AVDs, accounts or a real phone, and do not start a service or emulator.
Use a fresh root; setup refuses a nonempty installation instead of overwriting
it.

### Linux: prepare a new SDK

Run the plan first. Apply only after the operator accepts the Android SDK terms:

```sh
MOBILE_ROOT="$HOME/.local/share/agent-mobile-install"
node scripts/setup.cjs --root "$MOBILE_ROOT" --plan
node scripts/setup.cjs --root "$MOBILE_ROOT" --accept-sdk-licenses
```

This downloads the fixed official command-line tools and scrcpy archives,
verifies their hashes, installs SDK packages and creates the `clean35` template.
The installer does not install OS packages, run sudo or change KVM permissions.

### macOS: use an existing SDK

Replace the SDK path with the installed SDK's absolute path. The plan lists the
required installed packages; this route downloads no SDK packages and does not
accept SDK licenses:

```sh
MOBILE_ROOT="$HOME/.local/share/agent-mobile-install"
node scripts/setup.cjs --root "$MOBILE_ROOT" --sdk /absolute/path/to/Android/sdk --plan
node scripts/setup.cjs --root "$MOBILE_ROOT" --sdk /absolute/path/to/Android/sdk
```

It creates a dedicated `clean35` template, normalizes known fresh-AVD
placeholders, validates its private writable paths and writes the runtime
config. Do not substitute a personal `.avd` directory.

## 2. Check readiness, then start the service

The setup report contains `configPath`, the template name and prerequisite
checks. `state:"prepared", ready:false` means preparation finished without
running Android acceptance. Resolve failed prerequisite checks before serving.
Use the **actual absolute `configPath`** from that report in every terminal:

```sh
MOBILE_CONFIG=/absolute/path/from/setup/config.json
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" doctor
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" serve
```

`doctor` must return `ready:true` and exit 0; exit 2 means something is missing.
`serve` stays in the foreground. Leave this terminal running. It listens only
on `127.0.0.1:7341` by default and uses its own ADB server port, normally 5038.
A ready doctor checks dependencies and the template; it is not proof of a
successful boot or non-silent audio.

## 3. Generate a keyed MCP entry

In another terminal, from the same checkout, set the same absolute config path:

```sh
MOBILE_CONFIG=/absolute/path/from/setup/config.json
umask 077
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" mcp-config --template clean35 > "${MOBILE_CONFIG%/*}/mcp-keyed.json"
```

Use your configured template name if it is not `clean35`. Merge the generated
entry into your client's existing MCP config, preserving its other servers,
then restart/reconnect the client. The fragment uses absolute Node, CLI and
config paths and does not contain a token. It does not edit the client config
or start a VM. [The keyed example](../examples/mcp-keyed.json) shows the same
format with placeholders.

A trusted launcher can set `AGENT_MOBILE_SESSION_KEY` for each logical task.
Different keys get independent phones; reconnecting with the same key resumes
that phone while it is retained. Do not put one shared fixed key into every
agent's global config. Without a key, each MCP connection gets a random key
and a new phone. See [session keys and concurrency](sessions.md) for launcher
examples and retention rules.

The output uses the common `mcpServers` JSON format. If your client uses TOML
or a different schema, translate the same command, argument array and environment
entry into that client's format. The generator does not edit or detect clients.

This is **STDIO MCP**: the client launches the generated command, which connects
to the running service's private local broker. The service is required even
for MCP initialization. Both processes run on the emulator host under the
service account. The control HTTP address is not an MCP URL; an HTTP SSH tunnel
does not turn STDIO MCP into a remote server.

## 4. Start the assigned phone and verify MCP

MCP attachment allocates a private device but does not boot Android during
initialization. Call these tools in order:

| Tool | Arguments | Expected result |
| --- | --- | --- |
| `mobile_state` | `{}` | The assigned device ID and its current state. |
| `mobile_start` | `{}` | A stopped device boots and reaches `running`; an already running device stays assigned. |
| `mobile_apps` | `{}` | Installed Android package names. |
| `mobile_launch_app` | `{"package":"com.android.settings"}` | Settings opens. |
| `mobile_screenshot` | `{}` | A real PNG screenshot of Settings. |
| `mobile_snapshot` | `{}` | UI XML and screen dimensions. |

First boot can take several minutes. `mobile_start` checks Android boot
completion and package-manager readiness. An occupied port fails rather than
attaching to an unrelated device. If the state requires recovery, use the
operator recovery workflow instead of automatically restarting or deleting it.

Observe before calling `mobile_tap`, `mobile_swipe`, `mobile_text` or
`mobile_key`. Text input currently supports printable ASCII. App content is
untrusted. If input completion is uncertain, inspect the screen/state before
continuing; do not automatically repeat the input.

To install an APK, the operator uses the assigned ID returned by `mobile_state`
or `session list`; installation is not a model-facing MCP tool:

```sh
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" session list
MOBILE_SESSION_ID=REPLACE_WITH_THE_ASSIGNED_ID
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" install "$MOBILE_SESSION_ID" --apk /absolute/path/to/app.apk
```

For concurrency, fresh installations allow two stored devices by default.
Existing configs are not rewritten: if yours has `maxDevices:1`, set a suitable
limit of at least 2 before starting the service. The supported range is 1–8;
stopped and retained devices also count until destroyed. Protocol tests do not
establish real multi-emulator hardware capacity.

### Optional: pre-provision a persistent operator-owned phone

Use the manual route when an operator wants a device whose data remains after
MCP disconnects. It is not subject to automatic keyed-session expiry:

```sh
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" session create --template clean35
MOBILE_SESSION_ID=REPLACE_WITH_THE_RETURNED_ID
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" session start "$MOBILE_SESSION_ID"
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" mcp-config "$MOBILE_SESSION_ID"
```

Merge that generated entry into the client. It references `credentialFile`
through `AGENT_MOBILE_SESSION_FILE`; do not read or paste the file's contents.
Do not also set `AGENT_MOBILE_SESSION_KEY` for this entry. Only one active MCP
connection can use a phone, including connections through different launch
modes. [The fixed-session example](../examples/mcp.json) remains available.

## 5. View, record and clean up

On a local desktop, the operator can open the viewer without exposing a token:

```sh
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" open
```

The viewer supports screenshots, lifecycle operations, recordings and human
takeover. `open` needs a local desktop browser; it is not a headless SSH
login-code command. While human takeover is active, agent observations and
input are blocked until the operator releases control.

The Agent can call `mobile_recording_start`, `mobile_recording_stop`,
`mobile_recording_list` and `mobile_recording_read` (maximum 8 MiB). The operator
may also record using the assigned session ID:

```sh
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" record start "$MOBILE_SESSION_ID" --kind screen --seconds 10
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" record list "$MOBILE_SESSION_ID"
```

Use `--kind audio` for audio only. Wait for `completed` before reading a
recording; use `record stop SESSION_ID --id RECORDING_ID` to finish early.
The operator viewer/API handles larger files. An audio track alone does not
prove that it contains audible sound.

For optional same-host live video/audio, follow [WebRTC setup](webrtc.md).
WebRTC is off by default; preparing its Python dependencies does not enable it.
Remote WebRTC, STUN/TURN and cross-container browser viewing are not supported.

After an idle disconnect, auto-owned phones are retained for five minutes by
default, then stopped and destroyed. Reconnect with the same key during that
window to preserve App state. A disconnect with a tool request in flight
retires the auto-owned phone rather than replaying the operation; attachment
stays blocked until cleanup finishes. See [sessions.md](sessions.md).

For manual persistent phones, or an explicit early cleanup of your assigned
task-owned phone, choose the appropriate operator lifecycle action:

```sh
# Keep the device's data until its applicable retention policy or explicit destruction:
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" session stop "$MOBILE_SESSION_ID"
# Remove this task-owned device, credentials and recordings:
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" session destroy "$MOBILE_SESSION_ID"
```

## Troubleshooting and evidence

| Symptom | Next action |
| --- | --- |
| Setup refuses an existing/nonempty root | Select a new private root; inspect an earlier failed report instead of deleting unknown data. |
| `doctor.ready:false` | Read its named dependency, template, acceleration and optional WebRTC checks; use the OS-specific guide. Do not bypass checks. |
| MCP cannot initialize | Confirm the service is running under the same account, both processes use the same config, and the generated absolute Node path exists. |
| Session already connected | Close the old MCP connection; do not use the same key for unrelated tasks. |
| Capacity reached | Retained and stopped sessions count too; inspect owned sessions and allow expiry or explicitly destroy an unused one. |
| Session retiring or cleanup failed | Wait for confirmed cleanup, or use operator recovery; do not bypass its ownership checks. |
| Human-control error | Wait for the operator to release takeover. |
| Timeout after an input | Inspect the device; do not replay the possibly completed operation. |
| Recording is silent | Follow known-tone [audio acceptance](acceptance.md); track presence alone is insufficient. |

Intel macOS has real Android lifecycle and audible-media acceptance. Linux has
SDK preparation, unit/protocol and synthetic-media checks, but full real Linux
Android/media acceptance remains unverified. macOS ARM preparation is not a
claim of real-device acceptance. Exact evidence and recording-level limitations
are in [acceptance.md](acceptance.md) and [linux.md](linux.md).
