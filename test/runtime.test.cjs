'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {EventEmitter} = require('node:events');
const {createHash} = require('node:crypto');
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

test('concurrent keyed attachment allocates one device and preserves its private credential', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({length: 12}, () => f.runtime.ensureSession({template: 'clean', key: 'task-a'})));
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  assert.equal(new Set(results.map(result => result.credentialFile)).size, 1);
  assert.ok(results.every(result => result.managed === true && result.state === 'stopped'));
  assert.equal(f.runtime.list().length, 1);
  assert.equal((await fs.readdir(path.join(f.config.dataDir, 'devices'))).length, 1);
  const initial = await fs.readFile(results[0].credentialFile, 'utf8');
  const expectedTokenHash = createHash('sha256').update(JSON.parse(initial).token).digest('hex');
  assert.ok(results.every(result => result.expectedTokenHash === expectedTokenHash));
  const again = await f.runtime.ensureSession({template: 'clean', key: 'task-a'});
  assert.equal(again.id, results[0].id);
  assert.equal(await fs.readFile(again.credentialFile, 'utf8'), initial);
  assert.equal(again.expectedTokenHash, expectedTokenHash);
  assert.equal(JSON.stringify(results).includes(JSON.parse(initial).token), false);
  assert.deepEqual(f.runtime.listManagedSessions(), [{id: again.id, key: 'task-a', template: 'clean', state: 'stopped'}]);
  const publicState = JSON.stringify(f.runtime.list());
  assert.ok(!publicState.includes('task-a'));
  assert.ok(!publicState.includes('mcpManaged'));
});

test('different logical keys isolate devices and stopped managed sessions still consume capacity', async t => {
  const f = await fixture(t);
  f.config.maxDevices = 2;
  const [a, b] = await Promise.all(['task-a', 'task-b'].map(key => f.runtime.ensureSession({template: 'clean', key})));
  assert.notEqual(a.id, b.id);
  const first = f.runtime.sessions.get(a.id), second = f.runtime.sessions.get(b.id);
  assert.notEqual(first.device.port, second.device.port);
  assert.notEqual(first.device.avdDir, second.device.avdDir);
  const credentialA = await credentials(a), credentialB = await credentials(b);
  assert.equal(f.runtime.authorizeSession(b.id, credentialA.token), false);
  assert.equal(f.runtime.authorizeSession(a.id, credentialB.token), false);
  await assert.rejects(f.runtime.ensureSession({template: 'clean', key: 'task-c'}), {code: 'capacity', status: 409});
  assert.equal((await f.runtime.ensureSession({template: 'clean', key: 'task-a'})).id, a.id);
  await f.runtime.destroySession(a.id);
  const c = await f.runtime.ensureSession({template: 'clean', key: 'task-c'});
  assert.notEqual(c.id, a.id);
  assert.equal(f.runtime.state(b.id).state, 'stopped');
  assert.equal(f.runtime.authorizeSession(b.id, credentialB.token), true);
});

test('keyed attachment rejects invalid keys and template changes without allocating or replacing devices', async t => {
  const f = await fixture(t);
  for (const key of [undefined, '', null, {}, 'a'.repeat(201)]) await assert.rejects(f.runtime.ensureSession({template: 'clean', key}), {code: 'invalid_key'});
  assert.equal(f.runtime.list().length, 0);
  const first = await f.runtime.ensureSession({template: 'clean', key: 'task-a'});
  f.config.templates.other = f.config.templates.clean;
  await assert.rejects(f.runtime.ensureSession({template: 'other', key: 'task-a'}), {code: 'session_template_mismatch', status: 409});
  assert.equal((await f.runtime.ensureSession({template: 'clean', key: 'task-a'})).id, first.id);
  assert.equal(f.runtime.list().length, 1);
});

test('attaching an operator-created key does not turn its persistent device into an automatically managed one', async t => {
  const f = await fixture(t);
  const manual = await f.runtime.createSession({template: 'clean', key: 'task-a'});
  const original = await fs.readFile(manual.credentialFile, 'utf8');
  const resumed = await f.runtime.ensureSession({template: 'clean', key: 'task-a'});
  assert.equal(resumed.id, manual.id);
  assert.equal(resumed.managed, false);
  assert.equal(resumed.expectedTokenHash, createHash('sha256').update(JSON.parse(original).token).digest('hex'));
  assert.equal(Object.hasOwn(manual, 'expectedTokenHash'), false);
  assert.equal(await fs.readFile(resumed.credentialFile, 'utf8'), original);
  assert.deepEqual(f.runtime.listManagedSessions(), []);
  await assert.rejects(f.runtime.createSession({template: 'clean', key: 'task-a'}), {code: 'session_exists'});
});

test('keyed reconnect never repairs missing, linked, public, invalid, or revoked credential files', async t => {
  const f = await fixture(t);
  const session = await f.runtime.ensureSession({template: 'clean', key: 'task-a'});
  const original = await fs.readFile(session.credentialFile, 'utf8');
  const value = JSON.parse(original);
  const target = path.join(f.root, 'credential-target.json');
  await fs.writeFile(target, original, {mode: 0o600});
  const mutations = [
    async () => {},
    async () => fs.symlink(target, session.credentialFile),
    async () => fs.writeFile(session.credentialFile, original, {mode: 0o644}),
    async () => fs.writeFile(session.credentialFile, value.token + ' is malformed JSON', {mode: 0o600}),
    async () => fs.writeFile(session.credentialFile, JSON.stringify({...value, sessionId: 'm-00000000-0000-4000-8000-000000000000'}), {mode: 0o600}),
    async () => fs.writeFile(session.credentialFile, JSON.stringify({...value, token: value.token === 'a'.repeat(64) ? 'b'.repeat(64) : 'a'.repeat(64)}), {mode: 0o600}),
  ];
  for (const mutate of mutations) {
    await fs.rm(session.credentialFile, {force: true});
    await mutate();
    const before = await fs.lstat(session.credentialFile).catch(() => undefined);
    await assert.rejects(f.runtime.ensureSession({template: 'clean', key: 'task-a'}), error => error.code === 'session_credentials_unavailable' && error.status === 409 && !error.message.includes(value.token));
    if (!before) await assert.rejects(fs.lstat(session.credentialFile), {code: 'ENOENT'});
    assert.equal(f.runtime.list().length, 1);
    assert.equal(f.runtime.state(session.id).state, 'stopped');
  }
  await fs.rm(session.credentialFile, {force: true});
  await fs.writeFile(session.credentialFile, original, {mode: 0o600});
  assert.equal((await f.runtime.ensureSession({template: 'clean', key: 'task-a'})).id, session.id);
});

test('managed ownership survives reload while older operator-created sessions stay persistent', async t => {
  const f = await fixture(t);
  const managed = await f.runtime.ensureSession({template: 'clean', key: 'auto'});
  const manual = await f.runtime.createSession({template: 'clean', key: 'manual'});
  const original = await fs.readFile(managed.credentialFile, 'utf8');
  await f.runtime.close();
  f.runtime = await new MobileRuntime({config: f.config, backend: f.backend, media: f.media, provisioner: f.provisioner}).init();
  assert.deepEqual(f.runtime.listManagedSessions(), [{id: managed.id, key: 'auto', template: 'clean', state: 'stopped'}]);
  assert.equal((await f.runtime.ensureSession({template: 'clean', key: 'auto'})).managed, true);
  assert.equal((await f.runtime.ensureSession({template: 'clean', key: 'manual'})).managed, false);
  assert.equal(await fs.readFile(managed.credentialFile, 'utf8'), original);
  assert.equal(f.runtime.state(manual.id).state, 'stopped');
});

test('saved routing identities and managed ownership are validated before restoring sessions', async t => {
  const f = await fixture(t);
  await f.runtime.ensureSession({template: 'clean', key: 'auto'});
  await f.runtime.close();
  const file = path.join(f.config.dataDir, 'runtime.json');
  const original = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const edit of [
    value => { value.sessions[0].mcpManaged = 'yes'; },
    value => { delete value.sessions[0].key; },
    value => { value.sessions.push({...value.sessions[0]}); },
  ]) {
    const changed = structuredClone(original); edit(changed);
    await fs.writeFile(file, JSON.stringify(changed));
    await assert.rejects(new MobileRuntime({config: f.config, backend: f.backend, media: f.media, provisioner: f.provisioner}).init(), /runtime session|managed MCP|Duplicate runtime/);
  }
  await fs.writeFile(file, JSON.stringify(original));
});

test('shutdown drains and rolls back an allocation that is still provisioning before unlocking', async t => {
  const f = await fixture(t);
  const originalCreate = f.provisioner.create.bind(f.provisioner);
  let entered, release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  f.provisioner.create = async options => {
    const device = await originalCreate(options);
    entered();
    await released;
    return device;
  };
  const allocation = f.runtime.ensureSession({template: 'clean', key: 'auto'});
  const rejected = assert.rejects(allocation, {code: 'closing', status: 503});
  await enteredPromise;
  const closed = f.runtime.close();
  assert.equal(f.runtime.closing, true);
  assert.ok((await fs.stat(f.runtime.lockFile)).isFile());
  release();
  await Promise.all([closed, rejected]);
  assert.deepEqual(f.runtime.list(), []);
  assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'devices')), []);
  assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'secrets', 'sessions')), []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.config.dataDir, 'runtime.json'), 'utf8')).sessions, []);
  await assert.rejects(fs.stat(f.runtime.lockFile), {code: 'ENOENT'});
});

test('bound session capabilities are checked inside the lock after failed destruction revokes credentials', async t => {
  const f = await fixture(t);
  const session = await f.runtime.ensureSession({template: 'clean', key: 'auto'});
  const credential = await credentials(session);
  const expectedTokenHash = createHash('sha256').update(credential.token).digest('hex');
  let entered, release;
  const stopping = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  f.media.stopDevice = async () => { entered(); await gate; };
  let reads = 0;
  f.media.artifact = async () => { reads++; return {path: '/must-not-read'}; };
  f.provisioner.destroy = async () => { throw new Error('Test disk deletion failed.'); };
  const destroyed = assert.rejects(f.runtime.destroySession(session.id), /Test disk deletion failed/);
  await stopping;
  assert.equal(f.runtime.authorizeSession(session.id, credential.token), true, 'Credentials were valid before these requests queued.');
  const denials = [
    assert.rejects(f.runtime.execute(session.id, 'state', {}, {expectedTokenHash}), {code: 'unauthorized', status: 401}),
    assert.rejects(f.runtime.execute(session.id, 'start', {}, {expectedTokenHash}), {code: 'unauthorized', status: 401}),
    assert.rejects(f.runtime.artifact(session.id, '00000000-0000-4000-8000-000000000000', {expectedTokenHash}), {code: 'unauthorized', status: 401}),
  ];
  release();
  await Promise.all([destroyed, ...denials]);
  assert.equal(f.runtime.authorizeSession(session.id, credential.token), false);
  assert.equal(f.runtime.state(session.id).state, 'stopped');
  assert.equal((await f.runtime.execute(session.id, 'state')).id, session.id, 'Trusted operator calls without a captured capability stay compatible.');
  assert.equal(f.backend.launched.length, 0);
  assert.equal(reads, 0);
});

test('keyed attachment captures the validated credential hash even if revocation immediately follows validation', async t => {
  const f = await fixture(t);
  const session = await f.runtime.ensureSession({template: 'clean', key: 'auto'});
  const original = f.runtime.authorizeSession.bind(f.runtime);
  f.runtime.authorizeSession = (id, token) => {
    const authorized = original(id, token);
    if (authorized) f.runtime.sessions.get(id).tokenHash = 'f'.repeat(64);
    return authorized;
  };
  const attached = await f.runtime.ensureSession({template: 'clean', key: 'auto'});
  assert.equal(attached.expectedTokenHash, session.expectedTokenHash);
  assert.notEqual(attached.expectedTokenHash, f.runtime.sessions.get(session.id).tokenHash);
  await assert.rejects(f.runtime.execute(session.id, 'state', {}, {expectedTokenHash: attached.expectedTokenHash}), {code: 'unauthorized', status: 401});
});

test('invalid expected session capabilities are rejected even for state and artifact reads', async t => {
  const f = await fixture(t);
  const session = await f.runtime.createSession({template: 'clean'});
  const credential = await credentials(session);
  const correct = createHash('sha256').update(credential.token).digest('hex');
  assert.equal((await f.runtime.execute(session.id, 'state', {}, {expectedTokenHash: correct})).id, session.id);
  for (const expectedTokenHash of [null, {}, Buffer.alloc(32), 'invalid', '0'.repeat(64)]) {
    await assert.rejects(f.runtime.execute(session.id, 'state', {}, {expectedTokenHash, operator: true}), {code: 'unauthorized', status: 401});
    await assert.rejects(f.runtime.artifact(session.id, '00000000-0000-4000-8000-000000000000', {expectedTokenHash}), {code: 'unauthorized', status: 401});
  }
});

test('an invalid bound capability cannot abort a boot before locked authentication', async t => {
  const f = await fixture(t);
  const session = await f.runtime.createSession({template: 'clean'});
  const credential = await credentials(session);
  const expectedTokenHash = createHash('sha256').update(credential.token).digest('hex');
  let entered, finishBoot, signal;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.backend.onWaitReady = (_device, options) => new Promise((resolve, reject) => {
    signal = options.signal; finishBoot = resolve;
    signal.addEventListener('abort', () => {
      const error = new Error('Fake boot aborted'); error.name = 'AbortError'; reject(error);
    }, {once: true});
    entered();
  });
  const started = f.runtime.execute(session.id, 'start', {}, {expectedTokenHash}).then(value => ({value}), error => ({error}));
  await waiting;
  const stopped = f.runtime.execute(session.id, 'stop', {}, {expectedTokenHash: '0'.repeat(64)}).then(value => ({value}), error => ({error}));
  const wasAborted = signal.aborted;
  finishBoot();
  const [start, stop] = await Promise.all([started, stopped]);
  assert.equal(wasAborted, false);
  assert.equal(start.value?.state, 'running');
  assert.equal(stop.error?.code, 'unauthorized');
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
  // Concurrent starts can finish their private disk writes in either order.
  assert.deepEqual(f.backend.launched.find(item => item.device.id === a.id).child.signals, ['SIGTERM']);
  assert.deepEqual(f.backend.launched.find(item => item.device.id === b.id).child.signals, []);
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
