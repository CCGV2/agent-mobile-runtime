'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {AndroidBackend, shellQuote} = require('../src/android.cjs');

let testRoot, backendCount = 0;
test.before(async () => { testRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-backend-'))); });
test.after(async () => { await fs.rm(testRoot, {recursive: true, force: true}); });
function makeBackend(options) {
  return new AndroidBackend({platform: 'darwin', ...options, config: {dataDir: path.join(testRoot, String(++backendCount)), ...options.config}});
}
function identity(args) { return args.slice(6).join(' ') === 'emu avd name'; }

const device = {
  id: 'test-device', port: 5554, serial: 'emulator-5554', avdName: 'mobile_test',
  avdHome: '/tmp/mobile-test/avd', avdDir: '/tmp/mobile-test/avd/mobile_test.avd',
};
const result = stdout => ({stdout: Buffer.from(stdout), stderr: Buffer.alloc(0)});
function absent() {
  const error = new Error('adb failed');
  error.stderr = Buffer.from("error: device 'emulator-5554' not found\n");
  error.code = 1;
  return error;
}

test('uses private loopback ADB server and exact managed serial, with safely quoted shell input', async () => {
  const calls = [];
  const backend = makeBackend({config: {adbPath: '/sdk/adb', adbServerPort: 5099}, runner: async (...call) => {
    calls.push(call); return result(identity(call[1]) ? device.avdName + '\nOK\n' : '');
  }});
  const text = "a'; $(printf bad); `printf bad` &|<>\\ end";
  await backend.text(device, {text});
  assert.equal(calls.length, 2);
  const [file, args, opts] = calls[1];
  assert.equal(file, '/sdk/adb');
  assert.deepEqual(args.slice(0, 7), ['-H', 'localhost', '-P', '5099', '-s', device.serial, 'shell']);
  assert.equal(args[7], "'input' 'text' " + shellQuote(text.replace(/ /g, '%s')));
  assert.equal(opts.env.ADB_SERVER_SOCKET, 'tcp:127.0.0.1:5099');
  assert.equal(opts.shell, false);
  // Exercise the exact remote escaping against a real shell, with printf as
  // a harmless stand-in for Android's input command.
  const escaped = await promisify(execFile)('/bin/sh', ['-c', 'printf %s ' + shellQuote(text)]);
  assert.equal(escaped.stdout, text);
});

test('rejects arbitrary transports, injected coordinates, package names and unsupported text before dispatch', async () => {
  const calls = [];
  const backend = makeBackend({runner: async (...call) => {calls.push(call); return result('');}});
  await assert.rejects(backend.apps({...device, serial: 'real-phone'}), /Invalid managed/);
  await assert.rejects(backend.apps({...device, port: 5555, serial: 'emulator-5555'}), /Invalid managed/);
  await assert.rejects(backend.tap(device, {x: '1;id', y: 1}), /Invalid x/);
  await assert.rejects(backend.swipe(device, {x1: 0, y1: 1, x2: 2, y2: 3, durationMs: 999999}), /duration/);
  await assert.rejects(backend.launchApp(device, {package: 'com.example;id'}), /Invalid Android package/);
  await assert.rejects(backend.key(device, {key: 'POWER;id'}), /Unsupported/);
  await assert.rejects(backend.text(device, {text: '中文'}), /ASCII/);
  await assert.rejects(backend.text(device, {text: 'literal%s'}), /ASCII/);
  await assert.rejects(backend.text(device, {text: 'line\nbreak'}), /ASCII/);
  assert.equal(calls.length, 0);
});

test('child environment keeps host credentials and Android state out, and creates private homes before ADB startup', async t => {
  const previousSecret = process.env.AGENT_MOBILE_TEST_SECRET;
  const previousKeys = process.env.ADB_VENDOR_KEYS;
  process.env.AGENT_MOBILE_TEST_SECRET = 'synthetic-secret';
  process.env.ADB_VENDOR_KEYS = '/host/private/adb-key';
  t.after(() => {
    if (previousSecret === undefined) delete process.env.AGENT_MOBILE_TEST_SECRET;
    else process.env.AGENT_MOBILE_TEST_SECRET = previousSecret;
    if (previousKeys === undefined) delete process.env.ADB_VENDOR_KEYS;
    else process.env.ADB_VENDOR_KEYS = previousKeys;
  });
  let environment;
  const backend = makeBackend({config: {sdkRoot: '/operator/sdk'}, runner: async (_file, args, options) => {
    environment = options.env;
    assert.equal(Object.hasOwn(environment, 'AGENT_MOBILE_TEST_SECRET'), false);
    assert.equal(Object.hasOwn(environment, 'ADB_VENDOR_KEYS'), false);
    assert.equal(environment.HOME, path.join(backend.config.dataDir, 'home'));
    assert.equal(environment.ANDROID_USER_HOME, path.join(backend.config.dataDir, 'android-home'));
    assert.equal(environment.ANDROID_HOME, '/operator/sdk');
    assert.equal(environment.ANDROID_SDK_ROOT, '/operator/sdk');
    for (const dir of [environment.HOME, environment.ANDROID_USER_HOME, environment.TMPDIR]) {
      const stat = await fs.stat(dir);
      assert.equal(stat.isDirectory(), true);
      assert.equal(stat.mode & 0o077, 0);
    }
    return result(identity(args) ? 'mobile_test\nOK\n' : '');
  }});
  await backend.tap(device, {x: 1, y: 2});
  assert.ok(environment);
});

test('normal operations refuse a different AVD that reused the serial before returning data or sending input', async () => {
  const calls = [];
  const backend = makeBackend({runner: async (_file, args) => {calls.push(args); return result('foreign_avd\nOK\n');}});
  for (const call of [() => backend.tap(device, {x: 1, y: 1}), () => backend.screenshot(device), () => backend.apps(device)]) {
    await assert.rejects(call(), {code: 'EMULATOR_IDENTITY_MISMATCH'});
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(identity));
  const boot = makeBackend({config: {bootTimeoutMs: 1000, pollIntervalMs: 1}, runner: async (_file, args) => {
    if (identity(args)) return result('foreign_avd\nOK\n');
    return result(args.at(-1).includes('getprop') ? '1' : 'package:/system/framework/framework-res.apk\n');
  }});
  await assert.rejects(boot.waitReady(device), {code: 'EMULATOR_IDENTITY_MISMATCH'});
});

test('launch refuses occupied serial and unrecognized ADB failures without spawning', async () => {
  let spawned = false;
  const occupied = makeBackend({runner: async () => result('device\n'), spawnProcess: () => {spawned = true;}});
  await assert.rejects(occupied.launch(device), /already occupied/);
  const broken = makeBackend({runner: async () => {throw Object.assign(new Error('missing'), {code: 'ENOENT'});}, spawnProcess: () => {spawned = true;}});
  await assert.rejects(broken.launch(device), /Android command failed/);
  assert.equal(spawned, false);
});

test('real child stderr distinguishes an absent selected emulator from daemon failure', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-adb-stderr-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const adb = path.join(root, 'adb');
  await fs.writeFile(adb, '#!/bin/sh\nprintf "%s\\n" "error: device emulator-5554 not found" >&2\nexit 1\n', {mode: 0o700});
  const child = new EventEmitter(); child.pid = 99999999;
  const backend = makeBackend({config: {dataDir: root, adbPath: adb}, spawnProcess: () => {
    process.nextTick(() => child.emit('spawn')); return child;
  }});
  const local = {...device, avdHome: path.join(root, 'avd'), avdDir: path.join(root, 'avd', 'mobile_test.avd')};
  assert.equal(await backend.launch(local), child);
});

test('launch uses dedicated AVD environment, disables cameras, keeps audio and awaits spawn', async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-android-')));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const local = {...device, avdHome: path.join(dir, 'avd'), avdDir: path.join(dir, 'avd', 'mobile_test.avd')};
  let captured;
  const child = new EventEmitter();
  child.pid = 123456;
  const backend = makeBackend({config: {dataDir: dir, emulatorPath: '/sdk/emulator', headless: true}, runner: async () => {throw absent();}, spawnProcess: (...args) => {
    captured = args; process.nextTick(() => child.emit('spawn')); return child;
  }});
  assert.equal(await backend.launch(local), child);
  assert.equal(captured[0], '/sdk/emulator');
  assert.deepEqual(captured[1], ['-avd', 'mobile_test', '-port', '5554', '-no-snapshot', '-no-boot-anim', '-camera-back', 'none', '-camera-front', 'none', '-no-window']);
  assert.equal(captured[2].env.ANDROID_AVD_HOME, local.avdHome);
  assert.equal(captured[2].env.ANDROID_EMULATOR_HOME, path.join(dir, 'emulator-home'));
  assert.deepEqual(captured[2].stdio, ['ignore', 'pipe', 'pipe']);
  assert.equal(captured[2].shell, false);
});

test('Linux launch requires KVM before ADB or spawn and rejects an unsupported desktop window', async () => {
  let dispatched = false;
  const hooks = {platform: 'linux', architecture: 'x64',
    runner: async () => { dispatched = true; throw absent(); },
    spawnProcess: () => { dispatched = true; throw new Error('Must not spawn'); },
    inspectHost: async options => { assert.deepEqual(options, {architecture: 'x64', headless: true}); return {ok: false}; },
  };
  await assert.rejects(makeBackend(hooks).launch(device), {code: 'LINUX_HOST_UNAVAILABLE'});
  assert.equal(dispatched, false);
  const gui = makeBackend({...hooks, config: {headless: false}, inspectHost: async () => { throw new Error('GUI must fail before host inspection'); }});
  await assert.rejects(gui.launch(device), {code: 'LINUX_GUI_UNSUPPORTED'});
  assert.equal(dispatched, false);
});

test('Linux launch forces hardware acceleration and creates private XDG gRPC discovery directories', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-linux-launch-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const previousPulse = process.env.PULSE_SERVER;
  const previousBus = process.env.DBUS_SESSION_BUS_ADDRESS;
  process.env.PULSE_SERVER = 'unix:/host/private/pulse';
  process.env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/host/private/bus';
  t.after(() => {
    if (previousPulse === undefined) delete process.env.PULSE_SERVER; else process.env.PULSE_SERVER = previousPulse;
    if (previousBus === undefined) delete process.env.DBUS_SESSION_BUS_ADDRESS; else process.env.DBUS_SESSION_BUS_ADDRESS = previousBus;
  });
  let captured;
  const child = new EventEmitter(); child.pid = 99999999;
  const local = {...device, avdHome: path.join(root, 'avd'), avdDir: path.join(root, 'avd', 'mobile_test.avd')};
  const backend = makeBackend({platform: 'linux', architecture: 'x64', inspectHost: async () => ({ok: true}),
    config: {dataDir: root, emulatorPath: '/sdk/emulator', headless: true, webrtc: {enabled: true}},
    runner: async () => { throw absent(); },
    spawnProcess: (...args) => { captured = args; process.nextTick(() => child.emit('spawn')); return child; },
  });
  assert.equal(await backend.launch(local), child);
  assert.ok(captured[1].includes('-no-window'));
  assert.deepEqual(captured[1].slice(captured[1].indexOf('-accel'), captured[1].indexOf('-accel') + 2), ['-accel', 'on']);
  assert.ok(captured[1].includes('-grpc-use-jwt'));
  assert.equal(captured[1][captured[1].indexOf('-grpc') + 1], '8554');
  const discovery = path.join(root, 'runtime', 'avd', 'running');
  assert.equal((await fs.stat(discovery)).mode & 0o777, 0o700);
  assert.equal(captured[2].env.XDG_RUNTIME_DIR, path.join(root, 'runtime'));
  for (const key of ['PULSE_SERVER', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']) assert.equal(Object.hasOwn(captured[2].env, key), false);
});

test('waitReady waits for both boot property and package manager, and supports abort and timeout', async () => {
  const commands = [];
  let boots = 0, packages = 0;
  const backend = makeBackend({config: {bootTimeoutMs: 1000, pollIntervalMs: 1}, runner: async (_file, args) => {
    commands.push(args.at(-1));
    if (identity(args)) return result('mobile_test\nOK\n');
    if (args.at(-1).includes('getprop')) return result(++boots === 1 ? '0' : '1');
    return result(++packages === 1 ? '' : 'package:/system/framework/framework-res.apk\n');
  }});
  await backend.waitReady(device);
  assert.equal(boots, 3); assert.equal(packages, 2);
  const controller = new AbortController();
  const aborted = makeBackend({runner: async () => {controller.abort(); return result('0');}});
  await assert.rejects(aborted.waitReady(device, {signal: controller.signal}), {name: 'AbortError'});
  const timeout = makeBackend({config: {bootTimeoutMs: 15, pollIntervalMs: 2}, runner: async () => result('0')});
  await assert.rejects(timeout.waitReady(device), /boot timed out/);
});

test('recovery verifies exact AVD name, waits for disappearance and never signals stored PID', async () => {
  let reads = 0;
  const calls = [];
  const backend = makeBackend({config: {pollIntervalMs: 1, stopTimeoutMs: 100}, runner: async (_file, args) => {
    calls.push(args.slice(6));
    if (args[6] === 'get-state') {
      if (++reads > 2) throw absent();
      return result('device\n');
    }
    if (args.at(-1) === 'name') return result('mobile_test\nOK\n');
    return result('OK\n');
  }});
  assert.deepEqual(await backend.recover({...device, pid: process.pid}), {state: 'stopped'});
  assert.equal(calls.filter(args => args.join(' ') === 'emu kill').length, 1);
  assert.equal(reads, 3);
  const mismatchCalls = [];
  const mismatch = makeBackend({runner: async (_file, args) => {
    mismatchCalls.push(args); return result(args.at(-1) === 'name' ? 'someone_else\nOK\n' : 'device\n');
  }});
  await assert.rejects(mismatch.recover(device), /identity mismatch/);
  assert.equal(mismatchCalls.some(args => args.at(-1) === 'kill'), false);
  const missing = makeBackend({runner: async () => {throw absent();}});
  assert.deepEqual(await missing.stop(device), {state: 'absent'});
});

test('recovery treats ADB stderr offline as a transient observation and never kills an unverified device', async () => {
  let calls = 0;
  const backend = makeBackend({config: {stopTimeoutMs: 1000, pollIntervalMs: 1}, runner: async (_file, args) => {
    assert.equal(args[6], 'get-state');
    if (++calls === 1) { const error = new Error('adb offline'); error.stderr = Buffer.from('error: device offline\n'); throw error; }
    throw absent();
  }});
  assert.deepEqual(await backend.recover(device), {state: 'absent'});
  assert.equal(calls, 2);
});

test('snapshot removes stale dump and returns bounded UI XML with override dimensions', async () => {
  const calls = [];
  const xml = '<?xml version="1.0"?><hierarchy rotation="0"><node text="Example" /></hierarchy>';
  const backend = makeBackend({runner: async (_file, args) => {
    if (identity(args)) return result('mobile_test\nOK\n');
    const command = args.at(-1); calls.push(command);
    if (command.startsWith("'cat'")) return result(xml);
    if (command.startsWith("'wm'")) return result('Physical size: 1080x1920\nOverride size: 720x1280\n');
    return result('');
  }});
  assert.deepEqual(await backend.snapshot(device), {xml, width: 720, height: 1280});
  assert.equal(calls[0], "'rm' '-f' '/data/local/tmp/agent-mobile-ui.xml'");
  assert.equal(calls[1], "'uiautomator' 'dump' '/data/local/tmp/agent-mobile-ui.xml'");
  const invalid = makeBackend({runner: async (_file, args) => result(identity(args) ? 'mobile_test\nOK\n' : 'ERROR: could not dump UI')});
  await assert.rejects(invalid.snapshot(device), /Invalid Android UI/);
});

test('snapshot retries transient dump failures with fresh files and verified device identity', async () => {
  const commands = []; let reads = 0, identities = 0;
  const backend = makeBackend({runner: async (_file, args) => {
    if (identity(args)) { identities++; return result('mobile_test\nOK\n'); }
    const command = args.at(-1); commands.push(command);
    if (command.startsWith("'cat'")) {
      if (++reads === 1) throw new Error('Dump did not create a file while the activity was not idle');
      return result('<hierarchy><node/></hierarchy>');
    }
    if (command.startsWith("'wm'")) return result('Physical size: 720x1280\n');
    return result('');
  }});
  assert.equal((await backend.snapshot(device)).width, 720);
  assert.equal(reads, 2); assert.equal(identities, 2);
  assert.equal(commands.filter(value => value.startsWith("'rm'")).length, 2);
  assert.equal(commands.some(value => value.startsWith("'input'")), false);
});

test('screenshot validates PNG and enforces output bounds even with custom runner', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCioAAAAASUVORK5CYII=', 'base64');
  const calls = [];
  const backend = makeBackend({runner: async (_file, args) => {if (identity(args)) return result('mobile_test\nOK\n'); calls.push(args); return {stdout: png};}});
  assert.deepEqual(await backend.screenshot(device), png);
  assert.deepEqual(calls[0].slice(6), ['exec-out', 'screencap', '-p']);
  const invalid = makeBackend({runner: async (_file, args) => result(identity(args) ? 'mobile_test\nOK\n' : 'not a PNG')});
  await assert.rejects(invalid.screenshot(device), /Invalid Android screenshot/);
  const oversized = makeBackend({runner: async (_file, args) => identity(args) ? result('mobile_test\nOK\n') : {stdout: Buffer.alloc(16 * 1024 * 1024 + 1)}});
  await assert.rejects(oversized.screenshot(device), /exceeded limit/);
});

test('packages include the Android framework package and APK installation rejects symlinks', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-apk-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  const apk = path.join(dir, 'app with spaces.apk');
  await fs.writeFile(apk, 'fixture');
  const link = path.join(dir, 'linked.apk');
  await fs.symlink(apk, link);
  const calls = [];
  const backend = makeBackend({runner: async (_file, args) => {
    if (identity(args)) return result('mobile_test\nOK\n');
    calls.push(args);
    return result(args[6] === 'install' ? 'Performing Streamed Install\nSuccess\n' : 'package:com.example.app\npackage:android\npackage:com.example.app\n');
  }});
  assert.deepEqual(await backend.apps(device), ['android', 'com.example.app']);
  assert.deepEqual(await backend.installApp(device, {apkPath: apk}), {ok: true});
  assert.deepEqual(calls[1].slice(6), ['install', '-r', apk]);
  await assert.rejects(backend.installApp(device, {apkPath: link}), /regular file/);
  await assert.rejects(backend.installApp(device, {apkPath: 'relative.apk'}), /absolute/);
});
