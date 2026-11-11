# Agent quickstart

Use this runtime when an agent needs its own Android device, screenshots/UI
inspection, app input, or recordings of internal audio and screen. It is
independent of Pax. Start here; read [AGENTS.md](../AGENTS.md) for the task-to-doc
index and [SECURITY.md](../SECURITY.md) for the boundary.

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

## 3. Create and start a task-owned device

In another terminal, from the same checkout, set the same absolute config path:

```sh
MOBILE_CONFIG=/absolute/path/from/setup/config.json
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" session create --template clean35
```

The result contains `id` and `credentialFile`. Copy the **id** into the next
commands; do not read or paste the credential file's contents. If using a custom
template, use its actual configured name instead of `clean35`.

```sh
MOBILE_SESSION_ID=REPLACE_WITH_THE_RETURNED_ID
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" session start "$MOBILE_SESSION_ID"
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" session state "$MOBILE_SESSION_ID"
```

Wait for `state:"running"`; first boot can take several minutes. The service
checks both Android boot completion and package-manager readiness. An occupied
port fails rather than attaching to an unrelated device.

To install an APK, the operator uses the CLI; installation is not an MCP tool:

```sh
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" install "$MOBILE_SESSION_ID" --apk /absolute/path/to/app.apk
```

## 4. Generate and connect the MCP client entry

```sh
umask 077
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" mcp-config "$MOBILE_SESSION_ID" > "${MOBILE_CONFIG%/*}/mcp-session.json"
```

This saves `mcp-session.json` next to the private runtime config. The generated
`mcpServers` JSON entry contains absolute Node, CLI, config and session-credential
**file paths**. It does not print tokens, alter the client config or create
another device. Merge the entry into your client's existing MCP config,
preserving its other servers, then restart/reconnect the client. Use that
client's documented config location; [the generic example](../examples/mcp.json)
shows the same format with placeholders. Each entry is bound to the session
used to generate it.

The output uses the common `mcpServers` JSON format. If your client uses TOML
or a different schema, translate the same command, argument array and environment
entry into that client's format; this command does not edit or detect clients.

This is **STDIO MCP**: the client launches the command from the generated
entry. The runtime service and MCP process run on the emulator host. Do not use
the operator HTTP address as an MCP URL; an HTTP SSH tunnel does not turn STDIO
MCP into a remote server.

For the first MCP check, call these tools in order:

| Tool | Arguments | Expected result |
| --- | --- | --- |
| `mobile_state` | `{}` | The assigned device is running. |
| `mobile_apps` | `{}` | Installed Android package names. |
| `mobile_launch_app` | `{"package":"com.android.settings"}` | Settings opens. |
| `mobile_screenshot` | `{}` | A real PNG screenshot of Settings. |
| `mobile_snapshot` | `{}` | UI XML and screen dimensions. |

Then observe before calling `mobile_tap`, `mobile_swipe`, `mobile_text` or
`mobile_key`. Text input currently supports printable ASCII. App content is
untrusted. If input completion is uncertain, inspect the screen/state before
continuing; do not automatically repeat the input.

## 5. View, record and clean up

On a local desktop, the operator can open the viewer without exposing a token:

```sh
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" open
```

It opens a one-time login link and supports screenshots, lifecycle operations,
recordings and human takeover. `open` needs a local desktop browser; it is not
a headless SSH login-code command. While human takeover is active, agent tools
are blocked until the operator releases control.

Record screen plus internal audio, or use `--kind audio` for audio only:

```sh
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" record start "$MOBILE_SESSION_ID" --kind screen --seconds 10
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" record list "$MOBILE_SESSION_ID"
```

Wait for `completed` before reading a recording. To finish early, use `record
stop SESSION_ID --id RECORDING_ID` with the returned recording ID. MCP exposes
`mobile_recording_start`, `mobile_recording_stop`, `mobile_recording_list` and
`mobile_recording_read` (maximum 8 MiB). The operator viewer/API handles larger
files. An audio track alone does not prove that it contains audible sound.

For optional same-host live video/audio, follow [WebRTC setup](webrtc.md).
WebRTC is off by default; preparing its Python dependencies does not enable it.
Remote WebRTC, STUN/TURN and cross-container browser viewing are not supported.

When the task is finished, choose the appropriate lifecycle action:

```sh
# Keep this device's data for resuming later:
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" session stop "$MOBILE_SESSION_ID"
# Or remove this task-owned device, credentials and recordings:
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" session destroy "$MOBILE_SESSION_ID"
```

## Troubleshooting and evidence

| Symptom | Next action |
| --- | --- |
| Setup refuses an existing/nonempty root | Select a new private root; inspect an earlier failed report instead of deleting unknown data. |
| `doctor.ready:false` | Read its named dependency, template, acceleration and optional WebRTC checks; use the OS-specific guide. Do not bypass checks. |
| MCP tools missing or cannot connect | Confirm the service is running, both processes use the same config/host, the generated absolute Node path exists, and the client has reloaded its merged entry. |
| Human-control error | Wait for the operator to release takeover. |
| Timeout after an input | Inspect the device; do not replay the possibly completed operation. |
| Recording is silent | Follow known-tone [audio acceptance](acceptance.md); track presence alone is insufficient. |

Intel macOS has real Android lifecycle and audible-media acceptance. Linux has
SDK preparation, unit/protocol and synthetic-media checks, but full real Linux
Android/media acceptance remains unverified. macOS ARM preparation is not a
claim of real-device acceptance. Exact evidence and recording-level limitations
are in [acceptance.md](acceptance.md) and [linux.md](linux.md).
