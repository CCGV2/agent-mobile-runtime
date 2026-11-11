# Prepare a phone for the current task

Use this playbook when a user asks you to prepare an Android phone, including a
preparation request sent from Pax Console. This is a normal Agent task: read the
instructions, prepare the environment on the assigned node, and report progress
in the conversation. Console does not install the SDK or wait for Android to
finish booting through a long HTTP request.

## Read and inspect first

Read [AGENTS.md](../AGENTS.md), [quickstart.md](quickstart.md), the relevant
[Linux](linux.md) or [macOS](macos.md) guide, and [sessions.md](sessions.md).
Reuse an already configured runtime and assigned phone when valid. Do not
clone another installation merely because the Console preview is unavailable.

Check the actual node OS/architecture, Node 22+, configured SDK, clean template,
and applicable prerequisites. On Linux, verify usable KVM and the SDK's
acceleration check; do not make `/dev/kvm` world writable, use a privileged
container, or silently fall back to software CPU emulation. Follow the existing
task authorization for normal preparation work. Report missing administrator
permissions or unsupported hosts rather than bypassing checks.

Use the actual runtime config path explicitly:

```sh
MOBILE_CONFIG=/absolute/path/to/config.json
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" doctor
```

Do not print credential files or dump the host environment. A config path,
device ID, dependency version and sanitized diagnostic are sufficient evidence.

## Prepare missing dependencies and a private template

When there is no usable installation, run `node scripts/setup.cjs --help` and
the host-specific `--plan` from the quickstart. Apply only the appropriate
route, using a fresh private root. SDK license acceptance must follow the
operator's accepted terms; the explicit `--accept-sdk-licenses` flag is not
implicit acceptance on the operator's behalf.

The Linux route can prepare a private SDK. The existing-SDK route creates its
own clean template and config without downloading packages. Use the selected
SDK's own command-line tools: SDK 22's external `avdmanager` does not select
another SDK just because Android environment variables point there. The setup
script handles the known fresh-AVD placeholders and keeps strict validation.

Never import personal AVDs, accounts or real phones, replace an existing root,
or delete a failed installation merely to retry. Keep SDK, camera/microphone,
WebRTC and host-network restrictions described by the guides.

Preparation does not start a service or Android. Inspect `prerequisitesReady`,
then require `doctor.ready:true` before starting the configured runtime under
the node's intended OS user. Reuse an existing service when it matches; do not
kill another service, unlock a live installation or restart active paxd to
make preparation appear successful. Use an operator-selected service supervisor
or the quickstart's foreground process according to the host's setup.

## Use the task's assigned phone

If this Agent already has mobile MCP tools, use `mobile_state`, then
`mobile_start` when needed. Let the Agent tool wait for Android readiness.
Confirm `running`, launch Settings with `mobile_launch_app`, then obtain a real
`mobile_screenshot` and `mobile_snapshot`. Do not retry ambiguous input.

The trusted launcher supplies the logical task key. Reuse that binding; do not
invent a shared global key, change another task's key, or open a second MCP
connection to an occupied phone. Auto-owned phones retain their data for five
minutes after an idle disconnect by default, then are safely reclaimed. A
disconnect during dispatched work retires the phone without replay.

If mobile MCP is absent, do not claim to have installed tools into a running
Agent. Generate the documented config fragment without overwriting other MCP
entries, and report any client reconnect needed. Within the existing task
authorization, the operator CLI can prepare a task-owned phone instead:

```sh
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" session create --template clean35 --key TASK_KEY
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" session start SESSION_ID
node bin/agent-mobile.cjs --config "$MOBILE_CONFIG" session state SESSION_ID
```

Use the configured template and trusted task key, then the returned session ID.
Reuse a known assigned ID instead of creating again. A duplicate key is not a
reason to guess another phone or change the key. CLI-created phones are
persistent operator-owned sessions, not automatically expired MCP phones;
report that lifecycle and clean up the task-owned phone when appropriate.

## Make the existing Console bridge discover the same runtime

For Pax, runtime preparation and Console availability are separate checks.
The node adapter selects its explicit config path when configured, otherwise
`AGENT_MOBILE_CONFIG` from paxd's environment, otherwise
`$XDG_CONFIG_HOME/agent-mobile-runtime/config.json` (normally
`~/.config/agent-mobile-runtime/config.json`). The selected file must describe
the same private data directory and loopback control port as the running
runtime. The installer report's config path is not registered with paxd
automatically.

Confirm the node's actual configuration. Exporting a variable in an Agent's
shell does not change an already running paxd process. The adapter rereads the
selected config file on requests; if the default file is absent, an authorized
Agent can create an owned private config there without overwriting an existing
one. If changing daemon configuration or a restart is required, report that
remaining operator step instead of restarting unrelated active sessions.

The matching Manager and paxd mobile adapters must also be deployed. A missing
bridge endpoint cannot be fixed by installing the Android SDK; report it
without deploying control-plane changes as a side effect. Console keeps phone
selection explicit and does not automatically select by the current Pax key.
It uses screenshots and completed recordings; remote WebRTC is not provided.

## Report what is actually ready

Distinguish these states in the conversation:

| Evidence                                              | What it proves                                               |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| Setup returned `state:"prepared"`                     | Files/template/config were prepared; Android was not booted. |
| Doctor returned `ready:true`                          | Dependencies, acceleration and template checks passed.       |
| Session is `running` and real screenshot/UI were read | This assigned Android device is usable.                      |
| Console lists that device and displays a real frame   | The node bridge and viewer reach the same runtime.           |

Report the actual device ID, config path and remaining blockers, without
credential contents. If requested, provide a real Settings screenshot; do not
substitute a mock phone image. An audio track alone is not non-silent audio
acceptance, and existing Intel macOS results do not establish Linux or Apple
Silicon device/media acceptance. Never report readiness merely because the
Console accepted the preparation message.
