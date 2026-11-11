'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const {EventEmitter, once} = require('node:events');
const {randomUUID} = require('node:crypto');
const {MobileRuntime} = require('../src/runtime.cjs');
const {Provisioner} = require('../src/provision.cjs');
const {createServer} = require('../src/server.cjs');
const {fail} = require('../src/errors.cjs');

const OFFER = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=local-media-test\r\nt=0 0\r\n';

class FakeWebRTC {
  constructor(events) {
    this.events = events;
    this.peers = new Map();
    this.ownerValid = () => false;
  }
  enabled() { return true; }
  setOwnerValidator(validator) { this.ownerValid = validator; }
  async open(session, owner, offer) {
    if (!this.ownerValid(owner)) fail('unauthorized', 'Operator media authorization expired.', 401);
    if ([...this.peers.values()].some(peer => peer.sessionId === session.id)) fail('live_busy', 'Preview already open.', 409);
    const record = {id: randomUUID(), sessionId: session.id, owner};
    this.peers.set(record.id, record);
    this.events.push({name: 'peer.open', sessionId: session.id, owner, offer});
    return {id: record.id, sessionId: session.id, answer: {type: 'answer', sdp: 'local-media-only-answer'}};
  }
  find(sessionId, id, owner) {
    if (!this.ownerValid(owner)) fail('unauthorized', 'Operator media authorization expired.', 401);
    const peer = this.peers.get(id);
    if (!peer || peer.sessionId !== sessionId || peer.owner !== owner) fail('live_unavailable', 'Preview unavailable.', 409);
    return peer;
  }
  async renew(sessionId, id, owner) {
    this.find(sessionId, id, owner);
    this.events.push({name: 'peer.renew', sessionId, owner});
    return {id, sessionId};
  }
  async close(sessionId, id, owner) {
    this.find(sessionId, id, owner);
    this.peers.delete(id);
    this.events.push({name: 'peer.close', sessionId, owner});
    return {closed: true};
  }
  async closeDevice(sessionId) {
    this.events.push({name: 'peer.closeDevice', sessionId});
    this.onCloseDevice?.(sessionId);
    if (this.failRevocation && [...this.peers.values()].some(peer => peer.sessionId === sessionId)) fail('live_revoke_failed', 'Media process exit is unconfirmed.', 503);
    for (const [id, peer] of this.peers) if (peer.sessionId === sessionId) this.peers.delete(id);
  }
  async closeOwner(owner) {
    this.events.push({name: 'peer.closeOwner', owner});
    // Match the real manager: teardown operates on the owner snapshot captured
    // at entry, so authorization must be revoked before this asynchronous work.
    const owned = [...this.peers.values()].filter(peer => peer.owner === owner);
    await this.onCloseOwner?.(owner);
    if (this.failRevocation && owned.length) fail('live_revoke_failed', 'Media process exit is unconfirmed.', 503);
    for (const peer of owned) this.peers.delete(peer.id);
  }
  async shutdown() { this.peers.clear(); }
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-live-http-')));
  const avdDir = path.join(root, 'clean.avd');
  await fs.mkdir(avdDir);
  await fs.writeFile(path.join(avdDir, 'config.ini'), 'AvdId=clean\nimage.sysdir.1=system-images/android-35/default/x86_64/\n');
  await fs.writeFile(path.join(avdDir, 'userdata-qemu.img'), 'clean-private-data');
  const events = [];
  const children = new Map();
  const backend = {
    async launch(device) {
      const child = new EventEmitter();
      child.pid = 99999999;
      child.stdout = child.stderr = {resume() {}};
      child.kill = signal => { events.push({name: 'emulator.kill', sessionId: device.id, signal}); queueMicrotask(() => child.emit('exit', 0, signal)); return true; };
      children.set(device.id, child);
      return child;
    },
    async waitReady() {},
    async recover() { return {state: 'absent'}; },
    async snapshot() { return {xml: '<hierarchy/>', width: 1, height: 1}; },
  };
  const media = {
    async stopDevice(id) { events.push({name: 'recording.stopDevice', sessionId: id}); },
    async shutdown() {},
  };
  const config = {dataDir: path.join(root, 'data'), templates: {clean: {avdDir}}, maxDevices: 3, emulatorPortStart: 5554, bootTimeoutMs: 1000, stopTimeoutMs: 20, artifactMaxBytes: 1024};
  const webrtc = new FakeWebRTC(events);
  const provisioner = new Provisioner({config});
  const runtime = await new MobileRuntime({config, backend, media, provisioner, webrtc}).init();
  const reserve = net.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  config.controlPort = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  // Viewer captures its clock synchronously at construction. Inject a controlled
  // clock only for this createServer call, and restore Date.now before any await.
  // This permits actual server-owner validation after expiry without a 30m wait.
  const clock = {value: Date.now()};
  const originalNow = Date.now;
  let server;
  try { Date.now = () => clock.value; server = createServer({runtime, provisioner}); }
  finally { Date.now = originalNow; }
  t.after(async () => {
    webrtc.failRevocation = false;
    webrtc.onCloseDevice = webrtc.onCloseOwner = undefined;
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await runtime.close().catch(() => {});
    await fs.rm(root, {recursive: true, force: true});
  });
  server.listen(config.controlPort, '127.0.0.1'); await once(server, 'listening');
  const admin = (await fs.readFile(path.join(config.dataDir, 'secrets/admin-token'), 'utf8')).trim();
  const origin = `http://127.0.0.1:${config.controlPort}`;

  async function request(target, {method = 'POST', token, cookie, value = {}, headers = {}, browserOrigin = true} = {}) {
    const payload = method === 'POST' ? JSON.stringify(value) : undefined;
    return new Promise((resolve, reject) => {
      const req = http.request({host: '127.0.0.1', port: config.controlPort, path: target, method, headers: {
        host: `127.0.0.1:${config.controlPort}`, connection: 'close',
        ...(token ? {authorization: `Bearer ${token}`} : {}),
        ...(cookie ? {cookie} : {}),
        ...(cookie && method === 'POST' && browserOrigin ? {origin} : {}),
        ...(payload === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)}),
        ...headers,
      }}, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json; try { json = JSON.parse(text); } catch {}
          resolve({status: res.statusCode, headers: res.headers, text, json});
        });
      });
      req.on('error', reject); req.end(payload);
    });
  }
  async function session() {
    const created = await runtime.createSession({template: 'clean'});
    await runtime.execute(created.id, 'start');
    const credential = JSON.parse(await fs.readFile(created.credentialFile, 'utf8'));
    return {...created, token: credential.token};
  }
  async function login() {
    const minted = await request('/v1/admin/viewer-login', {token: admin});
    const result = await request('/viewer/login', {value: {code: minted.json.code}});
    assert.equal(result.status, 200);
    return result.headers['set-cookie'][0].split(';')[0];
  }
  const liveURL = (s, id, action) => `/v1/admin/sessions/${s.id}/live${id ? `/${id}/${action}` : ''}`;
  const open = (s, auth) => request(liveURL(s), {...auth, value: {offer: OFFER}});
  return {root, config, runtime, provisioner, webrtc, events, children, clock, origin, admin, request, session, login, liveURL, open};
}

test('live HTTP signaling requires an operator and cookie callers must supply the exact Origin', async t => {
  const f = await fixture(t); const s = await f.session();
  assert.equal((await f.open(s, {})).status, 401);
  assert.equal((await f.open(s, {token: s.token})).status, 401);
  const cookie = await f.login();
  assert.equal((await f.open(s, {cookie, browserOrigin: false})).status, 403);
  assert.equal((await f.open(s, {cookie, headers: {origin: 'http://attacker.test'}})).status, 403);
  assert.equal((await f.open(s, {cookie, headers: {origin: 'null'}})).status, 403);
  assert.equal(f.webrtc.peers.size, 0);
  const opened = await f.open(s, {cookie});
  assert.equal(opened.status, 200);
  assert.equal(opened.json.answer.type, 'answer');
  assert.equal(opened.text.includes(cookie), false);
  const owner = [...f.webrtc.peers.values()][0].owner;
  assert.match(owner, /^viewer:[a-f0-9]{64}$/);
  assert.equal(f.webrtc.ownerValid(owner), true);
});

test('live signaling rejects host, port, URL, filesystem and input fields before dispatch', async t => {
  const f = await fixture(t); const s = await f.session();
  for (const extra of [{host: '127.0.0.1'}, {port: 8554}, {url: 'file:///host'}, {path: '/host/secret'}, {control: true}, {dataChannel: 'input'}, {sessionId: 'other'}]) {
    const result = await f.request(f.liveURL(s), {token: f.admin, value: {offer: OFFER, ...extra}});
    assert.equal(result.status, 400);
  }
  for (const value of [{}, {offer: ''}, {offer: {}}, {offer: 'x'.repeat(49153)}]) {
    assert.equal((await f.request(f.liveURL(s), {token: f.admin, value})).status, 400);
  }
  assert.equal((await f.request(f.liveURL(s), {token: f.admin, value: {offer: 'x'.repeat(65536)}})).status, 413);
  assert.equal(f.events.filter(e => e.name === 'peer.open').length, 0);
  const opened = await f.open(s, {token: f.admin});
  assert.equal(opened.status, 200);
  assert.match([...f.webrtc.peers.values()][0].owner, /^admin:[a-f0-9]{64}$/);
  const renewURL = f.liveURL(s, opened.json.id, 'renew');
  assert.equal((await f.request(renewURL, {token: f.admin, value: {host: 'elsewhere'}})).status, 400);
  assert.equal((await f.request(f.liveURL(s), {token: f.admin, method: 'GET'})).status, 404);
  assert.equal((await f.request(f.liveURL(s).replace('/live', '//live'), {token: f.admin, value: {offer: OFFER}})).status, 404);
  assert.equal((await f.request(f.liveURL(s) + '/%2e/renew', {token: f.admin})).status, 404);
});

test('leases bind the exact browser identity and device, including renew and close', async t => {
  const f = await fixture(t); const a = await f.session(); const b = await f.session();
  const cookie = await f.login(); const otherCookie = await f.login();
  const opened = await f.open(a, {cookie}); const id = opened.json.id;
  assert.equal((await f.request(f.liveURL(a, id, 'renew'), {cookie})).status, 200);
  assert.equal((await f.request(f.liveURL(a, id, 'renew'), {cookie: otherCookie})).status, 409);
  assert.equal((await f.request(f.liveURL(a, id, 'close'), {token: f.admin})).status, 409);
  assert.equal((await f.request(f.liveURL(b, id, 'renew'), {cookie})).status, 409);
  assert.equal((await f.request(f.liveURL(b, id, 'close'), {cookie})).status, 409);
  assert.equal(f.webrtc.peers.size, 1);
  assert.equal((await f.request(f.liveURL(a, id, 'close'), {cookie, browserOrigin: false})).status, 403);
  assert.equal((await f.request(f.liveURL(a, id, 'close'), {cookie})).status, 200);
  assert.equal(f.webrtc.peers.size, 0);
  assert.equal((await f.request(f.liveURL(a, id, 'renew'), {cookie})).status, 409);
});

test('logout revokes its identity before closing peers and preserves independent owners', async t => {
  const f = await fixture(t); const a = await f.session(); const b = await f.session();
  const cookie = await f.login(); const otherCookie = await f.login();
  await f.open(a, {cookie}); await f.open(b, {cookie: otherCookie});
  const owner = [...f.webrtc.peers.values()].find(peer => peer.sessionId === a.id).owner;
  let validatedDuringClose = false;
  f.webrtc.onCloseOwner = candidate => { if (candidate === owner) validatedDuringClose = f.webrtc.ownerValid(candidate); };
  assert.equal((await f.request('/viewer/logout', {cookie, browserOrigin: false})).status, 403);
  assert.equal(f.webrtc.peers.size, 2);
  const loggedOut = await f.request('/viewer/logout', {cookie});
  assert.equal(loggedOut.status, 200);
  assert.equal(validatedDuringClose, false);
  assert.equal(f.webrtc.ownerValid(owner), false);
  assert.equal(f.webrtc.peers.size, 1);
  assert.equal([...f.webrtc.peers.values()][0].sessionId, b.id);
  assert.equal((await f.open(a, {cookie})).status, 401);
});

test('failed logout peer teardown keeps the identity revoked and requires operator recovery', async t => {
  const f = await fixture(t); const s = await f.session(); const cookie = await f.login();
  await f.runtime.execute(s.id, 'takeover', {}, {operator: true});
  await f.open(s, {cookie});
  const owner = [...f.webrtc.peers.values()][0].owner;
  f.webrtc.failRevocation = true;
  const result = await f.request('/viewer/logout', {cookie});
  assert.equal(result.status, 503);
  assert.match(result.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal(f.webrtc.ownerValid(owner), false);
  assert.equal(f.webrtc.peers.size, 1);
  assert.equal(f.runtime.state(s.id).takeover, true);
  await assert.rejects(f.runtime.execute(s.id, 'snapshot'), {code: 'human_control'});
  assert.equal((await f.open(s, {cookie})).status, 401);
  assert.equal((await f.request('/v1/admin/sessions', {method: 'GET', cookie})).status, 401);
  f.webrtc.failRevocation = false;
  await f.runtime.execute(s.id, 'release', {}, {operator: true});
  assert.equal(f.webrtc.peers.size, 0);
});

for (const operation of ['logout', 'login']) {
  test(`${operation} invalidates the old identity before asynchronous teardown can race a new device open`, {timeout: 5000}, async t => {
    const f = await fixture(t); const a = await f.session(); const b = await f.session();
    const cookie = await f.login();
    await f.open(a, {cookie});
    const owner = [...f.webrtc.peers.values()][0].owner;
    const code = operation === 'login' ? (await f.request('/v1/admin/viewer-login', {token: f.admin})).json.code : undefined;
    let entered, resume;
    const closing = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    f.webrtc.onCloseOwner = async candidate => {
      if (candidate !== owner) return;
      entered();
      await gate;
    };
    const pending = f.request(`/viewer/${operation}`, {cookie, value: code ? {code} : {}});
    try {
      await closing;
      assert.equal(f.webrtc.ownerValid(owner), false);
      assert.equal((await f.request('/v1/admin/sessions', {method: 'GET', cookie})).status, 401);
      assert.equal((await f.open(b, {cookie})).status, 401, 'The old identity must not create a peer outside the teardown snapshot');
      assert.equal(f.webrtc.peers.size, 1);
    } finally { resume(); }
    const result = await pending;
    assert.equal(result.status, 200);
    assert.equal(f.webrtc.peers.size, 0);
    assert.equal(f.webrtc.ownerValid(owner), false);
    assert.equal((await f.open(b, {cookie})).status, 401);
    if (operation === 'login') {
      const replacement = result.headers['set-cookie'][0].split(';')[0];
      assert.notEqual(replacement, cookie);
      assert.equal((await f.open(b, {cookie: replacement})).status, 200);
    }
  });
}

test('failed login replacement teardown never restores the old identity or issues a replacement', async t => {
  const f = await fixture(t); const s = await f.session(); const cookie = await f.login();
  await f.runtime.execute(s.id, 'takeover', {}, {operator: true});
  await f.open(s, {cookie});
  const owner = [...f.webrtc.peers.values()][0].owner;
  const {code} = (await f.request('/v1/admin/viewer-login', {token: f.admin})).json;
  f.webrtc.failRevocation = true;
  const result = await f.request('/viewer/login', {cookie, value: {code}});
  assert.equal(result.status, 503);
  assert.match(result.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal(f.webrtc.ownerValid(owner), false);
  assert.equal(f.webrtc.peers.size, 1);
  assert.equal(f.runtime.state(s.id).takeover, true);
  assert.equal((await f.request('/v1/admin/sessions', {method: 'GET', cookie})).status, 401);
  assert.equal((await f.request('/viewer/login', {value: {code}})).status, 401, 'Failed replacement still consumes its one-time code');
  f.webrtc.failRevocation = false;
  await f.runtime.execute(s.id, 'release', {}, {operator: true});
  assert.equal(f.webrtc.peers.size, 0);
});

test('login replacement rejects a missing browser Origin without consuming the code or changing identity', async t => {
  const f = await fixture(t); const s = await f.session(); const cookie = await f.login();
  await f.open(s, {cookie});
  const owner = [...f.webrtc.peers.values()][0].owner;
  const {code} = (await f.request('/v1/admin/viewer-login', {token: f.admin})).json;
  assert.equal((await f.request('/viewer/login', {cookie, value: {code}, browserOrigin: false})).status, 403);
  assert.equal(f.webrtc.ownerValid(owner), true);
  assert.equal(f.webrtc.peers.size, 1);
  assert.equal((await f.request('/viewer/login', {cookie, value: {code}})).status, 200);
  assert.equal(f.webrtc.ownerValid(owner), false);
  assert.equal(f.webrtc.peers.size, 0);
});

test('server-installed owner validation expires browser authority for active media', async t => {
  const f = await fixture(t); const s = await f.session(); const cookie = await f.login();
  const opened = await f.open(s, {cookie});
  const owner = [...f.webrtc.peers.values()][0].owner;
  assert.equal(f.webrtc.ownerValid(owner), true);
  f.clock.value += 1800001;
  assert.equal(f.webrtc.ownerValid(owner), false);
  assert.equal((await f.request(f.liveURL(s, opened.json.id, 'renew'), {cookie})).status, 401);
});

test('takeover and release close media before changing the persisted Agent hold', async t => {
  const f = await fixture(t); const s = await f.session();
  await f.open(s, {token: f.admin});
  let holdDuringRevocation;
  f.webrtc.onCloseDevice = id => { if (id === s.id) holdDuringRevocation = f.runtime.state(id).takeover; };
  await f.runtime.execute(s.id, 'takeover', {}, {operator: true});
  assert.equal(holdDuringRevocation, false);
  assert.equal(f.runtime.state(s.id).takeover, true);
  assert.equal(f.webrtc.peers.size, 0);
  await f.open(s, {token: f.admin});
  await f.runtime.execute(s.id, 'release', {}, {operator: true});
  assert.equal(holdDuringRevocation, true, 'Agent must remain held until peer teardown has completed');
  assert.equal(f.runtime.state(s.id).takeover, false);
  assert.equal(f.webrtc.peers.size, 0);
  assert.equal((await f.runtime.execute(s.id, 'snapshot')).xml, '<hierarchy/>');
});

test('failed release or destruction never hands control back or deletes the device', async t => {
  const f = await fixture(t); const s = await f.session();
  await f.runtime.execute(s.id, 'takeover', {}, {operator: true});
  await f.open(s, {token: f.admin});
  f.webrtc.failRevocation = true;
  await assert.rejects(f.runtime.execute(s.id, 'release', {}, {operator: true}), {code: 'live_revoke_failed'});
  assert.equal(f.runtime.state(s.id).takeover, true);
  await assert.rejects(f.runtime.execute(s.id, 'snapshot'), {code: 'human_control'});
  const deviceDir = f.runtime.sessions.get(s.id).device.deviceDir;
  await assert.rejects(f.runtime.destroySession(s.id), {code: 'live_revoke_failed'});
  assert.equal((await fs.stat(deviceDir)).isDirectory(), true);
  assert.equal(f.runtime.state(s.id).takeover, true);
  assert.equal(f.runtime.authorizeSession(s.id, s.token), true, 'Deletion must not proceed before media exit is confirmed');
  f.webrtc.failRevocation = false;
  await f.runtime.destroySession(s.id);
  await assert.rejects(fs.stat(deviceDir), {code: 'ENOENT'});
});

test('stop and destruction tear down media before terminating the owned emulator', async t => {
  const f = await fixture(t); const a = await f.session(); const b = await f.session();
  await f.open(a, {token: f.admin}); await f.open(b, {token: f.admin});
  f.events.length = 0;
  await f.runtime.execute(a.id, 'stop');
  const close = f.events.findIndex(e => e.name === 'peer.closeDevice' && e.sessionId === a.id);
  const kill = f.events.findIndex(e => e.name === 'emulator.kill' && e.sessionId === a.id);
  assert.ok(close !== -1 && kill > close);
  assert.equal(f.webrtc.peers.size, 1);
  assert.equal([...f.webrtc.peers.values()][0].sessionId, b.id);
  f.events.length = 0;
  await f.runtime.destroySession(b.id);
  assert.ok(f.events.findIndex(e => e.name === 'peer.closeDevice') < f.events.findIndex(e => e.name === 'emulator.kill'));
  assert.equal(f.webrtc.peers.size, 0);
});

test('unexpected emulator exit revokes its peer and blocks subsequent live operations', async t => {
  const f = await fixture(t); const s = await f.session();
  await f.open(s, {token: f.admin});
  f.children.get(s.id).emit('exit', 1, null);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.runtime.state(s.id).state, 'failed');
  assert.equal(f.runtime.state(s.id).recoveryRequired, true);
  assert.equal(f.webrtc.peers.size, 0);
  assert.ok(f.events.some(e => e.name === 'peer.closeDevice' && e.sessionId === s.id));
  const response = await f.open(s, {token: f.admin});
  assert.equal(response.status, 409);
  assert.equal(response.json.error.code, 'not_running');
});
