'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {EventEmitter, once} = require('node:events');
const {randomUUID} = require('node:crypto');
const {MobileRuntime} = require('../src/runtime.cjs');
const {Provisioner} = require('../src/provision.cjs');
const {createServer} = require('../src/server.cjs');
const {fail} = require('../src/errors.cjs');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jCioAAAAASUVORK5CYII=', 'base64');

async function unusedPort() {
  const reserve = net.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  return port;
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-http-')));
  const avdDir = path.join(root, 'clean.avd');
  await fs.mkdir(avdDir);
  await fs.writeFile(path.join(avdDir, 'config.ini'), 'AvdId=clean\nimage.sysdir.1=system-images/android-35/default/x86_64/\n');
  await fs.writeFile(path.join(avdDir, 'userdata-qemu.img'), 'baseline');
  const config = {
    dataDir: path.join(root, 'data'), templates: {clean: {avdDir}},
    maxDevices: 3, emulatorPortStart: 5554, bootTimeoutMs: 1000,
    stopTimeoutMs: 20, artifactMaxBytes: 1024,
  };
  const calls = [];
  const backend = {
    async launch(device) {
      const child = new EventEmitter();
      child.pid = 99999999;
      child.stdout = child.stderr = {resume() {}};
      child.kill = signal => { queueMicrotask(() => child.emit('exit', 0, signal)); return true; };
      calls.push({id: device.id, action: 'start'});
      return child;
    },
    async waitReady() {},
    async recover() { return {state: 'absent'}; },
    async snapshot(device) { calls.push({id: device.id, action: 'snapshot'}); return {xml: '<hierarchy><node text="fixture" /></hierarchy>', width: 1, height: 1}; },
    async screenshot(device) { calls.push({id: device.id, action: 'screenshot'}); return PNG; },
    async tap(device, args) { calls.push({id: device.id, action: 'tap', args}); return {ok: true}; },
    async apps() { return ['android', 'com.example.app']; },
  };
  const artifacts = new Map();
  const media = {
    stopped: [],
    async stopDevice(id) { this.stopped.push(id); },
    async shutdown() {},
    async list() { return []; },
    async start(device, args) { return {id: randomUUID(), deviceId: device.id, ...args}; },
    async stop(deviceId, recordingId) { return {deviceId, recordingId}; },
    async artifact(deviceId, recordingId) {
      const artifact = artifacts.get(`${deviceId}/${recordingId}`);
      if (!artifact) fail('not_found', 'Recording not found.', 404);
      return artifact;
    },
  };
  const provisioner = new Provisioner({config});
  const runtime = await new MobileRuntime({config, backend, media, provisioner}).init();
  let server;
  t.after(async () => {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await runtime.close().catch(() => {});
    await fs.rm(root, {recursive: true, force: true});
  });
  config.controlPort = await unusedPort();
  server = createServer({runtime, provisioner});
  server.listen(config.controlPort, '127.0.0.1');
  await once(server, 'listening');
  const admin = (await fs.readFile(path.join(config.dataDir, 'secrets', 'admin-token'), 'utf8')).trim();

  function request(target, {method = 'GET', token, value, raw, headers = {}} = {}) {
    const data = value === undefined ? raw : JSON.stringify(value);
    return new Promise((resolve, reject) => {
      const req = http.request({host: '127.0.0.1', port: config.controlPort, path: target, method, headers: {
        host: `127.0.0.1:${config.controlPort}`, connection: 'close',
        ...(token ? {authorization: `Bearer ${token}`} : {}),
        ...(data !== undefined ? {'content-type': 'application/json', 'content-length': Buffer.byteLength(data)} : {}),
        ...headers,
      }}, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          let json;
          if (buffer.length && res.headers['content-type']?.startsWith('application/json')) json = JSON.parse(buffer.toString('utf8'));
          resolve({status: res.statusCode, headers: res.headers, buffer, json});
        });
      });
      req.on('error', reject);
      req.end(data);
    });
  }
  async function session(key) {
    const created = await request('/v1/admin/sessions', {method: 'POST', token: admin, value: {template: 'clean', ...(key ? {key} : {})}});
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const credentials = JSON.parse(await fs.readFile(created.json.credentialFile, 'utf8'));
    return {...created.json, token: credentials.token};
  }
  function action(s, actionName, args = {}, operator = false) {
    const url = operator ? `/v1/admin/sessions/${s.id}/action` : `/v1/sessions/${s.id}/action`;
    return request(url, {method: 'POST', token: operator ? admin : s.token, value: {action: actionName, args}});
  }
  async function artifact(s, content = Buffer.from('0123456789abcdef'), mime = 'video/x-matroska') {
    const id = randomUUID();
    const filename = path.join(root, `${s.id}-${id}.mkv`);
    await fs.writeFile(filename, content);
    artifacts.set(`${s.id}/${id}`, {path: filename, mime});
    return {id, filename, url: `/v1/sessions/${s.id}/artifacts/${id}`, content};
  }
  return {root, config, runtime, provisioner, backend, media, calls, artifacts, admin, request, session, action, artifact};
}

test('HTTP accepts only exact loopback Host and Origin, and requires authentication except health', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/health')).status, 200);
  for (const host of ['evil.example', `localhost:${f.config.controlPort}`, `127.0.0.1:${f.config.controlPort + 1}`]) {
    const response = await f.request('/health', {headers: {host}});
    assert.equal(response.status, 403); assert.equal(response.json.error.code, 'origin_denied');
  }
  assert.equal((await f.request('/health', {headers: {origin: 'https://evil.example'}})).status, 403);
  assert.equal((await f.request('/health', {headers: {origin: 'null'}})).status, 403);
  assert.equal((await f.request('/health', {headers: {origin: `http://127.0.0.1:${f.config.controlPort}`}})).status, 200);
  assert.equal((await f.request('/v1/admin/sessions')).status, 401);
  assert.equal((await f.request('/v1/admin/templates', {headers: {authorization: 'Bearer invalid'}})).status, 401);
  assert.equal((await f.request('/v1/admin/templates', {token: f.admin})).status, 200);
});

test('admin and per-session credentials have separate scopes and never select another session', async t => {
  const f = await fixture(t);
  const a = await f.session('pax-a'); const b = await f.session('pax-b');
  assert.notEqual(a.id, b.id);
  assert.equal((await f.request(`/v1/sessions/${a.id}/state`, {token: a.token})).status, 200);
  for (const token of [undefined, b.token, f.admin]) assert.equal((await f.request(`/v1/sessions/${a.id}/state`, {token})).status, 401);
  assert.equal((await f.request('/v1/admin/sessions', {token: a.token})).status, 401);
  const list = await f.request('/v1/admin/sessions', {token: f.admin});
  assert.equal(list.status, 200); assert.equal(list.json.length, 2);
  const state = await f.request(`/v1/admin/sessions/${a.id}/state`, {token: f.admin});
  assert.equal(state.status, 200); assert.equal(state.json.id, a.id);
  assert.ok(!JSON.stringify(list.json).includes(a.token));
  assert.ok(!JSON.stringify(list.json).includes(f.config.dataDir));
  for (const name of ['takeover', 'release', 'recover']) {
    const response = await f.action(a, name, name === 'recover' ? {confirmStopped: true} : {});
    assert.equal(response.status, 400); assert.equal(response.json.error.code, 'unknown_action');
  }
  assert.equal((await f.request(`/v1/sessions/${a.id}`, {method: 'DELETE', token: a.token})).status, 404);
  assert.equal((await f.request(`/v1/admin/sessions/${a.id}`, {method: 'DELETE', token: f.admin})).status, 200);
  assert.equal((await f.request(`/v1/sessions/${a.id}/state`, {token: a.token})).status, 401);
  assert.equal((await f.request(`/v1/sessions/${b.id}/state`, {token: b.token})).status, 200);
});

test('HTTP rejects arbitrary actions, unexpected arguments and malformed bodies before backend execution', async t => {
  const f = await fixture(t); const s = await f.session();
  const url = `/v1/sessions/${s.id}/action`;
  for (const value of [
    {action: 'shell', args: {command: 'id'}},
    {action: 'start', args: {serial: 'real-phone'}},
    {action: 'tap', args: {x: 1, y: 2, deviceId: 'other'}},
    {action: 'tap', args: {x: '1;id', y: 2}},
    {action: 'screenshot', args: {}, host: 'localhost'},
    {action: 'start', args: []},
    null, [], {args: {}},
  ]) {
    const response = await f.request(url, {method: 'POST', token: s.token, value});
    assert.equal(response.status, 400, JSON.stringify(value));
  }
  assert.equal((await f.request(url, {method: 'POST', token: s.token, raw: '{broken'})).status, 400);
  assert.equal((await f.request(url, {method: 'POST', token: s.token, raw: '{}', headers: {'content-type': 'text/plain'}})).status, 415);
  assert.equal((await f.request('/v1/admin/sessions', {method: 'POST', token: f.admin, value: {template: 'clean', device: '/host/path'}})).status, 400);
  assert.equal((await f.request(url + '?host=127.0.0.1', {method: 'POST', token: s.token, value: {action: 'start'}})).status, 400);
  assert.equal(f.calls.length, 0);
});

test('screenshots serialize PNG dimensions and takeover blocks agent observations, capture and artifacts', async t => {
  const f = await fixture(t); const s = await f.session();
  assert.equal((await f.action(s, 'start')).status, 200);
  const screen = await f.action(s, 'screenshot');
  assert.equal(screen.status, 200);
  assert.deepEqual(screen.json, {mime: 'image/png', data: PNG.toString('base64'), width: 1, height: 1});
  assert.equal(screen.headers['cache-control'], 'no-store');
  assert.equal(screen.headers['x-content-type-options'], 'nosniff');
  const artifact = await f.artifact(s);
  const takeover = await f.action(s, 'takeover', {}, true);
  assert.equal(takeover.status, 200); assert.equal(takeover.json.takeover, true);
  assert.ok(f.media.stopped.includes(s.id));
  for (const name of ['snapshot', 'screenshot', 'recording_list', 'recording_start', 'stop']) {
    const response = await f.action(s, name);
    assert.equal(response.status, 409); assert.equal(response.json.error.code, 'human_control');
  }
  assert.equal((await f.request(artifact.url, {token: s.token})).status, 409);
  assert.equal((await f.action(s, 'screenshot', {}, true)).status, 200);
  assert.equal((await f.action(s, 'release', {}, true)).status, 200);
  assert.equal((await f.action(s, 'snapshot')).status, 200);
});

test('artifact GET, HEAD and single byte ranges remain session-scoped and bounded', async t => {
  const f = await fixture(t); const a = await f.session(); const b = await f.session();
  const artifact = await f.artifact(a);
  const complete = await f.request(artifact.url, {token: a.token});
  assert.equal(complete.status, 200); assert.deepEqual(complete.buffer, artifact.content);
  assert.equal(complete.headers['content-length'], String(artifact.content.length));
  assert.equal(complete.headers['content-type'], 'video/x-matroska');
  const head = await f.request(artifact.url, {method: 'HEAD', token: a.token});
  assert.equal(head.status, 200); assert.equal(head.buffer.length, 0);
  assert.equal(head.headers['content-length'], String(artifact.content.length));
  const partial = await f.request(artifact.url, {token: a.token, headers: {range: 'bytes=2-5'}});
  assert.equal(partial.status, 206); assert.equal(partial.buffer.toString(), '2345');
  assert.equal(partial.headers['content-range'], 'bytes 2-5/16');
  const suffix = await f.request(artifact.url, {token: a.token, headers: {range: 'bytes=-3'}});
  assert.equal(suffix.status, 206); assert.equal(suffix.buffer.toString(), 'def');
  const tail = await f.request(artifact.url, {token: a.token, headers: {range: 'bytes=14-'}});
  assert.equal(tail.status, 206); assert.equal(tail.buffer.toString(), 'ef');
  for (const range of ['bytes=100-', 'bytes=8-2', 'bytes=-0', 'bytes=0-1,3-4', 'items=0-1', 'bytes=-']) {
    assert.equal((await f.request(artifact.url, {token: a.token, headers: {range}})).status, 416, range);
  }
  assert.equal((await f.request(artifact.url, {token: b.token})).status, 401);
  assert.equal((await f.request(`/v1/sessions/${b.id}/artifacts/${artifact.id}`, {token: b.token})).status, 404);
  assert.equal((await f.request(`/v1/admin/sessions/${a.id}/artifacts/${artifact.id}`, {token: f.admin})).status, 200);
});

test('operator input requires takeover and a fresh, session-bound, single-use screenshot frame', async t => {
  const f = await fixture(t); const a = await f.session(); const b = await f.session();
  await f.action(a, 'start'); await f.action(b, 'start');
  const noTakeover = await f.action(a, 'tap', {x: 0, y: 0}, true);
  assert.equal(noTakeover.status, 409); assert.equal(noTakeover.json.error.code, 'takeover_required');
  const before = await f.action(a, 'screenshot', {}, true);
  assert.equal(typeof before.json.frameId, 'string');
  await f.action(a, 'takeover', {}, true);
  await f.action(b, 'takeover', {}, true);
  const old = await f.action(a, 'tap', {x: 0, y: 0, frameId: before.json.frameId}, true);
  assert.equal(old.status, 409); assert.equal(old.json.error.code, 'stale_frame');
  const frame = await f.action(a, 'screenshot', {}, true);
  assert.equal(frame.json.mime, 'image/png'); assert.equal(frame.json.data, PNG.toString('base64'));
  const crossSession = await f.action(b, 'tap', {x: 0, y: 0, frameId: frame.json.frameId}, true);
  assert.equal(crossSession.status, 409); assert.equal(crossSession.json.error.code, 'stale_frame');
  const input = {x: 0, y: 0, frameId: frame.json.frameId};
  assert.equal((await f.action(a, 'tap', input, true)).status, 200);
  const replay = await f.action(a, 'tap', input, true);
  assert.equal(replay.status, 409); assert.equal(replay.json.error.code, 'stale_frame');
  const stale = await f.action(a, 'screenshot', {}, true);
  f.runtime.frames.get(a.id).at -= 10001;
  assert.equal((await f.action(a, 'tap', {x: 0, y: 0, frameId: stale.json.frameId}, true)).status, 409);
  assert.equal(f.calls.filter(call => call.action === 'tap').length, 1);
});

test('artifact delivery rejects oversized files, symlinks, path traversal and unknown paths without disclosing bytes', async t => {
  const f = await fixture(t); const s = await f.session();
  const oversized = await f.artifact(s, Buffer.alloc(f.config.artifactMaxBytes + 1, 65));
  const rejected = await f.request(oversized.url, {token: s.token});
  assert.equal(rejected.status, 409); assert.equal(rejected.json.error.code, 'invalid_artifact');
  const empty = await f.artifact(s, Buffer.alloc(0));
  assert.equal((await f.request(empty.url, {token: s.token})).status, 409);
  const link = await f.artifact(s, Buffer.from('host-secret-sentinel'));
  const linkedPath = path.join(f.root, 'linked-artifact.mkv');
  await fs.symlink(link.filename, linkedPath);
  f.artifacts.set(`${s.id}/${link.id}`, {path: linkedPath, mime: 'video/x-matroska'});
  const denied = await f.request(link.url, {token: s.token});
  assert.equal(denied.status, 500);
  assert.ok(!denied.buffer.toString().includes('host-secret-sentinel'));
  assert.ok(!denied.buffer.toString().includes(f.root));
  for (const url of [
    `/v1/sessions/${s.id}/artifacts/%2fetc%2fpasswd`,
    `/v1/sessions/${s.id}/artifacts/${link.id}/extra`,
    `/v1/sessions/${s.id}/artifacts/../../../../etc/passwd`,
    `/v1/sessions/${s.id}/state/extra`,
  ]) {
    const response = await f.request(url, {token: s.token});
    assert.ok([400, 404].includes(response.status), url);
    assert.ok(!response.buffer.toString().includes('host-secret-sentinel'));
  }
});

test('HTTP responds with a bounded error for bodies over the 16 KiB limit', async t => {
  const f = await fixture(t); const s = await f.session();
  const response = await f.request(`/v1/sessions/${s.id}/action`, {
    method: 'POST', token: s.token, raw: JSON.stringify({action: 'text', args: {text: 'a'.repeat(17000)}}),
  });
  assert.equal(response.status, 413);
  assert.equal(response.json.error.code, 'payload_too_large');
  assert.equal(f.calls.length, 0);
});
