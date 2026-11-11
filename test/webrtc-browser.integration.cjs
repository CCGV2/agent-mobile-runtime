'use strict';

// Opt-in real Chrome + real aiortc test using synthetic media, never a phone.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {once, EventEmitter} = require('node:events');
const {createRequire} = require('node:module');
const {WebRTCManager} = require('../src/webrtc.cjs');
const {MobileRuntime} = require('../src/runtime.cjs');
const {Provisioner} = require('../src/provision.cjs');
const {createServer} = require('../src/server.cjs');
const {spawn} = require('node:child_process');

test('Chrome receives real media with no SCTP and logout reaps the peer process', {
  skip: !(process.env.AGENT_MOBILE_WEBRTC_PYTHON && process.env.AGENT_MOBILE_PLAYWRIGHT_MODULE && process.env.AGENT_MOBILE_CHROME) && 'Set WebRTC Python, Playwright module and Chrome paths for synthetic browser acceptance.',
  timeout: 60000,
}, async t => {
  const {chromium} = createRequire(path.resolve(process.env.AGENT_MOBILE_PLAYWRIGHT_MODULE))('playwright');
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-rtc-browser-')));
  const template = path.join(root, 'clean.avd'); await fs.mkdir(template);
  await fs.writeFile(path.join(template, 'config.ini'), 'AvdId=clean\nimage.sysdir.1=system-images/android-35/default/x86_64/\n');
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const config = {dataDir: path.join(root, 'data'), templates: {clean: {avdDir: template}}, controlPort: port, adbServerPort: 5038,
    maxDevices: 1, emulatorPortStart: 5554, stopTimeoutMs: 100, bootTimeoutMs: 1000,
    webrtc: {enabled: true, pythonPath: path.resolve(process.env.AGENT_MOBILE_WEBRTC_PYTHON), protoDir: root,
      leaseSeconds: 30, maxLifetimeSeconds: 60, maxWidth: 320, maxHeight: 240, fps: 15, negotiationTimeoutMs: 15000, shutdownTimeoutMs: 2000}};
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCioAAAAASUVORK5CYII=', 'base64');
  const backend = {
    async launch() { const child = new EventEmitter(); child.pid = 99999999; child.stdout = child.stderr = {resume() {}}; child.kill = () => { queueMicrotask(() => child.emit('exit', 0)); }; return child; },
    async waitReady() {}, async recover() { return {state: 'absent'}; }, async screenshot() { return png; },
  };
  const media = {async stopDevice() {}, async list() { return []; }, async shutdown() {}};
  const diagnostics = [];
  const webrtc = new WebRTCManager({config,
    workerPath: path.join(__dirname, 'fixtures', 'webrtc-synthetic.py'),
    spawnProcess(file, args, options) {
      const child = spawn(file, args, options); let output = '';
      child.stdout.on('data', chunk => { output += chunk; let end; while ((end = output.indexOf('\n')) !== -1) { const line = output.slice(0, end); output = output.slice(end + 1); try { const value = JSON.parse(line); if (value.type === 'error') diagnostics.push(`worker:${value.code}`); } catch {} } });
      return child;
    },
    resolveAccess: async () => ({address: '[::1]:8554', headers: async () => ({authorization: 'Bearer synthetic-test-only'}), close: async () => {}})});
  const open = webrtc.open.bind(webrtc);
  webrtc.open = async (session, owner, offer) => {
    try { return await open(session, owner, offer); } catch (error) { diagnostics.push(error.code || 'open_failed'); throw error; }
  };
  const provisioner = new Provisioner({config});
  const runtime = await new MobileRuntime({config, backend, media, provisioner, webrtc}).init();
  const server = createServer({runtime, provisioner}); server.listen(port, '127.0.0.1'); await once(server, 'listening');
  let browser;
  t.after(async () => {
    await browser?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await runtime.close(); await fs.rm(root, {recursive: true, force: true});
  });
  const session = await runtime.createSession({template: 'clean'}); await runtime.execute(session.id, 'start');
  browser = await chromium.launch({executablePath: process.env.AGENT_MOBILE_CHROME, headless: true, chromiumSandbox: true});
  const context = await browser.newContext();
  // Capture peer stats without changing the product's negotiation behavior.
  await context.addInitScript(() => {
    const Native = window.RTCPeerConnection;
    window.__mediaPeers = [];
    window.RTCPeerConnection = class extends Native { constructor(...args) { super(...args); window.__mediaPeers.push(this); } };
  });
  const origin = `http://127.0.0.1:${port}`;
  const loginResponse = await context.request.post(origin + '/v1/admin/viewer-login', {headers: {authorization: `Bearer ${runtime.adminToken}`}, data: {}});
  const {code} = await loginResponse.json();
  const page = await context.newPage();
  const browserErrors = []; page.on('pageerror', error => browserErrors.push(error.name));
  await page.goto(origin + '/#code=' + encodeURIComponent(code));
  await page.locator('#workspace').waitFor({state: 'visible'});
  await page.locator('#live-start-button').click();
  try { await page.waitForFunction(() => {
    const video = document.getElementById('live-video');
    return (video.videoWidth === 320 && video.videoHeight === 240 && video.currentTime > .2) || document.getElementById('notice').textContent.includes('实时预览没有建立');
  }, null, {timeout: 20000}); }
  catch { assert.fail(`Live media did not arrive: ${JSON.stringify(diagnostics)}; ${await page.locator('#notice').textContent()}`); }
  assert.equal(await page.locator('#live-video').evaluate(video => video.videoWidth), 320, JSON.stringify(diagnostics));
  await page.locator('#live-audio-button').click();
  const readStats = () => page.evaluate(async () => {
    const pc = window.__mediaPeers[0];
    const report = await pc.getStats();
    const inbound = [...report.values()].filter(value => value.type === 'inbound-rtp');
    return {sctp: pc.sctp !== null, media: inbound.map(value => ({kind: value.kind, packets: value.packetsReceived, frames: value.framesDecoded || 0, energy: value.totalAudioEnergy || 0}))};
  });
  let stats;
  const audioDeadline = Date.now() + 5000;
  do {
    stats = await readStats();
    if (stats.media.some(value => value.kind === 'audio' && value.packets > 0 && value.energy > 0)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() < audioDeadline);
  assert.equal(stats.sctp, false);
  assert.ok(stats.media.some(value => value.kind === 'video' && value.frames > 0));
  assert.ok(stats.media.some(value => value.kind === 'audio' && value.packets > 0 && value.energy > 0), `Browser must decode non-silent synthetic audio: ${JSON.stringify(stats.media)}`);
  assert.equal(webrtc.peers.size, 1);
  const lease = [...webrtc.peers.values()][0];
  const revoked = await page.evaluate(async () => (await fetch('/viewer/logout', {method: 'POST'})).ok);
  assert.equal(revoked, true);
  assert.equal(lease.exited, true, 'Logout must reap the actual media process, not only close a signaling response.');
  assert.equal(webrtc.peers.size, 0);
  assert.deepEqual(browserErrors, []);
});
