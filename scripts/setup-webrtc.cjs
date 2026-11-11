#!/usr/bin/env node
'use strict';

// Explicit operator setup: no downloads or Python installs happen on serve/open.
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {createHash, randomUUID} = require('node:crypto');
const {loadConfig} = require('../src/config.cjs');
const execute = promisify(execFile);
const digest = value => createHash('sha256').update(value).digest('hex');

function parse(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === '--skip-install') { values.skipInstall = true; continue; }
    if (!['--config', '--python', '--sdk', '--output'].includes(key) || !argv[i+1] || Object.hasOwn(values, key.slice(2))) throw new Error('Invalid setup options.');
    values[key.slice(2)] = argv[++i];
  }
  return values;
}

async function directory(filename) {
  await fs.mkdir(filename, {recursive: true, mode: 0o700});
  const info = await fs.lstat(filename);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Setup directories must not be symlinks.');
  await fs.chmod(filename, 0o700);
  return fs.realpath(filename);
}

async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  const config = await loadConfig(options.config);
  const sdk = options.sdk || config.sdkRoot;
  const output = options.output || path.join(config.dataDir, 'webrtc');
  if (!path.isAbsolute(sdk) || !path.isAbsolute(output)) throw new Error('SDK and output must be absolute paths.');
  const sourceDir = path.join(sdk, 'emulator', 'lib');
  const source = path.join(sourceDir, 'emulator_controller.proto');
  const info = await fs.lstat(source);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4*1024*1024) throw new Error('SDK emulator_controller.proto is missing or invalid.');
  const root = await directory(output);
  const marker = path.join(root, 'setup-owner.json');
  let owns = false;
  try {
    const old = JSON.parse(await fs.readFile(marker, 'utf8'));
    owns = old.schema === 1 && old.kind === 'agent-mobile-webrtc';
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!owns) {
    if ((await fs.readdir(root)).length) throw new Error('Refusing to modify a nonempty unowned output directory.');
    await fs.writeFile(marker, JSON.stringify({schema: 1, kind: 'agent-mobile-webrtc'})+'\n', {flag: 'wx', mode: 0o600});
  }
  let python = options.python || 'python3.12';
  const run = (file, args, timeout=120000) => execute(file, args, {timeout, maxBuffer: 16*1024*1024, shell: false, windowsHide: true});
  const version = JSON.parse((await run(python, ['-c', 'import json,sys; print(json.dumps({"version":list(sys.version_info[:2]),"path":sys.executable}))'])).stdout);
  if (version.version[0] !== 3 || version.version[1] < 11 || version.version[1] > 14) throw new Error('Use Python 3.11–3.14; Python 3.12 is recommended.');
  python = version.path;
  if (!options.skipInstall) {
    process.stderr.write('Creating a private Python environment and installing pinned media dependencies…\n');
    const venv = path.join(root, 'venv');
    try { const value = await fs.lstat(venv); if (value.isSymbolicLink() || !value.isDirectory()) throw new Error('Invalid virtual environment.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await run(python, ['-m', 'venv', venv]);
    python = path.join(venv, 'bin', 'python');
    await run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '--only-binary=:all:', '--requirement', path.join(__dirname, '..', 'webrtc', 'requirements.lock')], 600000);
  }
  const include = (await run(python, ['-c', 'import os,grpc_tools; print(os.path.join(os.path.dirname(grpc_tools.__file__),"_proto"))'])).stdout.trim();
  if (!path.isAbsolute(include)) throw new Error('Cannot resolve protobuf compiler include directory.');
  const temporary = path.join(root, `proto-${randomUUID()}.tmp`);
  await fs.mkdir(temporary, {mode: 0o700});
  try {
    await run(python, ['-m', 'grpc_tools.protoc', `-I${sourceDir}`, `-I${include}`, `--python_out=${temporary}`, `--grpc_python_out=${temporary}`, source]);
    const generated = {};
    for (const name of ['emulator_controller_pb2.py', 'emulator_controller_pb2_grpc.py']) {
      const filename = path.join(temporary, name);
      generated[name] = digest(await fs.readFile(filename));
      await fs.chmod(filename, 0o600);
    }
    await fs.writeFile(path.join(temporary, 'manifest.json'), JSON.stringify({schema: 1, source: 'Android SDK/emulator/lib/emulator_controller.proto', sourceSha256: digest(await fs.readFile(source)), generated}, null, 2)+'\n', {mode: 0o600});
    const destination = path.join(root, 'proto');
    try {
      const value = await fs.lstat(destination);
      if (!value.isDirectory() || value.isSymbolicLink()) throw new Error('Invalid generated protobuf directory.');
      const prior = JSON.parse(await fs.readFile(path.join(destination, 'manifest.json'), 'utf8'));
      if (prior.schema !== 1 || !prior.generated?.['emulator_controller_pb2.py']) throw new Error('Generated protobuf directory is not owned.');
      await fs.rm(destination, {recursive: true});
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(temporary, destination);
    process.stdout.write(JSON.stringify({pythonPath: python, protoDir: destination, sourceSha256: digest(await fs.readFile(source))}, null, 2)+'\n');
  } finally { await fs.rm(temporary, {recursive: true, force: true}); }
}

if (require.main === module) main().catch(() => {
  process.stderr.write('WebRTC setup failed. Check the installed SDK proto, Python version, dependencies and private output directory. No credentials were printed.\n');
  process.exitCode = 1;
});

module.exports = {main, parse};
