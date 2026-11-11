'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createMCPConfig} = require('../src/mcp-config.cjs');
const {loadConfig} = require('../src/config.cjs');
const {createMCPBroker} = require('../src/mcp-broker.cjs');
const {createHash} = require('node:crypto');
const execute = promisify(execFile);
const SESSION = 'm-11111111-1111-4111-8111-111111111111';
const TOKEN = 'd'.repeat(64);

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile mcp config ')));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const configFile = path.join(root, 'runtime config.json');
  await fs.writeFile(configFile, JSON.stringify({dataDir: path.join(root, 'private data'), sdkRoot: path.join(root, 'sdk'), templates: {clean35: {avdDir: path.join(root, 'template.avd')}}}), {mode: 0o600});
  const config = await loadConfig(configFile);
  const credentialFile = path.join(config.dataDir, 'secrets', 'sessions', `${SESSION}.json`);
  await fs.mkdir(path.dirname(credentialFile), {recursive: true, mode: 0o700});
  await fs.writeFile(credentialFile, JSON.stringify({schema: 1, sessionId: SESSION, token: TOKEN}), {mode: 0o600});
  return {root, config, configFile, credentialFile, sessionId: SESSION};
}

test('generated MCP config has absolute executable/file paths, keeps spaced paths intact, and never embeds tokens', async t => {
  const f = await fixture(t);
  const fragment = await createMCPConfig(f);
  const entry = fragment.mcpServers['agent-mobile'];
  assert.equal(entry.command, process.execPath);
  assert.equal(entry.args.at(-1), 'mcp');
  assert.equal(entry.args[2], f.configFile);
  for (const value of [entry.command, entry.args[0], entry.args[2], entry.env.AGENT_MOBILE_SESSION_FILE]) assert.ok(path.isAbsolute(value));
  assert.equal(entry.env.AGENT_MOBILE_SESSION_FILE, f.credentialFile);
  assert.equal(JSON.stringify(fragment).includes(TOKEN), false);
  await assert.rejects(fs.stat(path.join(f.config.dataDir, 'secrets', 'admin-token')), {code: 'ENOENT'});
});

test('keyed MCP config needs no session credential and never invents a globally shared key', async t => {
  const f = await fixture(t);
  await fs.unlink(f.credentialFile);
  const fragment = await createMCPConfig({...f, sessionId: undefined});
  assert.deepEqual(fragment.mcpServers['agent-mobile'].env, {AGENT_MOBILE_TEMPLATE: 'clean35'});
  assert.equal(JSON.stringify(fragment).includes(TOKEN), false);
  const multi = {...f.config, templates: {...f.config.templates, other: {avdDir: path.join(f.root, 'other.avd')}}};
  await assert.rejects(createMCPConfig({...f, config: multi, sessionId: undefined}), /--template/);
  assert.equal((await createMCPConfig({...f, config: multi, sessionId: undefined, template: 'other'})).mcpServers['agent-mobile'].env.AGENT_MOBILE_TEMPLATE, 'other');
  await assert.rejects(createMCPConfig({...f, sessionId: undefined, template: 'missing'}), /--template/);
});

test('MCP config refuses malformed IDs, absent, readable, linked, or mismatched credentials without exposing their contents', async t => {
  const f = await fixture(t);
  await assert.rejects(createMCPConfig({...f, sessionId: '../other'}), /session ID/);
  await fs.chmod(f.credentialFile, 0o644);
  await assert.rejects(createMCPConfig(f), /not private/);
  await fs.chmod(f.credentialFile, 0o600);
  const saved = path.join(f.root, 'saved.json');
  await fs.rename(f.credentialFile, saved);
  await fs.symlink(saved, f.credentialFile);
  await assert.rejects(createMCPConfig(f), /linked/);
  await fs.unlink(f.credentialFile);
  await assert.rejects(createMCPConfig(f), /missing/);
  await fs.rename(saved, f.credentialFile);
  await fs.writeFile(f.credentialFile, JSON.stringify({schema: 1, sessionId: SESSION.replace('11111111', '22222222'), token: TOKEN}));
  await assert.rejects(createMCPConfig(f), /invalid/);
  await fs.writeFile(f.credentialFile, TOKEN+' invalid json');
  await assert.rejects(createMCPConfig(f), error => !error.message.includes(TOKEN));
});

test('CLI-generated fragment starts a real STDIO MCP with a minimal GUI-style PATH', async t => {
  const f = await fixture(t);
  const session = {id: SESSION, tokenHash: createHash('sha256').update(TOKEN).digest('hex')};
  const runtime = {config: f.config, sessions: new Map([[SESSION, session]]),
    authorizeSession: (id, token) => id === SESSION && token === TOKEN,
    state: id => ({id, state: 'stopped'}), listManagedSessions: () => [],
  };
  const broker = createMCPBroker({runtime});
  await broker.listen();
  t.after(() => broker.close());
  const cli = path.resolve(__dirname, '..', 'bin', 'agent-mobile.cjs');
  const printed = await execute(process.execPath, [cli, '--config', f.configFile, 'mcp-config', SESSION]);
  assert.equal(printed.stdout.includes(TOKEN), false);
  const entry = JSON.parse(printed.stdout).mcpServers['agent-mobile'];
  const child = spawn(entry.command, entry.args, {env: {PATH: '/usr/bin:/bin', ...entry.env}, stdio: ['pipe', 'pipe', 'pipe']});
  t.after(() => child.kill());
  let output = '', stderr = '';
  const lines = [], waiting = new Map();
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => {
    output += data;
    let end;
    while ((end = output.indexOf('\n')) !== -1) {
      const line = output.slice(0, end); output = output.slice(end + 1); lines.push(line);
      const value = JSON.parse(line); waiting.get(value.id)?.(value);
    }
  });
  const request = (id, method, params = {}) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`STDIO MCP did not respond: ${stderr}`)), 5000);
    waiting.set(id, value => { clearTimeout(timeout); waiting.delete(id); resolve(value); });
    child.stdin.write(JSON.stringify({jsonrpc: '2.0', id, method, params})+'\n');
  });
  const initialized = await request(1, 'initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'onboarding-test', version: '1'}});
  assert.equal(initialized.result.serverInfo.name, 'agent-mobile-runtime');
  const listed = await request(2, 'tools/list');
  assert.ok(listed.result.tools.some(tool => tool.name === 'mobile_screenshot'));
  assert.ok(!listed.result.tools.some(tool => /install|shell|create_session/.test(tool.name)));
  assert.equal(lines.join('').includes(TOKEN), false);
  child.stdin.end();
});
