'use strict';

// Opt-in deployment acceptance: a disposable real emulator, actual authenticated
// gRPC capture, and an ordinary Chrome viewer. No physical device is used.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {once} = require('node:events');
const {spawn} = require('node:child_process');
const {createRequire} = require('node:module');
const {loadConfig} = require('../src/config.cjs');
const {AndroidBackend} = require('../src/android.cjs');
const {Provisioner} = require('../src/provision.cjs');
const {MediaManager} = require('../src/media.cjs');
const {MobileRuntime} = require('../src/runtime.cjs');
const {WebRTCManager} = require('../src/webrtc.cjs');
const {resolveEmulatorGrpc} = require('../src/emulator-grpc.cjs');
const {createServer} = require('../src/server.cjs');

test('real emulator sends decoded video and audible internal audio to Chrome, then logout reaps its media worker', {
  skip: !(process.env.AGENT_MOBILE_TEST_CONFIG && process.env.AGENT_MOBILE_TEST_AUDIO_APK && process.env.AGENT_MOBILE_PLAYWRIGHT_MODULE && process.env.AGENT_MOBILE_CHROME) && 'Set real Android config, tone APK, Playwright module and Chrome paths.',
  timeout: 800000,
}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-rtc-emulator-')));
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const config = await loadConfig(process.env.AGENT_MOBILE_TEST_CONFIG, {dataDir: root, maxDevices: 1, headless: true, controlPort: port});
  assert.equal(config.webrtc.enabled, true, 'Prepare an explicit private WebRTC config first.');
  const template = process.env.AGENT_MOBILE_TEST_TEMPLATE || Object.keys(config.templates)[0];
  const diagnostics = [];
  const backend = new AndroidBackend({config});
  const provisioner = new Provisioner({config});
  const webrtc = new WebRTCManager({config, resolveAccess: async device => {
    try { return await resolveEmulatorGrpc({config, device, env: backend._env(device)}); }
    catch (error) { diagnostics.push({sourceAccess: error.code, reason: error.message}); throw error; }
  }, spawnProcess(file, args, options) {
    const child = spawn(file, args, options); let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      let end;
      while ((end = output.indexOf('\n')) !== -1) {
        const line = output.slice(0, end); output = output.slice(end + 1);
        try { const value = JSON.parse(line); if (value.type === 'error') diagnostics.push({worker: value.code}); } catch {}
      }
    });
    return child;
  }});
  const runtime = await new MobileRuntime({config, backend, provisioner, webrtc, media: new MediaManager({config})}).init();
  const server = createServer({runtime, provisioner}); server.listen(port, '127.0.0.1'); await once(server, 'listening');
  let browser;
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    let clean = false;
    try { for (const device of runtime.list()) await runtime.destroySession(device.id); clean = true; }
    finally { await runtime.close(); if (clean) await fs.rm(root, {recursive: true, force: true}); }
  });
  const session = await runtime.createSession({template});
  await runtime.execute(session.id, 'start');
  await runtime.execute(session.id, 'install_app', {apkPath: path.resolve(process.env.AGENT_MOBILE_TEST_AUDIO_APK)}, {operator: true});
  await runtime.execute(session.id, 'launch_app', {package: 'dev.agentmobile.tone'});

  const {chromium} = createRequire(path.resolve(process.env.AGENT_MOBILE_PLAYWRIGHT_MODULE))('playwright');
  browser = await chromium.launch({executablePath: process.env.AGENT_MOBILE_CHROME, headless: true, chromiumSandbox: true});
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.__mediaPeers = [];
    window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.__mediaPeers.push(this); } };
  });
  const origin = `http://127.0.0.1:${port}`;
  const login = await context.request.post(origin + '/v1/admin/viewer-login', {headers: {authorization: `Bearer ${runtime.adminToken}`}, data: {}});
  const {code} = await login.json();
  const page = await context.newPage();
  await page.goto(origin + '/#code=' + encodeURIComponent(code));
  await page.locator('#workspace').waitFor({state: 'visible'});
  await page.locator('#live-start-button').click();
  await page.waitForFunction(() => {
    const video = document.getElementById('live-video');
    return (video.videoWidth > 0 && video.currentTime > .2) || document.getElementById('notice').textContent.includes('实时预览没有建立');
  }, null, {timeout: 25000});
  assert.ok(await page.locator('#live-video').evaluate(video => video.videoWidth > 0 && video.videoHeight > 0), JSON.stringify(diagnostics));
  await page.locator('#live-audio-button').click();
  let stats;
  const deadline = Date.now() + 10000;
  do {
    stats = await page.evaluate(async () => {
      const pc = window.__mediaPeers[0];
      const values = [...(await pc.getStats()).values()].filter(value => value.type === 'inbound-rtp');
      return {sctp: pc.sctp !== null, media: values.map(value => ({kind: value.kind, frames: value.framesDecoded || 0, packets: value.packetsReceived || 0, energy: value.totalAudioEnergy || 0, duration: value.totalSamplesDuration || 0}))};
    });
    if (stats.media.some(value => value.kind === 'audio' && value.duration > .2 && value.energy / value.duration > 0.000001)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.equal(stats.sctp, false);
  assert.ok(stats.media.some(value => value.kind === 'video' && value.frames > 0), JSON.stringify(stats.media));
  assert.ok(stats.media.some(value => value.kind === 'audio' && value.packets > 0 && value.duration > .2 && value.energy / value.duration > 0.000001), JSON.stringify(stats.media));
  const peer = [...webrtc.peers.values()][0];
  assert.ok(peer);
  assert.equal(await page.evaluate(async () => (await fetch('/viewer/logout', {method: 'POST'})).ok), true);
  assert.equal(peer.exited, true);
  assert.equal(webrtc.peers.size, 0);
  t.diagnostic('Actual emulator screenshot/audio RPCs produced decoded video and non-silent audio; logout reaped the real worker.');
});
