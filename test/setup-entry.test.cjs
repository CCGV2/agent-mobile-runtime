'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {main} = require('../scripts/setup.cjs');

test('setup help is available without installation, platform checks, or side effects', async () => {
  const fail = () => { throw new Error('Setup must not run.'); };
  const hooks = {platform: 'win32', architecture: 'arm64', nodeVersion: '18.0.0', linuxSetup: fail, existingSetup: fail};
  assert.match(await main([], hooks), /docs\/quickstart.md/);
  assert.match(await main(['--help'], hooks), /--plan/);
});

test('setup routes native platforms and existing SDKs without losing readiness or arguments', async () => {
  for (const [platform, architecture, args, route] of [
    ['linux', 'x64', ['--root', '/private/installation', '--plan'], 'linux'],
    ['linux', 'x64', ['--root', '/private/installation', '--sdk', '/private/sdk', '--plan'], 'existing'],
    ['darwin', 'x64', ['--root', '/private/installation', '--sdk', '/private/sdk', '--plan'], 'existing'],
    ['darwin', 'arm64', ['--root', '/private/installation', '--sdk', '/private/sdk', '--plan'], 'existing'],
  ]) {
    const calls = [];
    const report = {state: 'prepared', prerequisitesReady: false, ready: false, startsEmulator: false};
    const result = await main(args, {platform, architecture, nodeVersion: '22.0.0',
      linuxSetup: async received => { calls.push(['linux', received]); return report; },
      existingSetup: async received => { calls.push(['existing', received]); return report; },
    });
    assert.deepEqual(calls, [[route, args]]);
    assert.equal(result, report);
  }
});

test('setup rejects unsupported hosts and old Node before invoking an installer', async () => {
  const fail = () => { throw new Error('Installer must not be invoked.'); };
  for (const host of [
    {platform: 'linux', architecture: 'arm64', nodeVersion: '22.0.0'},
    {platform: 'win32', architecture: 'x64', nodeVersion: '22.0.0'},
    {platform: 'darwin', architecture: 'x64', nodeVersion: '20.0.0'},
  ]) {
    await assert.rejects(main(['--root', '/private/installation', '--plan'], {...host, linuxSetup: fail, existingSetup: fail}), /supports|Node.js 22/);
  }
});

test('setup preserves failure diagnostics instead of turning failed installation into readiness', async () => {
  const error = new Error('Private installation failed; inspect setup-status.json.');
  await assert.rejects(main(['--root', '/private/installation', '--accept-sdk-licenses'], {
    platform: 'linux', architecture: 'x64', nodeVersion: '22.0.0', linuxSetup: async () => { throw error; },
  }), value => value === error);
});
