'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const {spawn} = require('node:child_process');
const {once} = require('node:events');

// Exercise the installed CLI flow without an Android binary: allocating a
// stopped clean AVD must not try to boot Android during MCP initialization.
test('real serve and MCP CLIs allocate distinct keys, fence duplicates, reconnect, and shut down cleanly', {timeout: 20000}, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-keyed-cli-')));
  const children = new Set();
  async function terminate(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
  }
  t.after(async () => {
    await Promise.all([...children].map(terminate));
    await fs.rm(root, {recursive: true, force: true});
  });
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const avdDir = path.join(root, 'clean.avd');
  await fs.mkdir(avdDir, {mode: 0o700});
  await fs.writeFile(path.join(avdDir, 'config.ini'), 'image.sysdir.1=system-images/android-35/default/x86_64/\n');
  await fs.writeFile(path.join(avdDir, 'userdata-qemu.img'), 'empty test data');
  const configFile = path.join(root, 'config.json');
  await fs.writeFile(configFile, JSON.stringify({dataDir: path.join(root, 'data'), sdkRoot: path.join(root, 'missing-sdk'),
    controlPort: port, adbServerPort: 5044, emulatorPortStart: 5566, maxDevices: 2, mcpGraceMs: 10000,
    templates: {clean35: {avdDir}},
  }), {mode: 0o600});
  const cli = path.resolve(__dirname, '..', 'bin', 'agent-mobile.cjs');
  function start(command, extra = {}) {
    const child = spawn(process.execPath, [cli, '--config', configFile, command], {
      env: {PATH: '/usr/bin:/bin', ...extra}, stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.add(child); return child;
  }
  const service = start('serve');
  let serviceError = '';
  service.stderr.on('data', data => { serviceError += data; });
  const deadline = Date.now() + 5000;
  while (!serviceError.includes('Mobile runtime listening')) {
    assert.equal(service.exitCode, null, serviceError);
    assert.ok(Date.now() < deadline, serviceError);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  function connect(key) {
    const child = start('mcp', {AGENT_MOBILE_SESSION_KEY: key, AGENT_MOBILE_TEMPLATE: 'clean35'});
    let buffer = '', stderr = '';
    const waiting = new Map();
    child.stderr.on('data', data => { stderr += data; });
    child.stdout.on('data', data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const value = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
        waiting.get(value.id)?.(value);
      }
    });
    let next = 0;
    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++next;
      const timeout = setTimeout(() => reject(new Error(`MCP response timed out: ${stderr}`)), 5000);
      waiting.set(id, value => { clearTimeout(timeout); waiting.delete(id); resolve(value); });
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params})+'\n');
    });
    return {child, rpc, stderr: () => stderr};
  }
  const a = connect('task-a'), b = connect('task-b');
  await Promise.all([a, b].map(client => client.rpc('initialize', {protocolVersion: '2025-06-18'})));
  const state = async client => {
    const response = await client.rpc('tools/call', {name: 'mobile_state', arguments: {}});
    assert.equal(response.result.isError, undefined, JSON.stringify(response));
    return JSON.parse(response.result.content[0].text);
  };
  const [firstA, firstB] = await Promise.all([state(a), state(b)]);
  assert.notEqual(firstA.id, firstB.id);
  assert.equal(firstA.state, 'stopped'); assert.equal(firstB.state, 'stopped');
  const duplicate = connect('task-a');
  const [duplicateCode] = await once(duplicate.child, 'exit');
  assert.equal(duplicateCode, 1);
  assert.match(duplicate.stderr(), /already connected/);
  const closedA = once(a.child, 'exit'); a.child.stdin.end(); await closedA;
  const resumed = connect('task-a');
  await resumed.rpc('initialize', {protocolVersion: '2025-06-18'});
  assert.equal((await state(resumed)).id, firstA.id);
  assert.equal((await state(b)).id, firstB.id);
  await terminate(service);
  assert.equal(service.exitCode, 0, serviceError);
  assert.doesNotMatch(serviceError, /recovery/);
});
