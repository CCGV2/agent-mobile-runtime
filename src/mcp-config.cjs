'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {ControlClient} = require('./client.cjs');

// The operator can copy this fragment into a client. Credentials stay in the
// private runtime file; neither tokens nor administrator credentials are output.
async function createMCPConfig({config, configFile, sessionId}) {
  if (!/^m-[a-f0-9-]{36}$/.test(sessionId || '')) throw new Error('Specify the session ID returned by session create.');
  const credentialFile = path.join(config.dataDir, 'secrets', 'sessions', `${sessionId}.json`);
  try {
    const client = await ControlClient.session(config, credentialFile);
    if (client.sessionId !== sessionId) throw new Error('Wrong session identity.');
  } catch {
    throw new Error('Cannot generate MCP config: the session credential is missing, invalid, linked, or not private. Use a current operator-created session.');
  }
  const filename = await fs.realpath(configFile);
  return {mcpServers: {'agent-mobile': {
    command: process.execPath,
    args: [path.resolve(__dirname, '..', 'bin', 'agent-mobile.cjs'), '--config', filename, 'mcp'],
    env: {AGENT_MOBILE_SESSION_FILE: credentialFile},
  }}};
}

module.exports = {createMCPConfig};
