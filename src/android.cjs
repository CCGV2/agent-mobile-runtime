'use strict';

const {execFile, spawn} = require('node:child_process');
const {once} = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const {privateDir, atomicJSON} = require('./storage.cjs');
const {grpcAllowlistPath, GRPC_ALLOWLIST} = require('./emulator-grpc.cjs');
const {inspectLinuxHost} = require('./linux-host.cjs');

const UI_PATH = '/data/local/tmp/agent-mobile-ui.xml';
const MAX_TEXT = 2000;
const MAX_SCREENSHOT = 16 * 1024 * 1024;
const MAX_XML = 2 * 1024 * 1024;
const KEYS = Object.freeze({HOME: 3, BACK: 4, ENTER: 66, APP_SWITCH: 187, DELETE: 67});

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

// adb shell constructs a remote shell command even when the host uses execFile.
// Quote every remote argument, including text; never interpolate unquoted input.
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function abortError() {
  const error = new Error('Android operation aborted');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortError();
}

function sleep(milliseconds, signal) {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', aborted);
      resolve();
    }, milliseconds);
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(abortError());
    };
    signal?.addEventListener('abort', aborted, {once: true});
    if (signal?.aborted) aborted();
  });
}

function runProcess(file, args, options) {
  return new Promise((resolve, reject) => {
    execFile(file, args, {...options, encoding: 'buffer', shell: false}, (error, stdout, stderr) => {
      if (error) {
        // execFile's callback error does not include these streams. Preserve
        // bounded diagnostics internally so selected-device absence can be
        // distinguished from an unavailable ADB daemon; public errors omit it.
        error.stdout = stdout; error.stderr = stderr;
        reject(error);
      }
      else resolve({stdout, stderr});
    });
  });
}

function validatePNG(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || buffer.length > MAX_SCREENSHOT ||
      !buffer.subarray(0, 8).equals(signature) || buffer.readUInt32BE(8) !== 13 ||
      buffer.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Invalid Android screenshot');
  }
  integer(buffer.readUInt32BE(16), 'screenshot width', 1, 16384);
  integer(buffer.readUInt32BE(20), 'screenshot height', 1, 16384);
  return buffer;
}

class AndroidBackend {
  constructor({config = {}, runner = runProcess, spawnProcess = spawn, platform = process.platform, architecture = process.arch, inspectHost = inspectLinuxHost} = {}) {
    if (typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) throw new Error('Android backend requires an absolute private dataDir');
    this.config = config;
    this.runner = runner;
    this.spawnProcess = spawnProcess;
    // Trusted constructor hooks let tests exercise Linux without changing the
    // process platform or accepting platform/KVM overrides from HTTP config.
    this.platform = platform;
    this.architecture = architecture;
    this.inspectHost = inspectHost;
    this.serverPort = integer(config.adbServerPort ?? 5038, 'ADB server port', 1024, 65535);
    this.pollIntervalMs = integer(config.pollIntervalMs ?? 500, 'boot poll interval', 1, 10000);
    this.bootTimeoutMs = integer(config.bootTimeoutMs ?? 120000, 'boot timeout', 1, 900000);
    this.stopTimeoutMs = integer(config.stopTimeoutMs ?? 10000, 'stop timeout', 1, 120000);
  }

  _env(device) {
    const env = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      HOME: path.join(this.config.dataDir, 'home'),
      TMPDIR: path.join(this.config.dataDir, 'tmp'),
      ANDROID_USER_HOME: path.join(this.config.dataDir, 'android-home'),
      XDG_RUNTIME_DIR: path.join(this.config.dataDir, 'runtime'),
      ANDROID_EMULATOR_HOME: path.join(this.config.dataDir, 'emulator-home'),
      ANDROID_ADB_SERVER_ADDRESS: '127.0.0.1',
      ANDROID_ADB_SERVER_PORT: String(this.serverPort),
      ADB_SERVER_SOCKET: `tcp:127.0.0.1:${this.serverPort}`,
    };
    if (this.config.sdkRoot) env.ANDROID_HOME = env.ANDROID_SDK_ROOT = this.config.sdkRoot;
    if (device?.avdHome) {
      env.ANDROID_AVD_HOME = device.avdHome;
      env.ANDROID_EMULATOR_HOME = path.join(path.dirname(device.avdHome), 'emulator-home');
    }
    return env;
  }

  async _prepareEnvironment() {
    if (!this.environmentReady) {
      this.environmentReady = (async () => {
        await privateDir(this.config.dataDir);
        const env = this._env();
        for (const dir of [env.HOME, env.TMPDIR, env.ANDROID_USER_HOME, env.ANDROID_EMULATOR_HOME, env.XDG_RUNTIME_DIR]) await privateDir(dir);
      })();
      this.environmentReady.catch(() => { this.environmentReady = null; });
    }
    await this.environmentReady;
  }

  _device(device) {
    if (!device || typeof device !== 'object') throw new Error('Invalid managed Android device');
    const port = integer(device.port, 'emulator port', 5554, 5682);
    if (port % 2 || device.serial !== `emulator-${port}` || port === this.serverPort || port + 1 === this.serverPort) {
      throw new Error('Invalid managed Android device');
    }
    return device;
  }

  async _run(file, args, {timeout = 10000, maxBuffer = MAX_XML, signal, device} = {}) {
    checkAbort(signal);
    await this._prepareEnvironment();
    checkAbort(signal);
    let result;
    try {
      result = await this.runner(file, args, {
        env: this._env(device), timeout, maxBuffer, signal, windowsHide: true,
        encoding: 'buffer', shell: false,
      });
    } catch (error) {
      if (signal?.aborted || error.name === 'AbortError') throw abortError();
      // Do not include command arguments or captured output, which may contain secrets.
      throw new Error('Android command failed', {cause: error});
    }
    checkAbort(signal);
    const stdout = Buffer.isBuffer(result?.stdout) ? result.stdout : Buffer.from(result?.stdout ?? '');
    const stderr = Buffer.isBuffer(result?.stderr) ? result.stderr : Buffer.from(result?.stderr ?? '');
    if (stdout.length > maxBuffer || stderr.length > maxBuffer) throw new Error('Android command output exceeded limit');
    return {stdout, stderr};
  }

  async _adb(device, args, options = {}) {
    this._device(device);
    return this._run(this.config.adbPath || 'adb', [
      // ADB treats numeric 127.0.0.1 as a remote host and refuses to start its
      // daemon. The fixed localhost spelling starts a loopback-only daemon;
      // the explicit private port and selected emulator remain mandatory.
      '-H', 'localhost', '-P', String(this.serverPort), '-s', device.serial, ...args,
    ], {...options, device});
  }

  _shell(device, args, options) {
    return this._adb(device, ['shell', args.map(shellQuote).join(' ')], options);
  }

  async _transportState(device, options = {}) {
    try {
      const result = await this._adb(device, ['get-state'], {maxBuffer: 65536, ...options});
      const state = result.stdout.toString('utf8').trim();
      if (state !== 'device' && state !== 'offline' && state !== 'unauthorized') {
        throw new Error('Unrecognized Android transport state');
      }
      return state;
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      const stderr = error.cause?.stderr?.toString() || '';
      if (/^error: device offline\s*$/i.test(stderr)) return 'offline';
      if (/^error: device unauthorized(?:[.\r\n]|$)/i.test(stderr)) return 'unauthorized';
      // Only an explicit selected-device absence means absent. Executable,
      // daemon, permissions, and other transport failures must remain failures.
      if (/device ['"]?emulator-\d+['"]? not found|no devices\/emulators found/i.test(stderr)) return 'absent';
      throw error;
    }
  }

  async _avdName(device, options = {}) {
    const result = await this._adb(device, ['emu', 'avd', 'name'], {maxBuffer: 65536, ...options});
    const lines = result.stdout.toString('utf8').trim().split(/\r?\n/);
    if (lines.at(-1) === 'OK') lines.pop();
    if (lines.length !== 1 || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(lines[0])) {
      throw new Error('Android emulator identity unavailable');
    }
    return lines[0];
  }

  async _assertOwned(device, options = {}) {
    this._device(device);
    if (typeof device.avdName !== 'string' || await this._avdName(device, options) !== device.avdName) {
      const error = new Error('Android emulator identity mismatch; refusing device operation');
      error.code = 'EMULATOR_IDENTITY_MISMATCH';
      throw error;
    }
  }

  async launch(device) {
    this._device(device);
    if (this.platform === 'linux') {
      if (this.config.headless === false) throw Object.assign(new Error('Linux desktop windows are not supported; use headless=true. A dedicated Xvfb backend is not configured.'), {code: 'LINUX_GUI_UNSUPPORTED'});
      const host = await this.inspectHost({architecture: this.architecture, headless: true});
      if (!host.ok) throw Object.assign(new Error('Linux emulator requires an x86_64 host and read/write access to /dev/kvm. Run doctor for host and nested-virtualization guidance.'), {code: 'LINUX_HOST_UNAVAILABLE'});
    }
    if (typeof device.avdName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(device.avdName) ||
        typeof device.avdHome !== 'string' || !path.isAbsolute(device.avdHome) ||
        typeof device.avdDir !== 'string' || !path.isAbsolute(device.avdDir)) {
      throw new Error('Invalid managed AVD configuration');
    }
    if (await this._transportState(device) !== 'absent') throw new Error('Android emulator serial is already occupied');
    const args = [
      '-avd', device.avdName, '-port', String(device.port),
      '-no-snapshot', '-no-boot-anim', '-camera-back', 'none', '-camera-front', 'none',
    ];
    if (this.config.headless !== false) args.push('-no-window');
    if (this.platform === 'linux') args.push('-accel', 'on');
    if (this.config.webrtc?.enabled) {
      await atomicJSON(grpcAllowlistPath(this.config), GRPC_ALLOWLIST);
      const discoveryRoot = this.platform === 'darwin'
        ? path.join(this._env(device).HOME, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running')
        : path.join(this._env(device).XDG_RUNTIME_DIR, 'avd', 'running');
      let directory = this.config.dataDir;
      for (const component of path.relative(this.config.dataDir, discoveryRoot).split(path.sep)) {
        directory = path.join(directory, component); await privateDir(directory);
      }
      // A fixed -port suppresses automatic gRPC startup. JWT auth explicitly
      // forces the SDK's gRPC builder back to loopback (never use bare -grpc).
      args.push('-grpc', String(device.port + 3000), '-grpc-use-jwt', '-grpc-allowlist', grpcAllowlistPath(this.config));
    }
    await privateDir(this._env(device).ANDROID_EMULATOR_HOME);
    // The SDK creates discovery/JWK files itself. Inherit private permissions
    // from the first filesystem write rather than chmod them after publication.
    const previousMask = process.umask(0o077);
    let child;
    try {
      child = this.spawnProcess(this.config.emulatorPath || 'emulator', args, {
        env: this._env(device), cwd: device.avdDir,
        stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
      });
    } finally { process.umask(previousMask); }
    child.stdout?.resume(); child.stderr?.resume();
    // The caller receives a successfully spawned ChildProcess and owns draining
    // its already-resumed stdout/stderr, tracking exit, and a forced-kill fallback.
    await once(child, 'spawn');
    return child;
  }

  async waitReady(device, {signal} = {}) {
    this._device(device);
    const deadline = Date.now() + this.bootTimeoutMs;
    while (Date.now() < deadline) {
      checkAbort(signal);
      try {
        const {stdout} = await this._shell(device, ['getprop', 'sys.boot_completed'], {
          timeout: Math.max(1, Math.min(5000, deadline - Date.now())), maxBuffer: 65536, signal,
        });
        if (stdout.toString('utf8').trim() === '1') {
          // A completed boot property alone is insufficient if package manager
          // has not become responsive yet.
          const ready = await this._shell(device, ['pm', 'path', 'android'], {
            timeout: Math.max(1, Math.min(5000, deadline - Date.now())), maxBuffer: 65536, signal,
          });
          if (/^package:/m.test(ready.stdout.toString('utf8'))) {
            await this._assertOwned(device, {timeout: Math.max(1, Math.min(5000, deadline - Date.now())), signal});
            return;
          }
        }
      } catch (error) {
        if (error.name === 'AbortError' || signal?.aborted) throw abortError();
        if (error.code === 'EMULATOR_IDENTITY_MISMATCH') throw error;
        // adb transport and package manager can be unavailable during boot.
      }
      const remaining = deadline - Date.now();
      if (remaining > 0) await sleep(Math.min(this.pollIntervalMs, remaining), signal);
    }
    checkAbort(signal);
    throw new Error('Android emulator boot timed out');
  }

  async recover(device) {
    this._device(device);
    const deadline = Date.now() + this.stopTimeoutMs;
    const options = () => ({timeout: Math.max(1, Math.min(5000, deadline - Date.now()))});
    let state = await this._transportState(device, options());
    // ADB briefly keeps a just-exited emulator as offline. Waiting is safe even
    // when identity is unavailable; never issue a kill until identity is known.
    while (state === 'offline' && Date.now() < deadline) {
      await sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
      state = await this._transportState(device, options());
    }
    if (state === 'absent') return {state: 'absent'};
    if (state !== 'device') throw new Error('Cannot verify Android emulator identity');
    if (await this._avdName(device, options()) !== device.avdName) {
      throw new Error('Android emulator identity mismatch; refusing to stop');
    }
    try {
      await this._adb(device, ['emu', 'kill'], {...options(), maxBuffer: 65536});
    } catch {
      // A closing emulator may drop the acknowledgement. Do not resend kill;
      // observe the transport to determine whether shutdown actually completed.
    }
    while (Date.now() < deadline) {
      const current = await this._transportState(device, options());
      if (current === 'absent') return {state: 'stopped'};
      const remaining = deadline - Date.now();
      if (remaining > 0) await sleep(Math.min(this.pollIntervalMs, remaining));
    }
    throw new Error('Android emulator stop timed out');
  }

  async stop(device) {
    return this.recover(device);
  }

  async snapshot(device) {
    await this._assertOwned(device);
    // Remove the old dump first: some uiautomator failures exit successfully but
    // leave the old file untouched, which must never be mistaken for fresh UI.
    let stdout;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await this._assertOwned(device);
      await this._shell(device, ['rm', '-f', UI_PATH]);
      try {
        await this._shell(device, ['uiautomator', 'dump', UI_PATH], {timeout: 20000});
        ({stdout} = await this._shell(device, ['cat', UI_PATH], {maxBuffer: MAX_XML}));
        break;
      } catch (error) {
        // A fresh Android activity may not be idle yet. Retry observation only,
        // always clearing the old file; never redispatch device input.
        if (attempt === 2) throw new Error('Android UI snapshot unavailable', {cause: error});
        await sleep(250);
      }
    }
    const xml = stdout.toString('utf8').trim();
    if (!xml || !/^(?:<\?xml[^>]*>\s*)?<hierarchy(?:\s|>)/.test(xml) || !/<\/hierarchy>\s*$/.test(xml) ||
        /<!DOCTYPE|<!ENTITY/i.test(xml)) {
      throw new Error('Invalid Android UI snapshot');
    }
    const size = await this._shell(device, ['wm', 'size'], {maxBuffer: 65536});
    const sizes = [...size.stdout.toString('utf8').matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)];
    if (!sizes.length) throw new Error('Android display size unavailable');
    const last = sizes[sizes.length - 1];
    return {
      xml,
      width: integer(Number(last[1]), 'display width', 1, 16384),
      height: integer(Number(last[2]), 'display height', 1, 16384),
    };
  }

  async screenshot(device) {
    await this._assertOwned(device);
    const {stdout} = await this._adb(device, ['exec-out', 'screencap', '-p'], {maxBuffer: MAX_SCREENSHOT});
    return validatePNG(stdout);
  }

  async tap(device, {x, y} = {}) {
    integer(x, 'x coordinate', 0, 16383); integer(y, 'y coordinate', 0, 16383);
    await this._assertOwned(device);
    await this._shell(device, ['input', 'tap', x, y]);
    return {ok: true};
  }

  async swipe(device, {x1, y1, x2, y2, durationMs = 300} = {}) {
    for (const [name, value] of Object.entries({x1, y1, x2, y2})) integer(value, `${name} coordinate`, 0, 16383);
    integer(durationMs, 'swipe duration', 1, 5000);
    await this._assertOwned(device);
    await this._shell(device, ['input', 'swipe', x1, y1, x2, y2, durationMs]);
    return {ok: true};
  }

  async text(device, {text} = {}) {
    if (typeof text !== 'string' || text.length < 1 || text.length > MAX_TEXT || /[^\x20-\x7e]/.test(text) || text.includes('%s')) {
      throw new Error('Text must be 1–2000 printable ASCII characters without literal %s; Unicode input requires a device-side IME');
    }
    await this._assertOwned(device);
    await this._shell(device, ['input', 'text', text.replace(/ /g, '%s')]);
    return {ok: true};
  }

  async key(device, {key} = {}) {
    if (!Object.hasOwn(KEYS, key)) throw new Error('Unsupported Android key');
    await this._assertOwned(device);
    await this._shell(device, ['input', 'keyevent', KEYS[key]]);
    return {ok: true};
  }

  async launchApp(device, {package: packageName} = {}) {
    if (typeof packageName !== 'string' || packageName.length > 255 ||
        !/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(packageName)) {
      throw new Error('Invalid Android package');
    }
    await this._assertOwned(device);
    await this._shell(device, ['monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1']);
    return {ok: true};
  }

  async installApp(device, {apkPath} = {}) {
    if (typeof apkPath !== 'string' || !path.isAbsolute(apkPath) || path.extname(apkPath).toLowerCase() !== '.apk') {
      throw new Error('APK must be an absolute .apk file path');
    }
    const stat = await fs.lstat(apkPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('APK must be a regular file');
    await this._assertOwned(device);
    const {stdout} = await this._adb(device, ['install', '-r', apkPath], {timeout: 120000, maxBuffer: 1024 * 1024});
    if (!/^Success\s*$/m.test(stdout.toString('utf8'))) throw new Error('Android APK installation failed');
    return {ok: true};
  }

  async apps(device) {
    await this._assertOwned(device);
    const {stdout} = await this._shell(device, ['pm', 'list', 'packages']);
    const packages = stdout.toString('utf8').split(/\r?\n/).filter(Boolean).map(line => {
      if (!/^package:[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(line)) {
        throw new Error('Invalid Android package list');
      }
      return line.slice(8);
    });
    return [...new Set(packages)].sort();
  }
}

module.exports = {AndroidBackend, runProcess, shellQuote, validatePNG};
