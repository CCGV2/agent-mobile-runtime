'use strict';

const net = require('node:net');
const {randomUUID} = require('node:crypto');
const {ControlClient} = require('./client.cjs');
const {validateBrokerEndpoint} = require('./mcp-broker.cjs');

async function runBrokerMCP({config, sessionKey, template, credentialFile, input = process.stdin, output = process.stdout}) {
  let request;
  if (credentialFile) {
    if (sessionKey !== undefined) throw new Error('Use either a private session file or a session key, not both.');
    let client;
    try { client = await ControlClient.session(config, credentialFile); }
    catch { throw new Error('Private session credential is unavailable or invalid.'); }
    request = {mode: 'session', sessionId: client.sessionId, token: client.token};
  } else {
    const key = sessionKey === undefined ? randomUUID() : sessionKey;
    if (typeof key !== 'string' || !key.length || key.length > 200 || /[\x00-\x1f\x7f]/.test(key)) throw new Error('Use a nonempty session key of at most 200 characters.');
    const templates = Object.keys(config.templates || {});
    const selected = template || (templates.length === 1 ? templates[0] : undefined);
    if (!selected || !Object.hasOwn(config.templates, selected)) throw new Error('Select a configured template with AGENT_MOBILE_TEMPLATE when more than one template exists.');
    request = {mode: 'key', key, template: selected};
  }
  let filename;
  try { filename = await validateBrokerEndpoint(config); }
  catch { throw new Error('Private MCP broker is unavailable. Start serve using the same config and OS user.'); }
  await new Promise((resolve, reject) => {
    const socket = net.connect(filename);
    let attached = false, finished = false, buffer = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error('MCP attachment timed out; inspect service state before reconnecting.')), Math.max(10000, config.bootTimeoutMs || 180000));
    const cleanup = () => {
      clearTimeout(timer); input.unpipe(socket); input.off('error', inputError); input.pause(); socket.unpipe(output);
    };
    function finish(error) {
      if (finished) return;
      finished = true; cleanup(); socket.destroy();
      if (error) reject(error); else resolve();
    }
    const inputError = () => finish(new Error('MCP input closed unexpectedly.'));
    input.on('error', inputError);
    socket.on('error', () => finish(new Error('Private MCP broker disconnected; do not replay uncertain operations.')));
    socket.on('close', () => finish(attached ? undefined : new Error('Private MCP broker closed before attachment.')));
    socket.on('connect', () => socket.write(JSON.stringify(request)+'\n'));
    const first = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0) { if (buffer.length > 16384) finish(new Error('Invalid MCP attachment response.')); return; }
      if (end > 16384) { finish(new Error('Invalid MCP attachment response.')); return; }
      let response;
      try { response = JSON.parse(buffer.subarray(0, end).toString('utf8')); }
      catch { finish(new Error('Invalid MCP attachment response.')); return; }
      if (response?.attached !== true) { finish(new Error(typeof response?.error?.message === 'string' ? response.error.message : 'MCP attachment refused.')); return; }
      attached = true; clearTimeout(timer); socket.off('data', first);
      if (buffer.length > end + 1) output.write(buffer.subarray(end + 1));
      socket.pipe(output, {end: false}); input.pipe(socket);
    };
    socket.on('data', first);
  });
}

module.exports = {runBrokerMCP};
