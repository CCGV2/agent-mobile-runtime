'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {loadConfig} = require('../src/config.cjs');
const {Provisioner} = require('../src/provision.cjs');
const {AndroidBackend} = require('../src/android.cjs');
const {MediaManager} = require('../src/media.cjs');
const {MobileRuntime} = require('../src/runtime.cjs');
const run = promisify(execFile);

test('real emulator lifecycle, private data replacement, and optional audible capture', {
  skip: !process.env.AGENT_MOBILE_TEST_CONFIG && 'Set AGENT_MOBILE_TEST_CONFIG to a config with an explicit clean template.',
  timeout: 1500000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mobile-acceptance-')));
  const config = await loadConfig(process.env.AGENT_MOBILE_TEST_CONFIG, {dataDir: root, maxDevices: 1, headless: true});
  const template = process.env.AGENT_MOBILE_TEST_TEMPLATE || Object.keys(config.templates)[0];
  assert.ok(template, 'Configure a clean template.');
  const backend = new AndroidBackend({config});
  const media = new MediaManager({config});
  const runtime = await new MobileRuntime({config, backend, media, provisioner: new Provisioner({config})}).init();
  let clean = false;
  t.after(async () => {
    try {
      for (const session of runtime.list()) await runtime.destroySession(session.id);
      clean = true;
    } finally {
      await runtime.close();
      // Never blindly rm an emulator disk after uncertain process termination.
      if (clean) await fs.rm(root, {recursive: true, force: true});
      else process.stderr.write(`Acceptance device requires operator recovery at ${root}\n`);
    }
  });
  const first = await runtime.createSession({template, key: 'acceptance-first'});
  assert.equal((await runtime.execute(first.id, 'start')).state, 'running');
  assert.ok((await runtime.execute(first.id, 'apps')).includes('android'));
  await runtime.execute(first.id, 'launch_app', {package: 'com.android.settings'});
  const shot = await runtime.execute(first.id, 'screenshot');
  assert.ok(shot.length > 33);
  assert.match((await runtime.execute(first.id, 'snapshot')).xml, /hierarchy/);

  if (process.env.AGENT_MOBILE_TEST_AUDIO_APK) {
    await runtime.execute(first.id, 'install_app', {apkPath: path.resolve(process.env.AGENT_MOBILE_TEST_AUDIO_APK)}, {operator: true});
    const recording = await runtime.execute(first.id, 'recording_start', {kind: 'screen', durationSec: 5});
    await runtime.execute(first.id, 'launch_app', {package: 'dev.agentmobile.tone'});
    await new Promise(resolve => setTimeout(resolve, 6500));
    const finished = await runtime.execute(first.id, 'recording_stop', {recordingId: recording.id});
    assert.equal(finished.state, 'completed', JSON.stringify(finished));
    assert.equal(finished.validation, 'audio-track-verified');
    const artifact = await runtime.artifact(first.id, recording.id);
    const {stderr} = await run(config.ffmpegPath, ['-hide_banner', '-i', artifact.path, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], {timeout: 20000, maxBuffer: 65536, shell: false});
    const volume = /mean_volume:\s*(-?[\d.]+) dB/.exec(stderr);
    assert.ok(volume && Number(volume[1]) > -60, 'Expected audible test tone; an audio track alone is insufficient.');
  } else t.diagnostic('Audible capture NOT tested: build the fixture and set AGENT_MOBILE_TEST_AUDIO_APK.');

  await runtime.destroySession(first.id);
  const second = await runtime.createSession({template, key: 'acceptance-second'});
  assert.notEqual(second.id, first.id);
  await runtime.execute(second.id, 'start');
  assert.ok(!(await runtime.execute(second.id, 'apps')).includes('dev.agentmobile.tone'), 'Installed fixture must not survive destruction into a new device.');
  await runtime.destroySession(second.id);
});
