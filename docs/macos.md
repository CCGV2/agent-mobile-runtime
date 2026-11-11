# macOS installation

Use the native Android Emulator on macOS. The runtime creates its own empty
Android device; it does not connect to a physical phone or import an existing
AVD. Start with [the Agent quickstart](quickstart.md) for the complete reading
route and MCP workflow.

Intel macOS has passed real device lifecycle and internal audio/video
acceptance. The preparation script also selects the ARM image on Apple Silicon,
but real Apple Silicon device/media acceptance has not been performed. See
[acceptance.md](acceptance.md) for the exact verified scope.

## Install prerequisites

You need Node 22+, Java 17+, Android SDK command-line tools, scrcpy, and
FFmpeg/ffprobe. Python is optional until you configure WebRTC. If those tools
are already installed, keep them and skip the corresponding package installs.

For a Homebrew installation:

```sh
brew install node@22 openjdk@17 scrcpy ffmpeg
brew install --cask android-commandlinetools
export PATH="$(brew --prefix node@22)/bin:$(brew --prefix openjdk@17)/bin:$PATH"
node --version
scrcpy --version
ffmpeg -version
ffprobe -version
```

These commands install system dependencies through your chosen package manager;
the runtime's preparation script does not invoke Homebrew or sudo. The tested
SDK command-line tools release is 22.0. Packages and archives may require
several GiB of storage, plus separate writable disks for each device.

## Prepare SDK packages in a dedicated directory

If Android Studio or another installation already provides `platform-tools`,
`emulator`, its own command-line tools, and the Android 35 default image matching
your Mac, set `MOBILE_SDK` to that SDK's absolute path and skip this section.
Do not select a personal AVD as a template.

The following Homebrew example keeps the SDK and SDK-manager home separate from
your personal Android home. It accepts the SDK license interactively, then
downloads packages through the official SDK manager. The platform and build
tools are also included so you can build this repository's offline audio-test
APK later.

```sh
MOBILE_SDK="$HOME/Library/Android/agent-mobile-sdk"
MOBILE_SDK_SETUP_HOME="$HOME/.local/share/agent-mobile-sdk-setup"
MOBILE_TOOLS="$(brew --prefix)/share/android-commandlinetools/cmdline-tools/latest/bin"
MOBILE_JAVA_HOME="$(brew --prefix openjdk@17)/libexec/openjdk.jdk/Contents/Home"
MOBILE_ABI=x86_64
if [ "$(uname -m)" = arm64 ]; then MOBILE_ABI=arm64-v8a; fi

install -d -m 0700 "$MOBILE_SDK" "$MOBILE_SDK_SETUP_HOME"
mobile_sdkmanager() {
  env -i PATH="$MOBILE_JAVA_HOME/bin:/usr/bin:/bin" \
    HOME="$MOBILE_SDK_SETUP_HOME" LANG=en_US.UTF-8 \
    JAVA_HOME="$MOBILE_JAVA_HOME" \
    JAVA_TOOL_OPTIONS="-Duser.home=\"$MOBILE_SDK_SETUP_HOME\"" \
    ANDROID_HOME="$MOBILE_SDK" ANDROID_SDK_ROOT="$MOBILE_SDK" \
    ANDROID_USER_HOME="$MOBILE_SDK_SETUP_HOME/android-home" \
    ANDROID_AVD_HOME="$MOBILE_SDK_SETUP_HOME/avd" \
    ANDROID_EMULATOR_HOME="$MOBILE_SDK_SETUP_HOME/emulator-home" \
    "$MOBILE_TOOLS/sdkmanager" "--sdk_root=$MOBILE_SDK" "$@"
}
mobile_sdkmanager --licenses
mobile_sdkmanager "cmdline-tools;22.0" "platform-tools" "emulator" "platforms;android-35" \
  "build-tools;35.0.0" "system-images;android-35;default;$MOBILE_ABI"
```

The Homebrew SDK manager is used only to install packages into the selected
SDK. Its external `avdmanager` cannot create devices using a different SDK's
images: command-line tools 22 resolves packages relative to its own SDK even
when Android environment variables point elsewhere. Installing
`cmdline-tools;22.0` into `MOBILE_SDK` provides the correct local `avdmanager`.

For an SDK managed by Android Studio, set `MOBILE_SDK` to that installation and
select its own installed `cmdline-tools/.../bin/avdmanager`. For a JDK installed
outside Homebrew, `/usr/libexec/java_home` can locate it. Pass the actual
`.../bin/java` path, rather than the macOS `/usr/bin/java` launcher, if the
preparation script cannot discover your JDK.

## Generate a private runtime configuration and clean template

From this repository's checkout, choose a **new empty** runtime installation
directory, separate from the SDK:

```sh
MOBILE_ROOT="$HOME/.local/share/agent-mobile-install"
node scripts/setup.cjs --root "$MOBILE_ROOT" --sdk "$MOBILE_SDK" \
  --plan

node scripts/setup.cjs --root "$MOBILE_ROOT" --sdk "$MOBILE_SDK"
```

Setup discovers `avdmanager` under the selected SDK's `cmdline-tools/latest`
or installed version directories and resolves Java through `java_home` or PATH.
You can select them explicitly with `--avdmanager
"$MOBILE_SDK/cmdline-tools/22.0/bin/avdmanager"` and `--java
"$MOBILE_JAVA_HOME/bin/java"`. An external SDK's `avdmanager` is rejected before
the installation root is created.

The plan does not inspect files, execute tools, write files or use the network.
Applying the plan reads the installed SDK, creates its own private Android
home, and uses `avdmanager` to create `templates/clean35.avd`. It handles SDK 22's
fresh-AVD placeholders and validates the template with the same strict
provisioner used at runtime. It generates `config.json` with absolute tool
paths and permissions 0600. It does not change SDK packages, import personal
AVDs, accept licenses, download dependencies, start a service/device, or enable
WebRTC.

The result must have `state:"prepared"`. Its `ready:false` is intentional:
preparation has not booted Android. Check `prerequisitesReady` and any failed
checks, then run doctor:

```sh
node bin/agent-mobile.cjs --config "$MOBILE_ROOT/config.json" doctor
```

Doctor must return `ready:true` and exit 0 before starting the service. Its
exit code 2 means dependencies, acceleration or the template need attention.
Even a successful doctor is not a real device/audio acceptance result. If
preparation fails after creating the root, read its private `setup-status.json`;
do not rerun the installer over that directory or delete an unknown existing
installation. Fix the reported dependency or select a new empty root.

## Start and connect an Agent

Keep the service running in one terminal:

```sh
node bin/agent-mobile.cjs --config "$MOBILE_ROOT/config.json" serve
```

In another terminal, create and start a device, then generate the MCP entry:

```sh
node bin/agent-mobile.cjs --config "$MOBILE_ROOT/config.json" session create --template clean35
node bin/agent-mobile.cjs --config "$MOBILE_ROOT/config.json" session start SESSION_ID
node bin/agent-mobile.cjs --config "$MOBILE_ROOT/config.json" mcp-config SESSION_ID
```

Replace `SESSION_ID` with the returned `id`. Merge the generated entry into your
client's existing MCP configuration. It contains absolute paths and a reference
to a private session credential file; do not print that file or put its contents
in a prompt. `7341` is the control API, while MCP uses STDIO. See
[quickstart.md](quickstart.md) for the first MCP calls and cleanup.

To view the phone locally, run `node bin/agent-mobile.cjs --config
"$MOBILE_ROOT/config.json" open` from the operator's desktop terminal. Optional
live audio/video setup is in [webrtc.md](webrtc.md); it remains disabled by
default.

## References

- [Official SDK manager](https://developer.android.com/tools/sdkmanager)
- [Official AVD manager](https://developer.android.com/tools/avdmanager)
- [Android Emulator acceleration on macOS](https://developer.android.com/studio/run/emulator-acceleration)
- [Homebrew command-line tools cask](https://formulae.brew.sh/cask/android-commandlinetools)
- [Official scrcpy macOS installation](https://github.com/Genymobile/scrcpy/blob/v5.0.1/doc/macos.md)
