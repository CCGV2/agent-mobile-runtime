'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {randomUUID, createHash} = require('node:crypto');
const {spawn} = require('node:child_process');
const {once} = require('node:events');
const {PassThrough} = require('node:stream');
const {createMCPBroker, brokerSocketPath, clearStaleBroker, validateBrokerEndpoint} = require('../src/mcp-broker.cjs');
const {runBrokerMCP} = require('../src/mcp-broker-client.cjs');
const {RuntimeError} = require('../src/errors.cjs');

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return {promise, resolve, reject}; };
const tokenHash = token => createHash('sha256').update(token).digest('hex');
async function until(check, timeout = 3000) {
  const deadline = Date.now()+timeout;
  while (!check()) { if (Date.now() > deadline) assert.fail('Condition did not become true.'); await new Promise(resolve => setTimeout(resolve, 5)); }
}

async function fixture(t, graceMs = 1000) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-broker-')));
  const config = {dataDir: path.join(root, 'private-data'), templates: {clean35: {}}, bootTimeoutMs: 1000, mcpGraceMs: graceMs};
  const runtime = {
    config, sessions: new Map(), destroyed: [], calls: [], artifacts: new Map(),
    async ensureSession({key, template}) {
      await this.beforeEnsure?.();
      let session = [...this.sessions.values()].find(value => value.key === key);
      if (!session) { session = {id: 'm-'+randomUUID(), key, template, state: 'stopped', mcpManaged: true, token: 'a'.repeat(64), tokenHash: tokenHash('a'.repeat(64)), value: 0}; this.sessions.set(session.id, session); }
      if (session.template !== template) throw new RuntimeError('session_template_mismatch', 'Session template does not match.', 409);
      return {...this.state(session.id), managed: session.mcpManaged, expectedTokenHash: session.tokenHash};
    },
    state(id) { const session = this.sessions.get(id); if (!session) throw new RuntimeError('not_found', 'Session not found.', 404); return {id, state: session.state, value: session.value}; },
    listManagedSessions() { return [...this.sessions.values()].filter(value => value.mcpManaged); },
    authorizeSession(id, token) { return this.sessions.get(id)?.token === token; },
    async execute(id, action, args, {expectedTokenHash} = {}) {
      this.calls.push({id, action, args});
      const session = this.sessions.get(id);
      if (!session) throw new RuntimeError('not_found', 'Session not found.', 404);
      if (expectedTokenHash !== session.tokenHash) throw new RuntimeError('unauthorized', 'Private session authentication required.', 401);
      if (action === 'tap') { await this.pendingAction?.promise; session.value++; }
      if (action === 'start') session.state = 'running';
      if (action === 'screenshot') return Buffer.from('real-binary-test-image');
      return this.state(id);
    },
    async destroySession(id) { this.destroyed.push(id); await this.beforeDestroy?.(id); this.sessions.delete(id); },
    async artifact(id, recordingId, {expectedTokenHash} = {}) {
      if (expectedTokenHash !== this.sessions.get(id)?.tokenHash) throw new RuntimeError('unauthorized', 'Private session authentication required.', 401);
      if (this.sessions.get(id)?.takeover) throw new RuntimeError('human_control', 'Operator has control.', 409);
      const artifact = this.artifacts.get(id+':'+recordingId);
      if (!artifact) throw new RuntimeError('not_found', 'Recording not found.', 404);
      return artifact;
    },
  };
  const broker = createMCPBroker({runtime});
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.socket.destroy();
    await broker.close();
    await fs.rm(root, {recursive: true, force: true});
  });
  await broker.listen();
  async function connect(value, extra = '') {
    const socket = net.connect(broker.socketPath);
    socket.on('error', () => {});
    let pending = ''; const queue = [], waiters = [];
    socket.on('data', data => {
      pending += data;
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const result = JSON.parse(pending.slice(0, end)); pending = pending.slice(end+1);
        if (waiters.length) waiters.shift()(result); else queue.push(result);
      }
    });
    const next = () => queue.length ? Promise.resolve(queue.shift()) : new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('MCP broker response timeout.')), 3000);
      waiters.push(value => { clearTimeout(timer); resolve(value); });
    });
    await once(socket, 'connect');
    socket.write(JSON.stringify(value)+'\n'+extra);
    const client = {socket, attachment: await next(), next,
      rpc(method, id = 1, params = {}) { socket.write(JSON.stringify({jsonrpc: '2.0', id, method, params})+'\n'); return next(); },
      async call(name, args = {}, id = 3) { return this.rpc('tools/call', id, {name, arguments: args}); },
    };
    clients.push(client); return client;
  }
  const key = (value, extra) => connect({mode: 'key', key: value, template: 'clean35'}, extra);
  return {root, runtime, broker, config, clients, connect, key};
}

test('private broker isolates keys, handles pipelined initialization and fences duplicate key/file connections', async t => {
  const f = await fixture(t);
  const initialize = JSON.stringify({jsonrpc: '2.0', id: 10, method: 'initialize', params: {protocolVersion: '2025-06-18'}})+'\n';
  const [a, b] = await Promise.all([f.key('alpha', initialize), f.key('beta', initialize)]);
  assert.equal(a.attachment.attached, true); assert.equal(b.attachment.attached, true);
  assert.notEqual(a.attachment.sessionId, b.attachment.sessionId);
  assert.equal((await a.next()).result.serverInfo.name, 'agent-mobile-runtime');
  await b.next();
  await a.call('mobile_tap', {x: 1, y: 2});
  assert.equal(JSON.parse((await b.call('mobile_state')).result.content[0].text).value, 0);
  const duplicate = await f.key('alpha');
  assert.equal(duplicate.attachment.error.code, 'session_connected');
  const fixedDuplicate = await f.connect({mode: 'session', sessionId: a.attachment.sessionId, token: 'a'.repeat(64)});
  assert.equal(fixedDuplicate.attachment.error.code, 'session_connected');
  const wrong = await f.connect({mode: 'session', sessionId: a.attachment.sessionId, token: 'b'.repeat(64)});
  assert.equal(wrong.attachment.error.code, 'unauthorized');
  const shot = await a.call('mobile_screenshot');
  assert.equal(shot.result.content[0].data, Buffer.from('real-binary-test-image').toString('base64'));
  assert.equal(f.runtime.destroyed.length, 0);
});

test('idle reconnect retains state, expiry deletes only its own managed session, and manual sessions persist', async t => {
  const f = await fixture(t, 80);
  const a = await f.key('alpha'), b = await f.key('beta');
  await a.rpc('initialize'); await b.rpc('initialize');
  await a.call('mobile_tap', {x: 1, y: 2});
  a.socket.destroy(); await new Promise(resolve => setTimeout(resolve, 15));
  const resumed = await f.key('alpha');
  assert.equal(resumed.attachment.sessionId, a.attachment.sessionId);
  await resumed.rpc('initialize');
  assert.equal(JSON.parse((await resumed.call('mobile_state')).result.content[0].text).value, 1);
  resumed.socket.destroy();
  await until(() => !f.runtime.sessions.has(a.attachment.sessionId));
  assert.ok(f.runtime.sessions.has(b.attachment.sessionId));
  const manualId = 'm-'+randomUUID();
  f.runtime.sessions.set(manualId, {id: manualId, key: 'manual', template: 'clean35', mcpManaged: false, token: 'c'.repeat(64), tokenHash: tokenHash('c'.repeat(64)), value: 0, state: 'stopped'});
  const manual = await f.connect({mode: 'session', sessionId: manualId, token: 'c'.repeat(64)});
  assert.equal(manual.attachment.attached, true);
  manual.socket.destroy(); await new Promise(resolve => setTimeout(resolve, 100));
  assert.ok(f.runtime.sessions.has(manualId));
});

test('disconnect with pending input retires managed device and fences reattachment until confirmed cleanup', async t => {
  const f = await fixture(t);
  const a = await f.key('alpha'); await a.rpc('initialize');
  f.runtime.pendingAction = deferred();
  const cleanup = deferred(); f.runtime.beforeDestroy = () => cleanup.promise;
  a.socket.write(JSON.stringify({jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'mobile_tap', arguments: {x: 1, y: 2}}})+'\n');
  await until(() => f.runtime.calls.some(value => value.action === 'tap'));
  a.socket.destroy();
  await until(() => f.runtime.destroyed.includes(a.attachment.sessionId));
  const duplicate = await f.key('alpha'); assert.equal(duplicate.attachment.error.code, 'session_connected');
  assert.equal(f.runtime.calls.filter(value => value.action === 'tap').length, 1);
  f.runtime.pendingAction.resolve(); cleanup.resolve();
  await until(() => !f.runtime.sessions.has(a.attachment.sessionId));
  const replacement = await f.key('alpha');
  assert.notEqual(replacement.attachment.sessionId, a.attachment.sessionId);
});

test('manual pending input keeps its lease until actual completion and failed cleanup remains blocked', async t => {
  const f = await fixture(t, 10);
  const id = 'm-'+randomUUID();
  f.runtime.sessions.set(id, {id, key: 'manual', template: 'clean35', mcpManaged: false, token: 'c'.repeat(64), tokenHash: tokenHash('c'.repeat(64)), value: 0, state: 'running'});
  const a = await f.connect({mode: 'session', sessionId: id, token: 'c'.repeat(64)}); await a.rpc('initialize');
  f.runtime.pendingAction = deferred();
  a.socket.write(JSON.stringify({jsonrpc: '2.0', id: 5, method: 'tools/call', params: {name: 'mobile_tap', arguments: {x: 1, y: 2}}})+'\n');
  await until(() => f.runtime.calls.length > 0); a.socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 15));
  const duplicate = await f.connect({mode: 'session', sessionId: id, token: 'c'.repeat(64)}); assert.equal(duplicate.attachment.error.code, 'session_connected');
  f.runtime.pendingAction.resolve(); await new Promise(resolve => setTimeout(resolve, 15));
  const resumed = await f.connect({mode: 'session', sessionId: id, token: 'c'.repeat(64)}); assert.equal(resumed.attachment.attached, true);
  const managed = await f.key('will-fail');
  f.runtime.beforeDestroy = async () => { throw new Error('Unconfirmed emulator exit.'); };
  managed.socket.destroy(); await until(() => f.runtime.destroyed.includes(managed.attachment.sessionId));
  const blocked = await f.key('will-fail'); assert.equal(blocked.attachment.error.code, 'session_connected');
  assert.ok(f.runtime.sessions.has(managed.attachment.sessionId));
});

test('recording transfer remains session-bound, enforces private takeover and bounds actual bytes', async t => {
  const f = await fixture(t);
  const a = await f.key('alpha'), b = await f.key('beta'); await a.rpc('initialize'); await b.rpc('initialize');
  const recordingId = randomUUID(); const file = path.join(f.root, 'recording.opus');
  await fs.writeFile(file, 'own completed audio');
  f.runtime.artifacts.set(a.attachment.sessionId+':'+recordingId, {path: file, mime: 'audio/ogg'});
  const read = await a.call('mobile_recording_read', {recordingId});
  assert.equal(read.result.content[0].data, Buffer.from('own completed audio').toString('base64'));
  assert.equal((await b.call('mobile_recording_read', {recordingId})).result.isError, true);
  f.runtime.sessions.get(a.attachment.sessionId).takeover = true;
  assert.equal((await a.call('mobile_recording_read', {recordingId})).result.isError, true);
  f.runtime.sessions.get(a.attachment.sessionId).takeover = false;
  const handle = await fs.open(file, 'w'); await handle.truncate(8*1024*1024+1); await handle.close();
  assert.equal((await a.call('mobile_recording_read', {recordingId})).result.isError, true);
});

test('private endpoint rejects broad permissions, live socket removal and malformed handshake without leaking credentials', async t => {
  const f = await fixture(t);
  assert.ok(Buffer.byteLength(brokerSocketPath(f.config)) < 100);
  assert.equal((await fs.lstat(path.dirname(f.broker.socketPath))).mode & 0o777, 0o700);
  assert.equal((await fs.lstat(f.broker.socketPath)).mode & 0o777, 0o600);
  await assert.rejects(clearStaleBroker(f.config), /still active/);
  await fs.chmod(f.broker.socketPath, 0o666);
  await assert.rejects(validateBrokerEndpoint(f.config), /private/);
  await fs.chmod(f.broker.socketPath, 0o600);
  const bad = await f.connect({mode: 'key', key: 'safe', template: 'clean35', token: 'secret-must-not-echo'});
  assert.equal(bad.attachment.error.code, 'invalid_attach');
  assert.equal(JSON.stringify(bad.attachment).includes('secret-must-not-echo'), false);
  assert.equal(f.runtime.sessions.size, 0);
});

test('revocation invalidates an already attached direct MCP connection and its artifact access', async t => {
  const f = await fixture(t);
  const a = await f.key('alpha'); await a.rpc('initialize');
  const recordingId = randomUUID(), file = path.join(f.root, 'recording.opus');
  await fs.writeFile(file, 'old recording');
  f.runtime.artifacts.set(a.attachment.sessionId+':'+recordingId, {path: file, mime: 'audio/ogg'});
  f.runtime.sessions.get(a.attachment.sessionId).tokenHash = tokenHash('revoked credential');
  for (const [name, args] of [['mobile_state', {}], ['mobile_start', {}], ['mobile_recording_read', {recordingId}]]) {
    const response = await a.call(name, args);
    assert.equal(response.result.isError, true);
    assert.equal(response.result.content[0].text, 'Private session authentication required.');
  }
  assert.equal(f.runtime.sessions.get(a.attachment.sessionId).state, 'stopped');
});

test('revocation during attachment cannot replace the authenticated credential snapshot with a newer capability', async t => {
  const f = await fixture(t);
  const ensure = f.runtime.ensureSession.bind(f.runtime);
  f.runtime.ensureSession = async value => {
    const assigned = await ensure(value);
    f.runtime.sessions.get(assigned.id).tokenHash = tokenHash('revoked during ensure');
    return assigned;
  };
  const a = await f.key('alpha'); await a.rpc('initialize');
  assert.equal((await a.call('mobile_start')).result.isError, true);
  assert.equal(f.runtime.sessions.get(a.attachment.sessionId).state, 'stopped');
  assert.equal(JSON.stringify(a.attachment).includes('TokenHash'), false);
  f.runtime.ensureSession = ensure;
  const b = await f.key('beta');
  b.socket.destroy(); await new Promise(resolve => setTimeout(resolve, 15));
  f.runtime.authorizeSession = (id, token) => {
    const allowed = f.runtime.sessions.get(id)?.token === token;
    f.runtime.sessions.get(id).tokenHash = tokenHash('revoked during fixed attachment');
    return allowed;
  };
  const fixed = await f.connect({mode: 'session', sessionId: b.attachment.sessionId, token: 'a'.repeat(64)});
  await fixed.rpc('initialize');
  assert.equal((await fixed.call('mobile_start')).result.isError, true);
});

test('a client lost during provisioning leaves an expiring managed session instead of an active phantom connection', async t => {
  const f = await fixture(t, 30);
  const allocating = deferred(), entered = deferred();
  f.runtime.beforeEnsure = () => { entered.resolve(); return allocating.promise; };
  const socket = net.connect(f.broker.socketPath); socket.on('error', () => {});
  await once(socket, 'connect'); socket.write(JSON.stringify({mode: 'key', key: 'mid-allocate', template: 'clean35'})+'\n');
  await entered.promise; socket.destroy(); await new Promise(resolve => setTimeout(resolve, 10));
  allocating.resolve();
  await until(() => f.runtime.destroyed.length === 1);
  assert.equal(f.runtime.sessions.size, 0);
  assert.equal(f.runtime.calls.length, 0);
});

test('disconnect during allocation and broker restart retain no active phantom lease and seed expiry', async t => {
  const f = await fixture(t, 25);
  const allocating = deferred(), entered = deferred();
  f.runtime.beforeEnsure = () => { entered.resolve(); return allocating.promise; };
  const socket = net.connect(f.broker.socketPath); socket.on('error', () => {});
  await once(socket, 'connect'); socket.write(JSON.stringify({mode: 'key', key: 'mid-allocate', template: 'clean35'})+'\n');
  await entered.promise; socket.destroy();
  const closing = f.broker.close();
  allocating.resolve(); await closing;
  assert.equal(f.runtime.sessions.size, 1);
  f.runtime.beforeEnsure = undefined;
  const restarted = createMCPBroker({runtime: f.runtime});
  try { await restarted.listen(); await until(() => f.runtime.sessions.size === 0); }
  finally { await restarted.close(); }
});

test('stale socket recovery only removes a confirmed dead, owned socket', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-stale-')));
  const config = {dataDir: root}, filename = brokerSocketPath(config);
  await fs.mkdir(path.dirname(filename), {mode: 0o700});
  const script = 'const n=require("node:net"),f=require("node:fs");n.createServer().listen(process.argv[1],()=>{f.chmodSync(process.argv[1],0o600);process.stdout.write("ready");});';
  const child = spawn(process.execPath, ['-e', script, filename], {stdio: ['ignore', 'pipe', 'pipe']});
  t.after(async () => { child.kill('SIGKILL'); await fs.rm(path.dirname(filename), {recursive: true, force: true}); await fs.rm(root, {recursive: true, force: true}); });
  await once(child.stdout, 'data');
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  assert.equal((await fs.lstat(filename)).isSocket(), true);
  await clearStaleBroker(config);
  await assert.rejects(fs.lstat(filename), {code: 'ENOENT'});
});

test('broker client hides private handshake and supports random allocation, reconnect key and private-file authentication', async t => {
  const f = await fixture(t);
  async function launch(options) {
    const input = new PassThrough(), output = new PassThrough(); let pending = ''; const lines = []; const waiters = [];
    output.on('data', chunk => {
      pending += chunk; let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        const value = JSON.parse(pending.slice(0, end)); pending = pending.slice(end+1); lines.push(value); waiters.shift()?.(value);
      }
    });
    const completion = runBrokerMCP({config: f.config, input, output, ...options});
    t.after(async () => { input.end(); await completion.catch(() => {}); input.destroy(); output.destroy(); });
    const response = new Promise(resolve => waiters.push(resolve));
    input.write(JSON.stringify({jsonrpc: '2.0', id: 8, method: 'initialize'})+'\n');
    const result = await response;
    assert.equal(result.result.serverInfo.name, 'agent-mobile-runtime');
    assert.equal(lines.some(value => value.attached || value.token), false);
    return {input, output, completion};
  }
  const a = await launch({sessionKey: 'client-key'});
  const assigned = [...f.runtime.sessions.values()].find(value => value.key === 'client-key');
  a.input.end(); await a.completion; await new Promise(resolve => setTimeout(resolve, 10));
  const resumed = await launch({sessionKey: 'client-key'});
  assert.ok(f.runtime.sessions.has(assigned.id));
  const random = await launch({});
  assert.equal(f.runtime.sessions.size, 2);
  resumed.input.end(); random.input.end(); await Promise.all([resumed.completion, random.completion]);
  await new Promise(resolve => setTimeout(resolve, 10));
  const credentialFile = path.join(f.root, 'credential.json');
  await fs.writeFile(credentialFile, JSON.stringify({schema: 1, sessionId: assigned.id, token: assigned.token}), {mode: 0o600});
  await launch({credentialFile});
});
