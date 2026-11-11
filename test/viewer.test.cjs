'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const {once} = require('node:events');
const {Viewer} = require('../src/viewer.cjs');
const {createServer} = require('../src/server.cjs');

const ADMIN = 'a'.repeat(64);
const SESSION = 'b'.repeat(64);
const ID = 'm-11111111-1111-1111-1111-111111111111';

async function fixture(t) {
  const reserve = net.createServer();
  reserve.listen(0, '127.0.0.1');
  await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const runtime = {
    config: {controlPort: port, bootTimeoutMs: 1000, artifactMaxBytes: 1024},
    closing: false,
    authorizeAdmin: token => token === ADMIN,
    authorizeSession: (id, token) => id === ID && token === SESSION,
    list: () => [{id: ID, deviceId: ID, state: 'stopped', template: 'clean'}],
    state: id => ({id, state: 'stopped'}),
  };
  const provisioner = {listTemplates: async () => [{name: 'clean', available: true}]};
  const server = createServer({runtime, provisioner});
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');

  async function request(target, {method = 'GET', token, cookie, value, raw, headers = {}} = {}) {
    const payload = value === undefined ? raw : JSON.stringify(value);
    return new Promise((resolve, reject) => {
      const req = http.request({host: '127.0.0.1', port, path: target, method, headers: {
        host: `127.0.0.1:${port}`,
        ...(token ? {authorization: `Bearer ${token}`} : {}),
        ...(cookie ? {cookie} : {}),
        ...(cookie && method === 'POST' ? {origin: `http://127.0.0.1:${port}`} : {}),
        ...(payload === undefined ? {} : {'content-type': 'application/json', 'content-length': Buffer.byteLength(payload)}),
        ...headers,
      }}, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try { json = JSON.parse(text); } catch {}
          resolve({status: res.statusCode, headers: res.headers, text, json});
        });
      });
      req.on('error', reject);
      req.end(payload);
    });
  }
  const mint = () => request('/v1/admin/viewer-login', {method: 'POST', token: ADMIN, value: {}});
  const login = code => request('/viewer/login', {method: 'POST', value: {code}});
  return {request, mint, login, port};
}

function cookieOf(response) {
  return response.headers['set-cookie']?.[0]?.split(';')[0];
}

test('viewer login minting requires the node operator bearer and never returns the permanent credential', async t => {
  const f = await fixture(t);
  for (const token of [undefined, SESSION, 'invalid']) {
    const response = await f.request('/v1/admin/viewer-login', {method: 'POST', token, value: {}});
    assert.equal(response.status, 401);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  for (const value of [null, [], {host: 'elsewhere'}, 'invalid']) {
    const response = await f.request('/v1/admin/viewer-login', {method: 'POST', token: ADMIN, value});
    assert.equal(response.status, 400);
  }
  const minted = await f.mint();
  assert.equal(minted.status, 200);
  assert.deepEqual(Object.keys(minted.json).sort(), ['code', 'expiresAt']);
  assert.match(minted.json.code, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(minted.text.includes(ADMIN), false);
  assert.equal(minted.headers['set-cookie'], undefined);
  assert.equal(minted.headers['cache-control'], 'no-store');
});

test('one-time login grants only an HttpOnly cookie, permits operator APIs and rejects replay', async t => {
  const f = await fixture(t);
  const minted = await f.mint();
  const loggedIn = await f.login(minted.json.code);
  assert.equal(loggedIn.status, 200);
  assert.deepEqual(loggedIn.json, {ok: true});
  const header = loggedIn.headers['set-cookie'][0];
  assert.match(header, /; HttpOnly;/);
  assert.match(header, /; SameSite=Strict;/);
  assert.match(header, /; Path=\//);
  assert.match(header, /; Max-Age=1800/);
  assert.equal(loggedIn.text.includes(ADMIN), false);
  assert.equal(loggedIn.text.includes(cookieOf(loggedIn)), false);
  const cookie = cookieOf(loggedIn);
  assert.equal((await f.request('/v1/admin/sessions', {cookie})).status, 200);
  assert.equal((await f.request('/v1/admin/templates', {cookie})).status, 200);
  assert.equal((await f.login(minted.json.code)).status, 401);
  // An ambient browser session cannot mint a transferable login link.
  assert.equal((await f.request('/v1/admin/viewer-login', {method: 'POST', cookie, value: {}})).status, 401);
  // A browser operator uses admin routes; cookie authority is not silently
  // substituted for a session credential on the scoped agent routes.
  assert.equal((await f.request(`/v1/sessions/${ID}/state`, {cookie})).status, 401);
  assert.equal((await f.request(`/v1/sessions/${ID}/state`, {token: SESSION})).status, 200);
});

test('logout revokes browser authority without changing independent bearer credentials', async t => {
  const f = await fixture(t);
  const cookie = cookieOf(await f.login((await f.mint()).json.code));
  assert.equal((await f.request('/v1/admin/sessions', {cookie})).status, 200);
  const response = await f.request('/viewer/logout', {method: 'POST', cookie});
  assert.equal(response.status, 200);
  assert.match(response.headers['set-cookie'][0], /Max-Age=0/);
  assert.equal((await f.request('/v1/admin/sessions', {cookie})).status, 401);
  assert.equal((await f.request('/v1/admin/sessions', {token: ADMIN})).status, 200);
  assert.equal((await f.request(`/v1/sessions/${ID}/state`, {token: SESSION})).status, 200);
});

test('replacing a browser login revokes the previous cookie instead of retaining parallel authority', async t => {
  const f = await fixture(t);
  const previous = cookieOf(await f.login((await f.mint()).json.code));
  const code = (await f.mint()).json.code;
  const replacement = await f.request('/viewer/login', {method: 'POST', cookie: previous, value: {code}});
  assert.equal(replacement.status, 200);
  assert.equal((await f.request('/v1/admin/sessions', {cookie: previous})).status, 401);
  assert.equal((await f.request('/v1/admin/sessions', {cookie: cookieOf(replacement)})).status, 200);
});

test('login enforces exact Host, Origin, JSON content type and body shape before issuing cookies', async t => {
  const f = await fixture(t);
  const {code} = (await f.mint()).json;
  for (const headers of [{host: 'attacker.test'}, {origin: 'https://attacker.test'}, {origin: `http://localhost:${f.port}`}]) {
    const response = await f.request('/viewer/login', {method: 'POST', value: {code}, headers});
    assert.equal(response.status, 403);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  const wrongType = await f.request('/viewer/login', {method: 'POST', value: {code}, headers: {'content-type': 'text/plain'}});
  assert.equal(wrongType.status, 415);
  for (const value of [null, [], {}, {code: 'bad'}, {code, extra: true}, {code: 123}]) {
    const response = await f.request('/viewer/login', {method: 'POST', value});
    assert.equal(response.status, 401);
    assert.equal(response.headers['set-cookie'], undefined);
  }
  assert.equal((await f.request('/viewer/login', {method: 'POST', raw: '{'})).status, 400);
  // Rejected cross-origin and malformed requests must not consume a valid code.
  assert.equal((await f.login(code)).status, 200);
});

test('ambiguous duplicate operator cookies and arbitrary cookie values are rejected', async t => {
  const f = await fixture(t);
  const cookie = cookieOf(await f.login((await f.mint()).json.code));
  for (const value of [`${cookie}; ${cookie}`, 'agent_mobile_operator=bogus', `other=${ADMIN}`, `agent_mobile_operator=${'0'.repeat(64)}`]) {
    assert.equal((await f.request('/v1/admin/sessions', {cookie: value})).status, 401);
  }
  assert.equal((await f.request('/v1/admin/sessions', {cookie: `unrelated=ok; ${cookie}`})).status, 200);
});

async function direct(viewer, pathname, value, {admin = false, cookie} = {}) {
  const headers = {};
  let result;
  const req = {method: 'POST', headers: cookie ? {cookie} : {}};
  const res = {setHeader: (name, content) => { headers[name] = content; }};
  await viewer.handle(req, res, pathname, {
    admin,
    body: async () => value,
    json: (_res, status, body) => { result = {status, body}; },
  });
  return {...result, headers};
}

test('login codes and browser sessions expire without a timer or persisted token state', async () => {
  let time = 1000000;
  const viewer = new Viewer({now: () => time});
  const first = await direct(viewer, '/v1/admin/viewer-login', {}, {admin: true});
  time += 120000;
  await assert.rejects(direct(viewer, '/viewer/login', {code: first.body.code}), {code: 'unauthorized'});
  const next = await direct(viewer, '/v1/admin/viewer-login', {}, {admin: true});
  const login = await direct(viewer, '/viewer/login', {code: next.body.code});
  const cookie = login.headers['set-cookie'].split(';')[0];
  assert.equal(viewer.authenticated({headers: {cookie}}), true);
  assert.equal(new Viewer().authenticated({headers: {cookie}}), false, 'Service restart must require a new operator login');
  time += 1800000;
  assert.equal(viewer.authenticated({headers: {cookie}}), false);
  assert.equal(viewer.sessions.size, 0);
  assert.equal(viewer.codes.size, 0);
});

test('pending code and active browser session limits bound operator login state', async () => {
  let time = 1000000;
  const viewer = new Viewer({now: () => time});
  for (let i = 0; i < 16; i++) await direct(viewer, '/v1/admin/viewer-login', {}, {admin: true});
  await assert.rejects(direct(viewer, '/v1/admin/viewer-login', {}, {admin: true}), {code: 'login_capacity'});
  time += 120001;
  for (let i = 0; i < 8; i++) {
    const code = await direct(viewer, '/v1/admin/viewer-login', {}, {admin: true});
    await direct(viewer, '/viewer/login', {code: code.body.code});
  }
  const extra = await direct(viewer, '/v1/admin/viewer-login', {}, {admin: true});
  await assert.rejects(direct(viewer, '/viewer/login', {code: extra.body.code}), {code: 'login_capacity'});
});

test('viewer assets are credential-free same-origin documents with restrictive CSP', async t => {
  const f = await fixture(t);
  for (const [route, mime] of [['/', 'text/html'], ['/viewer.js', 'text/javascript'], ['/viewer.css', 'text/css']]) {
    const response = await f.request(route);
    assert.equal(response.status, 200);
    assert.ok(response.headers['content-type'].startsWith(mime));
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['referrer-policy'], 'no-referrer');
    assert.equal(response.headers['x-frame-options'], 'DENY');
    const csp = response.headers['content-security-policy'];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(csp.includes('unsafe-inline'), false);
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.text.includes(ADMIN), false);
    assert.equal(response.text.includes(SESSION), false);
    const head = await f.request(route, {method: 'HEAD'});
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
  }
  assert.equal((await f.request('/viewer/../secrets/admin-token')).status, 404);
});
