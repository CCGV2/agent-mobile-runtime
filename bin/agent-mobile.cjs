#!/usr/bin/env node
'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {loadConfig} = require('../src/config.cjs');
const {readPrivate} = require('../src/storage.cjs');
const {AndroidBackend} = require('../src/android.cjs');
const {Provisioner} = require('../src/provision.cjs');
const {MediaManager} = require('../src/media.cjs');
const {MobileRuntime, alive, identifier} = require('../src/runtime.cjs');
const {createServer} = require('../src/server.cjs');
const {ControlClient} = require('../src/client.cjs');
const {serveMCP} = require('../src/mcp.cjs');
const {doctor} = require('../src/doctor.cjs');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {WebRTCManager} = require('../src/webrtc.cjs');
const {resolveEmulatorGrpc} = require('../src/emulator-grpc.cjs');

const HELP = `agent-mobile-runtime (Node.js 22+)

  agent-mobile [--config /absolute/config.json] doctor
  agent-mobile [--config ...] serve
  agent-mobile [--config ...] open
  agent-mobile [--config ...] unlock
  agent-mobile [--config ...] session create --template NAME [--key PAX_SESSION_ID]
  agent-mobile [--config ...] session list
  agent-mobile [--config ...] session start|stop|state|destroy|takeover|release ID
  agent-mobile [--config ...] session recover ID --confirm-stopped
  agent-mobile [--config ...] install ID --apk /absolute/file.apk
  agent-mobile [--config ...] record start ID [--kind screen|audio] [--seconds 60]
  agent-mobile [--config ...] record stop ID --id RECORDING_ID
  agent-mobile [--config ...] record list ID
  agent-mobile [--config ...] mcp

MCP requires AGENT_MOBILE_SESSION_FILE from operator session creation.
No credential contents are printed. No Android SDK is downloaded automatically.
See README.md and docs/pax-api.md for configuration and integration.
`;

function parse(argv) {
  const words = [], options = {};
  const flags = new Set(['confirm-stopped']);
  const known = new Set(['config', 'template', 'key', 'apk', 'kind', 'seconds', 'id']);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) { words.push(argv[i]); continue; }
    const name = argv[i].slice(2);
    if (Object.hasOwn(options, name)) throw new Error('Duplicate option.');
    if (flags.has(name)) options[name] = true;
    else if (known.has(name) && argv[i+1] && !argv[i+1].startsWith('--')) options[name] = argv[++i];
    else throw new Error('Unknown or incomplete option.');
  }
  return {words, options};
}

async function serve(config) {
  const provisioner = new Provisioner({config});
  const backend = new AndroidBackend({config});
  const webrtc = config.webrtc.enabled ? new WebRTCManager({config, resolveAccess: device => resolveEmulatorGrpc({config, device, env: backend._env(device)})}) : null;
  const runtime = await new MobileRuntime({config, provisioner, backend, media: new MediaManager({config}), webrtc}).init();
  const server = createServer({runtime, provisioner});
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.controlPort, '127.0.0.1', resolve); });
  } catch (error) { await runtime.close(); throw error; }
  process.stderr.write(`Mobile runtime listening on http://127.0.0.1:${config.controlPort} (protocol v1).\n`);
  let stopping = false;
  async function shutdown() {
    if (stopping) return;
    stopping = true;
    const closed = new Promise(resolve => server.close(resolve));
    server.closeAllConnections();
    try { await runtime.close(); }
    catch { process.stderr.write('Some devices require explicit recovery; inspect session state before restarting.\n'); process.exitCode = 1; }
    await closed;
  }
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

async function main(argv = process.argv.slice(2)) {
  if (!argv.length || argv.includes('--help') || argv[0] === 'help') { process.stdout.write(HELP); return; }
  const {words, options} = parse(argv);
  const config = await loadConfig(options.config);
  const [command, sub, rawID] = words;
  if (command === 'doctor') {
    const report = await doctor(config, new Provisioner({config}));
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (!report.ready) process.exitCode = 2;
    return;
  }
  if (command === 'serve') return serve(config);
  if (command === 'mcp') {
    const filename = process.env.AGENT_MOBILE_SESSION_FILE;
    if (!filename || !path.isAbsolute(filename)) throw new Error('Set AGENT_MOBILE_SESSION_FILE to the operator-created private session credential file.');
    const client = await ControlClient.session(config, filename);
    serveMCP({client}); return;
  }
  if (command === 'unlock') {
    const lock = path.join(config.dataDir, 'service.lock');
    const value = JSON.parse(await readPrivate(lock));
    if (!Number.isSafeInteger(value.pid) || value.pid < 1 || alive(value.pid)) throw new Error('Service lock may still be active; refusing to remove it.');
    await fs.unlink(lock);
    process.stdout.write('Removed a dead service lock. Interrupted devices still require reconciliation.\n'); return;
  }
  const token = (await readPrivate(path.join(config.dataDir, 'secrets', 'admin-token'))).trim();
  const client = new ControlClient({port: config.controlPort, token});
  if (command === 'open') {
    const login = await client.request('/v1/admin/viewer-login', {method: 'POST', body: {}});
    const url = `http://127.0.0.1:${config.controlPort}/#code=${encodeURIComponent(login.code)}`;
    const file = process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null;
    if (!file) throw new Error('Open is supported on macOS and Linux desktop hosts.');
    try { await promisify(execFile)(file, [url], {timeout: 10000, maxBuffer: 16384, shell: false}); }
    catch { throw new Error('Could not open the viewer. Run open in a local operator desktop terminal.'); }
    process.stdout.write(`Opened local viewer at http://127.0.0.1:${config.controlPort}/ (login link is single-use).\n`);
    return;
  }
  let result;
  if (command === 'session' && sub === 'create') {
    if (!options.template) throw new Error('Specify --template.');
    result = await client.request('/v1/admin/sessions', {method: 'POST', body: {template: options.template, ...(options.key ? {key: options.key} : {})}});
  } else if (command === 'session' && sub === 'list') result = await client.request('/v1/admin/sessions');
  else if (command === 'session' && identifier(rawID)) {
    const route = `/v1/admin/sessions/${rawID}`;
    if (sub === 'destroy') result = await client.request(route, {method: 'DELETE'});
    else if (sub === 'state') result = await client.request(route + '/state');
    else if (['start', 'stop', 'takeover', 'release', 'recover'].includes(sub)) {
      if (sub === 'recover' && !options['confirm-stopped']) throw new Error('Inspect and stop the interrupted emulator, then use --confirm-stopped.');
      result = await client.request(route + '/action', {method: 'POST', body: {action: sub, args: sub === 'recover' ? {confirmStopped: true} : {}}});
    } else throw new Error('Unknown session command.');
  } else if (command === 'install' && identifier(sub) && options.apk) {
    result = await client.request(`/v1/admin/sessions/${sub}/action`, {method: 'POST', body: {action: 'install_app', args: {apkPath: path.resolve(options.apk)}}});
  } else if (command === 'record' && identifier(rawID)) {
    const action = {start: 'recording_start', stop: 'recording_stop', list: 'recording_list'}[sub];
    if (!action) throw new Error('Unknown record command.');
    const args = sub === 'start' ? {kind: options.kind || 'screen', durationSec: options.seconds === undefined ? 60 : Number(options.seconds)} : sub === 'stop' ? {recordingId: options.id} : {};
    result = await client.request(`/v1/admin/sessions/${rawID}/action`, {method: 'POST', body: {action, args}});
  } else throw new Error('Unknown command; use --help.');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) main().catch(error => {
  // Never stringify child-process errors, which can embed input arguments.
  const safe = error.code === 'ENOENT' ? 'Required file or executable is missing; run doctor and check configuration.' : error.message;
  process.stderr.write(`agent-mobile: ${safe}\n`); process.exitCode = 1;
});

module.exports = {main, parse};
