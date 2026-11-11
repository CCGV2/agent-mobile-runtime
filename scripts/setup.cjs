#!/usr/bin/env node
'use strict';

const HELP = `agent-mobile-runtime setup (Node.js 22+)

  node scripts/setup.cjs --help

Linux x86_64: install a private SDK, scrcpy and a clean Android 35 template.
  node scripts/setup.cjs --root /absolute/fresh-directory --plan
  node scripts/setup.cjs --root /absolute/fresh-directory --accept-sdk-licenses
  Optional: --with-webrtc --java /absolute/java --python /absolute/python

macOS, or Linux with an existing SDK: create a private clean template/config.
  node scripts/setup.cjs --root /absolute/fresh-directory --sdk /absolute/sdk --plan
  node scripts/setup.cjs --root /absolute/fresh-directory --sdk /absolute/sdk
  Optional: --avdmanager /absolute/avdmanager --java /absolute/java
  Install the SDK/image, scrcpy and FFmpeg first; see docs/macos.md.

Plan does not write files, run subprocesses, or contact the network.
Setup never starts a service/emulator or changes your MCP client configuration.
Prepared does not mean ready: inspect prerequisitesReady, then run doctor.
Read AGENTS.md and docs/quickstart.md for the complete installation/MCP flow.
`;

async function main(argv = process.argv.slice(2), hooks = {}) {
  if (!argv.length || argv.includes('--help')) return HELP;
  const version = hooks.nodeVersion || process.versions.node;
  if (Number(version.split('.')[0]) < 22) throw new Error('Use Node.js 22 or newer for setup.');
  const platform = hooks.platform || process.platform;
  const architecture = hooks.architecture || process.arch;
  if (!(platform === 'linux' && architecture === 'x64' || platform === 'darwin' && ['x64', 'arm64'].includes(architecture))) {
    throw new Error('Setup supports Linux x86_64 and macOS x86_64/arm64. Windows and Linux ARM are not supported. See docs/quickstart.md.');
  }
  const existing = platform === 'darwin' || argv.includes('--sdk');
  const run = existing
    ? hooks.existingSetup || require('./setup-existing-sdk.cjs').main
    : hooks.linuxSetup || require('./setup-linux.cjs').main;
  return run(argv);
}

if (require.main === module) main().then(value => {
  process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value, null, 2)+'\n');
}).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });

module.exports = {main, HELP};
