'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {PassThrough} = require('node:stream');
const {serveMCP} = require('../src/mcp.cjs');

const SESSION = 'm-11111111-1111-4111-8111-111111111111';
const RECORDING = '22222222-2222-4222-8222-222222222222';
const turn = () => new Promise(resolve => setImmediate(resolve));

function harness(t, implementation = {}, lifecycle = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const lines = [], responses = [], waiters = [], actionCalls = [], requests = [];
  let pending = '';
  output.on('data', chunk => {
    pending += chunk.toString('utf8');
    let end;
    while ((end = pending.indexOf('\n')) !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      lines.push(line);
      const message = JSON.parse(line);
      responses.push(message);
      for (let index = waiters.length - 1; index >= 0; index--) {
        if (waiters[index].predicate(message)) {
          const [waiter] = waiters.splice(index, 1);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    }
  });
  const client = {
    sessionId: SESSION,
    action: async (action, args, options) => {
      actionCalls.push({action, args, options});
      return implementation.action ? implementation.action(action, args, options) : {ok: true};
    },
    request: async (route, options) => {
      requests.push({route, options});
      return implementation.request ? implementation.request(route, options) : {buffer: Buffer.from('recording'), mime: 'audio/ogg'};
    },
  };
  const server = serveMCP({client, input, output, ...lifecycle});
  t.after(() => {
    server.close(); input.destroy(); output.destroy();
    for (const waiter of waiters) clearTimeout(waiter.timer);
  });
  let next = 1;
  function waitFor(predicate) {
    return new Promise((resolve, reject) => {
      const waiter = {predicate, resolve, timer: setTimeout(() => reject(new Error('MCP response timeout')), 2000)};
      waiters.push(waiter);
    });
  }
  function raw(value) { input.write(value); }
  function request(method, params, id = next++) {
    const response = waitFor(message => message.id === id);
    raw(JSON.stringify({jsonrpc: '2.0', id, method, ...(params === undefined ? {} : {params})}) + '\n');
    return response;
  }
  const initialize = (protocolVersion = '2025-06-18') => request('initialize', {protocolVersion, clientInfo: {name: 'test', version: '1'}, capabilities: {}});
  const call = (name, args = {}) => request('tools/call', {name, arguments: args});
  return {input, output, server, client, lines, responses, actionCalls, requests, raw, waitFor, request, initialize, call};
}

test('MCP initializes and exposes a bounded mobile tool surface without operator or shell tools', async t => {
  const h = harness(t);
  assert.equal((await h.request('tools/list')).error.code, -32000);
  const initialized = await h.initialize();
  assert.equal(initialized.result.protocolVersion, '2025-06-18');
  assert.equal(initialized.result.serverInfo.name, 'agent-mobile-runtime');
  assert.deepEqual(initialized.result.capabilities, {tools: {}});
  const response = await h.request('tools/list');
  const names = response.result.tools.map(tool => tool.name);
  for (const name of ['mobile_state', 'mobile_snapshot', 'mobile_screenshot', 'mobile_tap', 'mobile_swipe', 'mobile_recording_start', 'mobile_recording_stop', 'mobile_recording_read']) assert.ok(names.includes(name));
  for (const name of ['mobile_takeover', 'mobile_release', 'mobile_recover', 'mobile_install_app', 'mobile_create', 'mobile_destroy', 'mobile_shell', 'mobile_adb']) assert.ok(!names.includes(name));
  assert.ok(response.result.tools.every(tool => tool.inputSchema.additionalProperties === false));
  assert.equal((await h.initialize()).error.code, -32600);
  assert.equal(h.actionCalls.length, 0);
});

test('JSON parsing rejects malformed requests and recovers for subsequent valid messages', async t => {
  const h = harness(t);
  const parseError = h.waitFor(message => message.id === null);
  h.raw('{broken json\n');
  assert.equal((await parseError).error.code, -32700);
  for (const value of [[], null, {jsonrpc: '1.0', id: 'bad', method: 'ping'}]) {
    const response = h.waitFor(message => message.error?.code === -32600);
    h.raw(JSON.stringify(value) + '\n');
    await response;
  }
  assert.deepEqual((await h.request('ping')).result, {});
  assert.equal((await h.request('ping', {}, null)).error.code, -32600);
  assert.equal(h.actionCalls.length, 0);
});

test('MCP accepts fragmented and multiple newline-delimited requests without non-JSON stdout', async t => {
  const h = harness(t);
  const response = h.waitFor(message => message.id === 'fragment');
  const wire = JSON.stringify({jsonrpc: '2.0', id: 'fragment', method: 'initialize', params: {protocolVersion: '2025-03-26'}}) + '\n';
  for (let offset = 0; offset < wire.length; offset += 7) h.raw(wire.slice(offset, offset + 7));
  assert.equal((await response).result.protocolVersion, '2025-03-26');
  const first = h.waitFor(message => message.id === 'one');
  const second = h.waitFor(message => message.id === 'two');
  h.raw('\n' + JSON.stringify({jsonrpc: '2.0', id: 'one', method: 'ping'}) + '\n' + JSON.stringify({jsonrpc: '2.0', id: 'two', method: 'tools/list'}) + '\n');
  await Promise.all([first, second]);
  assert.equal(h.lines.length, 3);
  for (const line of h.lines) assert.equal(JSON.parse(line).jsonrpc, '2.0');
});

for (const newline of [false, true]) test(`MCP rejects oversized input ${newline ? 'with' : 'without'} a newline and closes before dispatch`, async t => {
  const h = harness(t);
  const response = h.waitFor(message => message.error?.message === 'Request exceeds size limit');
  h.raw('a'.repeat(1024 * 1024 + 1) + (newline ? '\n' : ''));
  assert.equal((await response).error.code, -32600);
  h.raw(JSON.stringify({jsonrpc: '2.0', id: 99, method: 'ping'}) + '\n');
  await turn();
  assert.equal(h.responses.length, 1);
  assert.equal(h.actionCalls.length, 0);
});

test('unknown tools and invalid arguments never reach the device client', async t => {
  const h = harness(t);
  await h.initialize();
  assert.equal((await h.request('resources/list')).error.code, -32601);
  for (const [name, args] of [
    ['mobile_shell', {command: 'id'}],
    ['mobile_takeover', {}],
    ['mobile_tap', {x: 1, y: 2, deviceId: 'other-device'}],
    ['mobile_tap', {x: -1, y: 2}],
    ['mobile_tap', {x: 1.5, y: 2}],
    ['mobile_swipe', {x1: 1, y1: 2, x2: 3, y2: 4, durationMs: 10001}],
    ['mobile_text', {text: 'x'.repeat(2001)}],
    ['mobile_key', {key: 'POWER'}],
    ['mobile_launch_app', {package: 'a.b; rm -rf /'}],
    ['mobile_recording_read', {recordingId: '../other'}],
    ['mobile_state', {sessionId: 'other-session'}],
  ]) assert.equal((await h.call(name, args)).error.code, -32602, name);
  assert.equal(h.actionCalls.length, 0);
  assert.equal(h.requests.length, 0);
});

test('normal tool calls use the fixed session client and screenshot content is an MCP PNG image', async t => {
  const image = Buffer.from('png fixture').toString('base64');
  const h = harness(t, {action: async action => action === 'screenshot' ? {data: image} : {deviceId: 'owned-device'}});
  await h.initialize();
  const tap = await h.call('mobile_tap', {x: 123, y: 456});
  assert.deepEqual(JSON.parse(tap.result.content[0].text), {deviceId: 'owned-device'});
  assert.equal(h.actionCalls[0].action, 'tap');
  assert.deepEqual(h.actionCalls[0].args, {x: 123, y: 456});
  assert.ok(h.actionCalls[0].options.signal instanceof AbortSignal);
  const shot = await h.call('mobile_screenshot');
  assert.deepEqual(shot.result.content, [{type: 'image', data: image, mimeType: 'image/png'}]);
  assert.equal(h.client.sessionId, SESSION);
});

for (const version of ['2025-03-26', '2025-06-18']) test(`audio recording_read uses audio content under MCP ${version}`, async t => {
  const h = harness(t);
  await h.initialize(version);
  const result = await h.call('mobile_recording_read', {recordingId: RECORDING});
  assert.deepEqual(result.result.content, [{type: 'audio', data: Buffer.from('recording').toString('base64'), mimeType: 'audio/ogg'}]);
  assert.equal(h.requests[0].route, `/v1/sessions/${SESSION}/artifacts/${RECORDING}`);
  assert.equal(h.requests[0].options.binary, true);
  assert.ok(h.requests[0].options.signal instanceof AbortSignal);
});

test('older MCP clients receive audio as a session-scoped embedded resource', async t => {
  const h = harness(t);
  await h.initialize('2024-11-05');
  const result = await h.call('mobile_recording_read', {recordingId: RECORDING});
  assert.deepEqual(result.result.content, [{type: 'resource', resource: {uri: `mobile-recording://${SESSION}/${RECORDING}`, mimeType: 'audio/ogg', blob: Buffer.from('recording').toString('base64')}}]);
});

test('video recordings remain embedded resources and do not expose host file paths', async t => {
  const h = harness(t, {request: async () => ({buffer: Buffer.from('movie'), mime: 'video/x-matroska'})});
  await h.initialize();
  const response = await h.call('mobile_recording_read', {recordingId: RECORDING});
  const content = response.result.content[0];
  assert.equal(content.type, 'resource');
  assert.equal(content.resource.mimeType, 'video/x-matroska');
  assert.equal(content.resource.uri, `mobile-recording://${SESSION}/${RECORDING}`);
  assert.equal(content.resource.path, undefined);
});

test('coded subprocess errors cannot leak command arguments or credentials into MCP output', async t => {
  const h = harness(t, {action: async () => {
    const error = new Error('spawn /private/secret/adb --token very-secret-value ENOENT');
    error.code = 'ENOENT';
    throw error;
  }});
  await h.initialize();
  const response = await h.call('mobile_snapshot');
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /uncertain|inspect|state/i);
  assert.doesNotMatch(JSON.stringify(response), /very-secret-value|private\/secret|ENOENT/);
  assert.equal(h.actionCalls.length, 1);
});

test('client cancellation aborts exactly one operation, reports uncertainty, and never replays input', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const h = harness(t, {action: (action, _args, {signal}) => {
    if (action !== 'tap') return Promise.resolve({ok: true});
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => { const error = new Error('abort'); error.name = 'AbortError'; reject(error); }, {once: true});
      started();
    });
  }});
  await h.initialize();
  const response = h.request('tools/call', {name: 'mobile_tap', arguments: {x: 1, y: 2}}, 'tap-once');
  await ready;
  h.raw(JSON.stringify({jsonrpc: '2.0', method: 'notifications/cancelled', params: {requestId: 'tap-once'}}) + '\n');
  const result = await response;
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /Cancelled.*uncertain/);
  assert.equal(h.actionCalls[0].options.signal.aborted, true);
  await turn();
  assert.equal(h.actionCalls.filter(call => call.action === 'tap').length, 1);
  assert.equal((await h.call('mobile_state')).result.isError, undefined);
  for (const line of h.lines) assert.doesNotThrow(() => JSON.parse(line));
});

test('closing the MCP connection aborts inflight work without replying or replaying it', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const h = harness(t, {action: (_action, _args, {signal}) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { const error = new Error('abort'); error.name = 'AbortError'; reject(error); }, {once: true});
    started();
  })});
  await h.initialize();
  h.raw(JSON.stringify({jsonrpc: '2.0', id: 'closing', method: 'tools/call', params: {name: 'mobile_tap', arguments: {x: 1, y: 2}}}) + '\n');
  await ready;
  h.input.end();
  await turn();
  assert.equal(h.actionCalls.length, 1);
  assert.equal(h.actionCalls[0].options.signal.aborted, true);
  assert.equal(h.responses.length, 1);
});

test('disconnect reports pending work and keeps its claim until the actual dispatched operation settles', async t => {
  let finish, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const closed = [], idle = [];
  const h = harness(t, {action: () => new Promise(resolve => { finish = resolve; entered(); })}, {
    onClose: value => closed.push(value), onIdle: () => idle.push(true),
  });
  await h.initialize();
  h.raw(JSON.stringify({jsonrpc: '2.0', id: 55, method: 'tools/call', params: {name: 'mobile_tap', arguments: {x: 1, y: 2}}})+'\n');
  await started;
  h.server.close(); h.server.close();
  assert.deepEqual(closed, [{pending: 1}]);
  assert.equal(h.actionCalls[0].options.signal.aborted, true);
  assert.deepEqual(idle, []);
  finish({ok: true}); await turn();
  assert.deepEqual(idle, [true]);
  assert.equal(h.responses.length, 1);
  assert.equal(h.actionCalls.length, 1);
});

test('an idle transport reports one clean close without waiting for nonexistent operations', async t => {
  const closed = [], idle = [];
  const h = harness(t, {}, {onClose: value => closed.push(value), onIdle: () => idle.push(true)});
  await h.initialize();
  h.server.close(); h.input.destroy(); await turn();
  assert.deepEqual(closed, [{pending: 0}]);
  assert.deepEqual(idle, [true]);
});
