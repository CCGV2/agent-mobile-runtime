'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {ControlClient} = require('./client.cjs');

// The operator can copy this fragment into a client. Credentials stay in the
// private runtime file; neither tokens nor administrator credentials are output.
async function createMCPConfig({config, configFile, sessionId, template}) {
  let env;
  if (sessionId !== undefined) {
    if (!/^m-[a-f0-9-]{36}$/.test(sessionId || '')) throw new Error('Specify the session ID returned by session create.');
    if (template !== undefined) throw new Error('A fixed session already selects its template. Omit --template.');
    const credentialFile = path.join(config.dataDir, 'secrets', 'sessions', `${sessionId}.json`);
    try {
      const client = await ControlClient.session(config, credentialFile);
      if (client.sessionId !== sessionId) throw new Error('Wrong session identity.');
    } catch {
      throw new Error('Cannot generate MCP config: the session credential is missing, invalid, linked, or not private. Use a current operator-created session.');
    }
    env = {AGENT_MOBILE_SESSION_FILE: credentialFile};
  } else {
    const names = Object.keys(config.templates);
    const selected = template === undefined && names.length === 1 ? names[0] : template;
    if (!selected || !Object.hasOwn(config.templates, selected)) throw new Error('Select a configured template with --template NAME for keyed MCP.');
    // The launcher injects a per-task session key. Never generate a shared
    // fixed key that would route unrelated agents to the same Android device.
    env = {AGENT_MOBILE_TEMPLATE: selected};
  }
  const filename = await fs.realpath(configFile);
  return {mcpServers: {'agent-mobile': {
    command: process.execPath,
    args: [path.resolve(__dirname, '..', 'bin', 'agent-mobile.cjs'), '--config', filename, 'mcp'],
    env,
  }}};
}

module.exports = {createMCPConfig};
