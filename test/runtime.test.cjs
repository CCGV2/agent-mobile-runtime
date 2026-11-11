'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {EventEmitter} = require('node:events');
const {MobileRuntime} = require('../src/runtime.cjs');
const {Provisioner} = require('../src/provision.cjs');

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 99999999;
    this.signals = [];
    this.stdout = this.stderr = {resume() {}};
  }
  kill(signal) {
    this.signals.push(signal);
    if (!this.ignoreKill) queueMicrotask(() => this.emit('exit', 0, signal));
    return true;
  }
}

function fakeBackend() {
  return {
    launched: [], recovered: [], calls: [],
    async launch(device) {
      if (this.onLaunch) await this.onLaunch(device);
      const child = new FakeChild();
      this.launched.push({device: {...device}, child});
      return child;
    },
    async waitReady(device, options) { if (this.onWaitReady) return this.onWaitReady(device, options); },
    async recover(device) { this.recovered.push({...device}); return this.recovery || {state: 'absent'}; },
    async snapshot(device) { this.calls.push({id: device.id, action: 'snapshot'}); return {xml: '<hierarchy/>', width: 1080, height: 1920}; },
    async screenshot(device) { this.calls.push({id: device.id, action: 'screenshot'}); return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCioAAAAASUVORK5CYII=', 'base64'); },
    async text(device, args) { this.calls.push({id: device.id, action: 'text', args}); return {ok: true}; },
    async tap(device, args) {
      this.calls.push({id: device.id, action: 'tap', args});
      if (this.tapError) throw this.tapError;
      return {ok: true};
    },
  };
}

function fakeMedia() {
  return {
    stopped: [], shutdownCalls: 0,
    async stopDevice(id) { this.stopped.push(id); },
    async list() { return []; },
    async start(device, args) { return {deviceId: device.id, ...args}; },
    async stop(deviceId, recordingId) { return {deviceId, recordingId}; },
    async artifact(deviceId, recordingId) { return {deviceId, recordingId}; },
    async shutdown() { this.shutdownCalls++; },
  };
}

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-runtime-'));
  const root = await fs.realpath(temporary);
  const avdDir = path.join(root, 'baseline.avd');
  await fs.mkdir(avdDir);
  await fs.writeFile(path.join(avdDir, 'config.ini'), 'AvdId=baseline\nimage.sysdir.1=system-images/android-35/default/x86_64/\n');
  await fs.writeFile(path.join(avdDir, 'userdata-qemu.img'), 'clean baseline');
  const config = {dataDir: path.join(root, 'runtime'), templates: {clean: {avdDir}}, maxDevices: 3, emulatorPortStart: 5554, stopTimeoutMs: 20};
  const backend = fakeBackend();
  const media = fakeMedia();
  const provisioner = new Provisioner({config});
  const runtime = await new MobileRuntime({config, backend, media, provisioner}).init();
  const f = {root, config, backend, media, provisioner, runtime};
  t.after(async () => {
    if (!f.runtime.closing) await f.runtime.close().catch(() => {});
    await fs.rm(root, {recursive: true, force: true});
  });
  return f;
}

async function credentials(created) {
  return JSON.parse(await fs.readFile(created.credentialFile, 'utf8'));
}

function waitForBoot(backend) {
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  backend.onWaitReady = (_device, {signal}) => new Promise((resolve, reject) => {
    const aborted = () => {
      const error = new Error('Fake boot aborted'); error.name = 'AbortError'; reject(error);
    };
    signal.addEventListener('abort', aborted, {once: true});
    if (signal.aborted) aborted();
    entered();
  });
  return ready;
}

test('credentials are scoped to one session and separate from the operator credential', async t => {
  const f = await fixture(t);
  const first = await f.runtime.createSession({template: 'clean', key: 'pax-session-a'});
  const second = await f.runtime.createSession({template: 'clean', key: 'pax-session-b'});
  const a = await credentials(first); const b = await credentials(second);
  const admin = (await fs.readFile(path.join(f.config.dataDir, 'secrets', 'admin-token'), 'utf8')).trim();
  assert.equal(a.sessionId, first.id);
  assert.equal(f.runtime.authorizeSession(first.id, a.token), true);
  assert.equal(f.runtime.authorizeSession(second.id, a.token), false);
  assert.equal(f.runtime.authorizeSession(first.id, b.token), false);
  assert.equal(f.runtime.authorizeAdmin(a.token), false);
  assert.equal(f.runtime.authorizeSession(first.id, admin), false);
  assert.equal(f.runtime.authorizeAdmin(admin), true);
  assert.equal(f.runtime.authorizeSession(first.id, 'x'.repeat(1000)), false);
  const inventory = JSON.stringify(f.runtime.list());
  assert.ok(!inventory.includes(a.token));
  assert.ok(!inventory.includes('credentialFile'));
  assert.ok(!inventory.includes(f.config.dataDir));
  assert.equal(f.runtime.state(first.id).capabilities.hostNetworkIsolation, false);
  assert.equal(f.runtime.state(first.id).capabilities.realtimeMedia, false);
  if (process.platform !== 'win32') assert.equal((await fs.stat(first.credentialFile)).mode & 0o777, 0o600);
  await assert.rejects(f.runtime.createSession({template: 'clean', key: 'pax-session-a'}), {code: 'session_exists'});
});

test('starts, stops, and destroys private devices without affecting another session', async t => {
  const f = await fixture(t);
  const a = await f.runtime.createSession({template: 'clean'});
  const b = await f.runtime.createSession({template: 'clean'});
  const token = (await credentials(a)).token;
  await Promise.all([f.runtime.execute(a.id, 'start'), f.runtime.execute(b.id, 'start')]);
  assert.equal(f.runtime.state(a.id).state, 'running');
  assert.equal(f.runtime.state(b.id).state, 'running');
  assert.deepEqual(f.backend.launched.map(item => item.device.port).sort(), [5554, 5556]);
  const aDevice = f.runtime.sessions.get(a.id).device;
  const bDevice = f.runtime.sessions.get(b.id).device;
  assert.notEqual(aDevice.avdDir, bDevice.avdDir);
  await fs.writeFile(path.join(aDevice.avdDir, 'userdata-qemu.img'), 'a-only data');
  assert.equal(await fs.readFile(path.join(bDevice.avdDir, 'userdata-qemu.img'), 'utf8'), 'clean baseline');
  await f.runtime.execute(a.id, 'stop');
  assert.equal(f.runtime.state(a.id).state, 'stopped');
  assert.equal(f.runtime.state(b.id).state, 'running');
  assert.deepEqual(f.backend.launched[0].child.signals, ['SIGTERM']);
  assert.deepEqual(f.backend.launched[1].child.signals, []);
  await f.runtime.destroySession(a.id);
  assert.equal(f.runtime.authorizeSession(a.id, token), false);
  assert.equal(f.runtime.state(b.id).state, 'running');
  await assert.rejects(fs.stat(aDevice.deviceDir), {code: 'ENOENT'});
  await assert.rejects(fs.stat(a.credentialFile), {code: 'ENOENT'});
  assert.equal((await fs.stat(bDevice.deviceDir)).isDirectory(), true);
});

test('persists launch intent before spawning any emulator process', async t => {
  const f = await fixture(t);
  const created = await f.runtime.createSession({template: 'clean'});
  f.backend.onLaunch = async device => {
    const stored = JSON.parse(await fs.readFile(path.join(f.config.dataDir, 'runtime.json'), 'utf8')).sessions.find(session => session.id === device.id);
    assert.equal(stored.state, 'booting');
    assert.equal(stored.recoveryRequired, true);
    assert.equal(stored.launchIntent, true);
    assert.equal(stored.device.pid, undefined);
  };
  await f.runtime.execute(created.id, 'start');
  assert.equal(f.runtime.state(created.id).state, 'running');
});

test('takeover stops capture and blocks agent observations and input until explicit release', async t => {
  const f = await fixture(t);
  const created = await f.runtime.createSession({template: 'clean'});
  await f.runtime.execute(created.id, 'start');
  await f.runtime.execute(created.id, 'takeover', {}, {operator: true});
  assert.ok(f.media.stopped.includes(created.id));
  assert.equal(f.runtime.state(created.id).takeover, true);
  for (const action of ['snapshot', 'screenshot', 'tap', 'recording_start', 'recording_list', 'stop']) {
    await assert.rejects(f.runtime.execute(created.id, action, {x: 1, y: 1}), {code: 'human_control'});
  }
  await assert.rejects(f.runtime.artifact(created.id, 'recording'), {code: 'human_control'});
  assert.equal((await f.runtime.execute(created.id, 'state')).takeover, true);
  await f.runtime.execute(created.id, 'screenshot', {}, {operator: true});
  await assert.rejects(f.runtime.execute(created.id, 'release'), {code: 'unknown_action'});
  await f.runtime.execute(created.id, 'release', {}, {operator: true});
  await f.runtime.execute(created.id, 'tap', {x: 1, y: 2});
  assert.equal(f.runtime.state(created.id).takeover, false);
});

test('a stop request aborts boot instead of waiting for its full readiness timeout', async t => {
  const f = await fixture(t);
  const created = await f.runtime.createSession({template: 'clean'});
  const entered = waitForBoot(f.backend);
  const start = f.runtime.execute(created.id, 'start');
  const rejected = assert.rejects(start, {name: 'AbortError'});
  await entered;
  const stopped = await f.runtime.execute(created.id, 'stop');
  await rejected;
  assert.equal(stopped.state, 'stopped');
  assert.deepEqual(f.backend.launched[0].child.signals, ['SIGTERM']);
  assert.equal(f.runtime.children.size, 0);
});

test('shutdown aborts an in-flight boot, clears children, and removes the service lock', async t => {
  const f = await fixture(t);
  const created = await f.runtime.createSession({template: 'clean'});
  const entered = waitForBoot(f.backend);
  const start = f.runtime.execute(created.id, 'start');
  const rejected = assert.rejects(start, {name: 'AbortError'});
  await entered;
  await f.runtime.close();
  await rejected;
  assert.equal(f.runtime.state(created.id).state, 'stopped');
  assert.equal(f.runtime.children.size, 0);
  assert.equal(f.media.shutdownCalls, 1);
  await assert.rejects(fs.stat(path.join(f.config.dataDir, 'service.lock')), {code: 'ENOENT'});
  await assert.rejects(f.runtime.destroySession(created.id), {code: 'closing'});
  await assert.rejects(f.runtime.createSession({template: 'clean'}), {code: 'closing'});
});

test('a pending launch recovered after restart requires explicit operator confirmation', async t => {
  const f = await fixture(t);
  const created = await f.runtime.createSession({template: 'clean'});
  const token = (await credentials(created)).token;
  await f.runtime.close();
  const stateFile = path.join(f.config.dataDir, 'runtime.json');
  const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  saved.sessions[0].state = 'booting';
  saved.sessions[0].recoveryRequired = true;
  saved.sessions[0].launchIntent = true;
  delete saved.sessions[0].device.pid;
  await fs.writeFile(stateFile, JSON.stringify(saved));
  f.backend = fakeBackend(); f.media = fakeMedia();
  f.runtime = await new MobileRuntime({config: f.config, backend: f.backend, media: f.media, provisioner: f.provisioner}).init();
  assert.equal(f.runtime.state(created.id).state, 'interrupted');
  assert.equal(f.runtime.authorizeSession(created.id, token), true);
  await assert.rejects(f.runtime.execute(created.id, 'start'), {code: 'recovery_required'});
  await assert.rejects(f.runtime.execute(created.id, 'stop'), {code: 'recovery_required'});
  await assert.rejects(f.runtime.destroySession(created.id), {code: 'recovery_required'});
  assert.equal((await fs.stat(saved.sessions[0].device.deviceDir)).isDirectory(), true);
  await assert.rejects(f.runtime.execute(created.id, 'recover', {confirmStopped: true}), {code: 'unknown_action'});
  await assert.rejects(f.runtime.execute(created.id, 'recover', {}, {operator: true}), {code: 'confirmation_required'});
  const recovered = await f.runtime.execute(created.id, 'recover', {confirmStopped: true}, {operator: true});
  assert.equal(recovered.state, 'stopped');
  await f.runtime.destroySession(created.id);
  assert.equal(f.runtime.authorizeSession(created.id, token), false);
});

test('failed destruction revokes the credential before retaining data for operator recovery', async t => {
  const f = await fixture(t);
  const created = await f.runtime.createSession({template: 'clean'});
  const token = (await credentials(created)).token;
  const device = f.runtime.sessions.get(created.id).device;
  const markerFile = path.join(device.deviceDir, 'managed.json');
  const marker = await fs.readFile(markerFile, 'utf8');
  await fs.writeFile(markerFile, JSON.stringify({schema: 1, id: 'wrong', template: 'clean'}));
  await assert.rejects(f.runtime.destroySession(created.id), /ownership marker/);
  assert.equal(f.runtime.authorizeSession(created.id, token), false);
  assert.equal(f.runtime.state(created.id).state, 'stopped');
  await assert.rejects(fs.stat(created.credentialFile), {code: 'ENOENT'});
  assert.equal((await fs.stat(device.deviceDir)).isDirectory(), true);
  await fs.writeFile(markerFile, marker);
  await f.runtime.destroySession(created.id);
});

test('ambiguous input failures are not replayed and audit omits input values', async t => {
  const f = await fixture(t);
  const created = await f.runtime.createSession({template: 'clean'});
  await f.runtime.execute(created.id, 'start');
  await f.runtime.execute(created.id, 'text', {text: 'private-sentinel-password'});
  f.backend.tapError = new Error('uncertain transport result');
  await assert.rejects(f.runtime.execute(created.id, 'tap', {x: 4, y: 5}), /uncertain/);
  assert.equal(f.backend.calls.filter(call => call.action === 'tap').length, 1);
  const audit = await fs.readFile(path.join(f.config.dataDir, 'audit.jsonl'), 'utf8');
  assert.ok(!audit.includes('private-sentinel-password'));
  assert.ok(!audit.includes(f.config.dataDir));
  const entries = audit.trim().split('\n').map(line => JSON.parse(line));
  assert.ok(entries.some(entry => entry.operation === 'tap' && entry.outcome === 'failed_or_uncertain'));
});

test('a second service cannot acquire or remove an active data-directory lock', async t => {
  const f = await fixture(t);
  const second = new MobileRuntime({config: f.config, backend: fakeBackend(), media: fakeMedia(), provisioner: f.provisioner});
  await assert.rejects(second.init(), {code: 'runtime_locked'});
  assert.equal((await fs.stat(path.join(f.config.dataDir, 'service.lock'))).isFile(), true);
});

test('shutdown retains interrupted state when an owned child refuses both termination signals', async t => {
  const f = await fixture(t);
  const created = await f.runtime.createSession({template: 'clean'});
  await f.runtime.execute(created.id, 'start');
  const child = f.backend.launched[0].child; child.ignoreKill = true;
  await assert.rejects(f.runtime.close(), AggregateError);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.runtime.state(created.id).state, 'interrupted');
  assert.equal(f.runtime.state(created.id).recoveryRequired, true);
  await assert.rejects(fs.stat(path.join(f.config.dataDir, 'service.lock')), {code: 'ENOENT'});
});

test('agent stop cannot abort a boot that is owned by an operator takeover', async t => {
  const f = await fixture(t);
  const created = await f.runtime.createSession({template: 'clean'});
  await f.runtime.execute(created.id, 'takeover', {}, {operator: true});
  let entered, finishBoot, signal;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.backend.onWaitReady = (_device, options) => new Promise((resolve, reject) => {
    signal = options.signal; finishBoot = resolve;
    signal.addEventListener('abort', () => {
      const error = new Error('Fake boot aborted'); error.name = 'AbortError'; reject(error);
    }, {once: true});
    entered();
  });
  const start = f.runtime.execute(created.id, 'start', {}, {operator: true}).then(value => ({value}), error => ({error}));
  await waiting;
  const stop = f.runtime.execute(created.id, 'stop').then(value => ({value}), error => ({error}));
  const wasAborted = signal.aborted;
  finishBoot();
  const [started, stopped] = await Promise.all([start, stop]);
  assert.equal(wasAborted, false, 'Rejected agent input must not cancel operator work');
  assert.equal(started.value?.state, 'running');
  assert.equal(stopped.error?.code, 'human_control');
});

test('shutdown during asynchronous launch preflight also aborts subsequent readiness waiting', async t => {
  const f = await fixture(t);
  const created = await f.runtime.createSession({template: 'clean'});
  let entered, finishLaunch;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.backend.onLaunch = () => new Promise(resolve => { finishLaunch = resolve; entered(); });
  f.backend.onWaitReady = async (_device, {signal}) => {
    assert.equal(signal.aborted, true, 'Closing during launch must cancel boot before readiness polling');
    const error = new Error('Fake boot aborted'); error.name = 'AbortError'; throw error;
  };
  const start = f.runtime.execute(created.id, 'start').then(value => ({value}), error => ({error}));
  await waiting;
  const closing = f.runtime.close();
  finishLaunch();
  const result = await start;
  await closing;
  assert.equal(result.error?.name, 'AbortError');
  assert.equal(f.runtime.state(created.id).state, 'stopped');
});
