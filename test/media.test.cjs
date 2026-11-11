const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter} = require('node:events');
const {randomUUID} = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {MediaManager} = require('../src/media.cjs');
const execFileAsync = promisify(execFile);

const EBML = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]);
const OPUS = Buffer.from('OggS\0\0\0\0OpusHead\0\0\0\0');
const device = {id: 'test-device', serial: 'emulator-5554'};

async function fixture(t, overrides = {}, behavior = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-media-'));
  const calls = [];
  const events = [];
  const config = {dataDir, adbServerPort: 5044, adbPath: '/tools/adb', scrcpyPath: '/tools/scrcpy', mediaMaxDurationSec: 120, mediaMaxBytes: 1024, mediaPollMs: 10, mediaStopTimeoutMs: 20, ...overrides};
  const spawnProcess = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = 43210;
    child.signals = [];
    const output = args.find(arg => arg.startsWith('--record=')).slice('--record='.length);
    child.kill = signal => {
      child.signals.push(signal);
      if (!behavior.ignoreKill) setImmediate(() => child.emit('close', null, signal));
      return true;
    };
    calls.push({file, args, options, child, output});
    setImmediate(async () => {
      try {
        if (behavior.spawnError) return child.emit('error', new Error('private details must not escape'));
        if (behavior.beforeSpawn) await behavior.beforeSpawn(child, output);
        if (!behavior.noFile) await fs.writeFile(output, behavior.contents || (args.includes('--no-video') ? OPUS : EBML));
        child.emit('spawn');
      } catch (error) { child.emit('error', error); }
    });
    return child;
  };
  const manager = new MediaManager({config, spawnProcess, onEvent: event => events.push(event)});
  t.after(async () => { await manager.shutdown().catch(() => {}); await fs.rm(dataDir, {recursive: true, force: true}); });
  return {manager, config, calls, events, dataDir};
}

test('screen recording selects exactly the managed emulator and isolates subprocess environment', async t => {
  const {manager, calls} = await fixture(t);
  const record = await manager.start(device, {durationSec: 20});
  assert.equal(record.state, 'recording');
  assert.equal(record.kind, 'screen');
  assert.equal(calls[0].file, '/tools/scrcpy');
  assert.deepEqual(calls[0].args.slice(0, 6), ['--serial', 'emulator-5554', '--no-playback', '--no-window', '--no-control', '--require-audio']);
  assert.ok(calls[0].args.includes('--time-limit=20'));
  assert.equal(calls[0].options.env.ADB_SERVER_SOCKET, 'tcp:127.0.0.1:5044');
  assert.equal(calls[0].options.env.ADB, '/tools/adb');
  assert.equal(calls[0].options.env.ANDROID_USER_HOME, path.join(manager.config.dataDir, 'android-home'));
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(calls[0].options.shell, false);
  assert.equal(record.path, undefined);
  assert.equal((await manager.stop(device.id, record.id)).state, 'completed');
  assert.deepEqual(calls[0].child.signals, ['SIGINT']);
  const artifact = await manager.artifact(device.id, record.id);
  assert.equal(artifact.mime, 'video/x-matroska');
  assert.equal(artifact.size, EBML.length);
  assert.ok(artifact.path.endsWith(record.id + '.mkv'));
  const complete = (await manager.list(device.id))[0];
  assert.equal(complete.validation, 'container-header');
});

test('audio-only capture preserves Opus output and enforces one active recording per device', async t => {
  const {manager, calls} = await fixture(t);
  const results = await Promise.allSettled([manager.start(device, {kind: 'audio'}), manager.start(device, {kind: 'audio'})]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes('--no-video'));
  const record = results.find(result => result.status === 'fulfilled').value;
  await manager.stopDevice(device.id);
  assert.equal((await manager.artifact(device.id, record.id)).mime, 'audio/ogg');
});

test('stopping and reading artifacts are bound to device identity', async t => {
  const {manager} = await fixture(t);
  const record = await manager.start(device);
  await assert.rejects(manager.artifact(device.id, record.id), /Completed recording/);
  await assert.rejects(manager.stop('other-device', record.id), /not found/);
  await manager.stop(device.id, record.id);
  await assert.rejects(manager.artifact('other-device', record.id), /not found/);
  await assert.rejects(manager.artifact(device.id, '../anything'), /identifier/);
  await assert.rejects(manager.list('../device'), /identifier/);
});

test('duration, kind, and real-device targets are rejected before process launch', async t => {
  const {manager, calls} = await fixture(t);
  for (const options of [{durationSec: 0}, {durationSec: 121}, {durationSec: 1.5}, {kind: 'camera'}, {kind: '__proto__'}]) await assert.rejects(manager.start(device, options));
  await assert.rejects(manager.start({...device, serial: 'physical-phone'}), /managed emulator/);
  assert.equal(calls.length, 0);
});

test('spawn failure releases reservation and never exposes raw child error', async t => {
  const {manager} = await fixture(t, {}, {spawnError: true});
  await assert.rejects(manager.start(device), /verify scrcpy installation/);
  const [record] = await manager.list(device.id);
  assert.equal(record.state, 'failed');
  assert.doesNotMatch(record.error, /private details/);
  await assert.rejects(manager.artifact(device.id, record.id));
});

test('missing or invalid finalized media is marked failed', async t => {
  const {manager} = await fixture(t, {}, {contents: Buffer.from('not an EBML file')});
  const record = await manager.start(device);
  const result = await manager.stop(device.id, record.id);
  assert.equal(result.state, 'failed');
  assert.equal(result.validation, undefined);
  await assert.rejects(manager.artifact(device.id, record.id));
});

test('nonzero child exit fails recording even if a container header was written', async t => {
  const {manager, calls} = await fixture(t);
  const record = await manager.start(device);
  calls[0].child.emit('close', 1, null);
  await calls[0].child;
  await manager.stop(device.id, record.id);
  const [result] = await manager.list(device.id);
  assert.equal(result.state, 'failed');
  assert.match(result.error, /exited unsuccessfully/);
});

test('byte cap terminates and removes oversized recording', async t => {
  const {manager, calls} = await fixture(t, {mediaMaxBytes: 32}, {contents: Buffer.concat([EBML, Buffer.alloc(128)])});
  const record = await manager.start(device);
  const deadline = Date.now() + 2000;
  while ((await manager.list(device.id))[0].state !== 'failed' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  const result = (await manager.list(device.id))[0];
  assert.equal(result.state, 'failed');
  assert.match(result.error, /byte limit/);
  assert.deepEqual(calls[0].child.signals, ['SIGINT']);
  await assert.rejects(fs.stat(calls[0].output), {code: 'ENOENT'});
  await assert.rejects(manager.artifact(device.id, record.id));
});

test('service restart preserves completed recordings and marks interrupted ones failed without signaling PID', async t => {
  const {manager, calls, config, dataDir} = await fixture(t);
  const complete = await manager.start(device, {kind: 'audio'});
  await manager.stop(device.id, complete.id);
  const interruptedId = randomUUID();
  const directory = path.join(dataDir, 'devices', device.id, 'artifacts', 'media');
  await fs.writeFile(path.join(directory, interruptedId + '.json'), JSON.stringify({id: interruptedId, deviceId: device.id, kind: 'screen', state: 'recording', startedAt: new Date().toISOString(), durationSec: 10, bytes: 0, pid: process.pid}));
  const restarted = new MediaManager({config, spawnProcess: () => { throw new Error('must not spawn'); }});
  const records = await restarted.list(device.id);
  assert.equal(records.find(record => record.id === interruptedId).state, 'failed');
  assert.match(records.find(record => record.id === interruptedId).error, /runtime restart/);
  assert.equal((await restarted.artifact(device.id, complete.id)).mime, 'audio/ogg');
  assert.equal(calls.length, 1);
  await restarted.shutdown();
});

test('artifact symlinks and media directory symlinks are rejected', async t => {
  const {manager, calls, dataDir} = await fixture(t);
  const record = await manager.start(device);
  await manager.stop(device.id, record.id);
  const outside = path.join(dataDir, 'outside');
  await fs.writeFile(outside, EBML);
  await fs.unlink(calls[0].output);
  await fs.symlink(outside, calls[0].output);
  await assert.rejects(manager.artifact(device.id, record.id), /changed/);
  const newDeviceRoot = path.join(dataDir, 'devices', 'linked-device');
  await fs.symlink(path.join(dataDir, 'devices', device.id), newDeviceRoot);
  await assert.rejects(manager.list('linked-device'), /directory/);
});

test('termination escalates and blocks device cleanup if child exit cannot be confirmed', async t => {
  const {manager, calls} = await fixture(t, {}, {ignoreKill: true});
  await manager.start(device);
  await assert.rejects(manager.stopDevice(device.id), /termination not confirmed/);
  assert.deepEqual(calls[0].child.signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);
});

test('shutdown waits for active recordings and refuses subsequent starts', async t => {
  const {manager, calls} = await fixture(t);
  await manager.start(device);
  await manager.shutdown();
  assert.equal((await manager.list(device.id))[0].state, 'completed');
  assert.equal(calls[0].child.signals[0], 'SIGINT');
  await assert.rejects(manager.start(device), /shutting down/);
});

test('shutdown also cancels a start which is still loading storage', async t => {
  const {manager, calls} = await fixture(t);
  const starting = manager.start(device);
  await manager.shutdown();
  await assert.rejects(starting, /shutting down/);
  assert.equal(calls.length, 0);
});

test('device cleanup waits until final recording metadata is committed', async t => {
  const {manager, calls} = await fixture(t);
  await manager.start(device);
  const persist = manager.persist.bind(manager);
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  manager.persist = async record => {
    if (record.state === 'completed') { entered(); await gate; }
    return persist(record);
  };
  calls[0].child.emit('close', 0, null);
  await waiting;
  let cleaned = false;
  const cleanup = manager.stopDevice(device.id).then(() => { cleaned = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cleaned, false);
  release();
  await cleanup;
  assert.equal(cleaned, true);
});

test('aggregate device quota includes previous recordings', async t => {
  const {manager, calls} = await fixture(t, {mediaMaxBytes: EBML.length});
  const first = await manager.start(device);
  assert.equal((await manager.stop(device.id, first.id)).state, 'completed');
  await assert.rejects(manager.start(device), /storage quota/);
  assert.equal(calls.length, 1);
});

test('unfinished files from prior crashes consume device quota', async t => {
  const {manager, calls} = await fixture(t, {mediaMaxBytes: 32});
  const directory = await manager.directory(device.id);
  await fs.writeFile(path.join(directory, randomUUID() + '.mkv'), Buffer.alloc(32));
  await assert.rejects(manager.start(device), /storage quota/);
  assert.equal(calls.length, 0);
});

test('ffprobe verifies real audio/video tracks and rejects silent video', async t => {
  try {
    await execFileAsync('ffmpeg', ['-version']);
    await execFileAsync('ffprobe', ['-version']);
  } catch (error) {
    if (error.code === 'ENOENT') return t.skip('ffmpeg and ffprobe are not installed');
    throw error;
  }
  const fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-media-tracks-'));
  t.after(() => fs.rm(fixtureDir, {recursive: true, force: true}));
  const media = path.join(fixtureDir, 'fixture.mkv');
  await execFileAsync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=16x16:r=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-t', '0.5', '-c:v', 'ffv1', '-c:a', 'pcm_s16le', '-y', media], {timeout: 15000});
  const good = await fixture(t, {ffprobePath: 'ffprobe', mediaMaxBytes: 1024 * 1024}, {contents: await fs.readFile(media)});
  const record = await good.manager.start(device);
  const completed = await good.manager.stop(device.id, record.id);
  assert.equal(completed.state, 'completed');
  assert.equal(completed.validation, 'audio-track-verified');
  const silent = path.join(fixtureDir, 'silent.mkv');
  await execFileAsync('ffmpeg', ['-v', 'error', '-i', media, '-an', '-c:v', 'copy', '-y', silent], {timeout: 15000});
  const bad = await fixture(t, {ffprobePath: 'ffprobe', mediaMaxBytes: 1024 * 1024}, {contents: await fs.readFile(silent)});
  const invalid = await bad.manager.start(device);
  assert.equal((await bad.manager.stop(device.id, invalid.id)).state, 'failed');
});
