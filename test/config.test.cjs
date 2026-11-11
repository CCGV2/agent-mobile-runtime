'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {loadConfig} = require('../src/config.cjs');
const {ControlClient} = require('../src/client.cjs');
const {parse} = require('../bin/agent-mobile.cjs');

test('configuration isolates service ports and rejects unsafe or ambiguous settings', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-config-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'config.json');
  const base = {dataDir: path.join(root, 'data'), sdkRoot: path.join(root, 'sdk')};
  await fs.writeFile(file, JSON.stringify(base));
  const config = await loadConfig(file);
  assert.equal(config.adbPath, path.join(base.sdkRoot, 'platform-tools/adb'));
  assert.notEqual(config.adbServerPort, 5037);
  assert.equal(config.headless, true);
  assert.equal(config.mcpGraceMs, 300000);
  for (const invalid of [
    {dataDir: 'relative'}, {controlPort: 5038}, {controlPort: 5555},
    {emulatorPortStart: 5555}, {maxDevices: 100}, {mediaMaxBytes: -1},
    {templates: {bad: {avdDir: 'relative'}}}, {headless: 'yes'},
    {mcpGraceMs: -1}, {mcpGraceMs: 3600001}, {mcpGraceMs: '300000'},
    {webrtc: {enabled: true}},
    {webrtc: {enabled: false, host: '0.0.0.0'}},
    {webrtc: {enabled: false, iceServers: [{urls: 'stun:example.com'}]}},
    {webrtc: {maxLifetimeSeconds: 601}},
  ]) {
    await fs.writeFile(file, JSON.stringify({...base, ...invalid}));
    await assert.rejects(loadConfig(file));
  }
  await fs.writeFile(file, '{');
  await assert.rejects(loadConfig(file), /configuration/);
});

test('MCP credential loader rejects world-readable files, symlinks and invalid identities', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-credentials-')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const file = path.join(root, 'session.json');
  const valid = {schema: 1, sessionId: 'm-11111111-1111-1111-1111-111111111111', token: 'a'.repeat(64)};
  await fs.writeFile(file, JSON.stringify(valid), {mode: 0o600});
  assert.equal((await ControlClient.session({controlPort: 7341}, file)).sessionId, valid.sessionId);
  await fs.chmod(file, 0o644);
  await assert.rejects(ControlClient.session({controlPort: 7341}, file), /private runtime file/);
  await fs.chmod(file, 0o600);
  await fs.symlink(file, path.join(root, 'linked'));
  await assert.rejects(ControlClient.session({controlPort: 7341}, path.join(root, 'linked')));
  await fs.writeFile(file, JSON.stringify({...valid, sessionId: '../other'}));
  await assert.rejects(ControlClient.session({controlPort: 7341}, file), /credential/);
});

test('operator CLI preserves literal values and rejects duplicate or incomplete options', () => {
  const result = parse(['--config', '/a path/config.json', 'session', 'create', '--template', 'clean', '--key', '$(do-not-execute)']);
  assert.deepEqual(result.words, ['session', 'create']);
  assert.equal(result.options.key, '$(do-not-execute)');
  for (const input of [['--config'], ['--shell', 'anything'], ['--kind', 'audio', '--kind', 'screen']]) assert.throws(() => parse(input));
});
