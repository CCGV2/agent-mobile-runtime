#!/usr/bin/env node
'use strict';

// Prepare only a new private runtime root. The selected SDK is trusted,
// installed operator input; no SDK package or existing AVD is modified.
const fs = require('node:fs/promises');
const path = require('node:path');
const {
  execute, resolveExecutable, claimRoot, privateDirectory, protectTree,
  environment, normalizeAVDConfig,
} = require('./setup-linux.cjs');
const {Provisioner} = require('../src/provision.cjs');
const {doctor} = require('../src/doctor.cjs');

const HELP = `Prepare agent-mobile-runtime from an already installed Android SDK.

  node scripts/setup-existing-sdk.cjs --root /private/new/directory --sdk /absolute/Android/sdk --plan
  node scripts/setup-existing-sdk.cjs --root /private/new/directory --sdk /absolute/Android/sdk [--java /absolute/bin/java] [--avdmanager /absolute/bin/avdmanager]

Requires Node 22+, Java 17+, scrcpy, FFmpeg/ffprobe and installed SDK
platform-tools, emulator, and system-images;android-35;default;<host ABI>.
Creates a new clean35 AVD and config; does not import personal AVDs, install
packages, accept licenses, start a service/emulator or enable WebRTC.
See docs/macos.md and docs/quickstart.md.
`;

function parse(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const option = argv[index];
    if (!['--root', '--sdk', '--java', '--avdmanager', '--plan'].includes(option) || Object.hasOwn(result, option)) throw new Error('Invalid or duplicate existing-SDK setup option.');
    if (option === '--plan') result[option] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--') || !path.isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${option} requires an absolute path.`);
      result[option] = value;
    }
  }
  for (const option of ['--root', '--sdk']) if (!result[option] || path.parse(result[option]).root === result[option]) throw new Error(`${option} must name an absolute directory other than the filesystem root.`);
  return result;
}

function target({platform = process.platform, architecture = process.arch} = {}) {
  const supported = platform === 'darwin' && ['x64', 'arm64'].includes(architecture) || platform === 'linux' && architecture === 'x64';
  return {platform, architecture, supported, abi: architecture === 'arm64' ? 'arm64-v8a' : 'x86_64'};
}

function plan(options, host = target()) {
  const root = path.resolve(options['--root']);
  return {
    schema: 1, mode: 'plan', target: `${host.platform}-${host.architecture}`, supported: host.supported,
    root, sdkRoot: path.resolve(options['--sdk']), downloads: [], sdkLicensesAccepted: false,
    requiresNonRoot: true, requiresKVMForAcceptance: host.platform === 'linux',
    sdkPackages: ['platform-tools', 'emulator', `system-images;android-35;default;${host.abi}`],
    configPath: path.join(root, 'config.json'), template: 'clean35',
    startsService: false, startsEmulator: false, webRTCEnabled: false,
    prerequisites: ['Node 22+', 'Java 17+', 'Installed SDK command-line tools / avdmanager', 'scrcpy', 'FFmpeg/ffprobe', 'Installed Android 35 default image matching the host ABI', 'Working emulator hardware acceleration'],
    realEmulatorAcceptance: 'not-run',
    limitations: ['Preparation does not prove device boot or audible media.', ...(host.platform === 'darwin' && host.architecture === 'arm64' ? ['Apple Silicon device and media acceptance have not been performed.'] : [])],
  };
}

function sdkEnvironment(root, sdk, java, platform) {
  return {
    ...environment(root, java, process.execPath),
    ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk,
    ...(platform === 'darwin' ? {LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8'} : {}),
  };
}

function sameOrInside(parent, directory) {
  const relative = path.relative(parent, directory);
  return !relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function findAVDManager(sdk, explicit, resolve) {
  const validate = filename => {
    // avdmanager 22 locates packages relative to its own SDK installation;
    // ANDROID_HOME/ANDROID_SDK_ROOT do not redirect it to a different SDK.
    const parts = path.relative(path.join(sdk, 'cmdline-tools'), filename).split(path.sep);
    if (parts.length !== 3 || !/^(?:latest|\d+(?:\.\d+)*)$/.test(parts[0]) || parts[1] !== 'bin' || parts[2] !== 'avdmanager') throw new Error('avdmanager must belong to the selected SDK. Install cmdline-tools;22.0 into that SDK using sdkmanager --sdk_root=SELECTED_SDK --install "cmdline-tools;22.0", then use its cmdline-tools/22.0/bin/avdmanager.');
    return filename;
  };
  if (explicit) return validate(await resolve(explicit, ['avdmanager']));
  const directory = path.join(sdk, 'cmdline-tools');
  let versions = [];
  try { versions = (await fs.readdir(directory)).filter(name => /^\d+(?:\.\d+)*$/.test(name)).sort((a, b) => b.localeCompare(a, undefined, {numeric: true})); } catch {}
  for (const version of ['latest', ...versions]) {
    try { return validate(await resolve(path.join(directory, version, 'bin', 'avdmanager'), ['avdmanager'])); } catch {}
  }
  throw new Error('SDK-local avdmanager is missing. Install cmdline-tools;22.0 into the selected SDK using sdkmanager --sdk_root=SELECTED_SDK --install "cmdline-tools;22.0". An avdmanager from another SDK cannot select these images.');
}

async function findJava(explicit, platform, run, resolve) {
  if (explicit) return resolve(explicit, ['java']);
  if (platform === 'darwin') {
    try {
      const {stdout} = await run('/usr/libexec/java_home', [], {env: {PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8'}, timeoutMs: 10000});
      const javaHome = stdout.trim();
      if (path.isAbsolute(javaHome) && !/[\x00-\x1f\x7f]/.test(javaHome)) return await resolve(path.join(javaHome, 'bin', 'java'), ['java']);
    } catch { /* A CLI-installed JDK may instead be available on PATH. */ }
  }
  return resolve(undefined, ['java']);
}

async function installedSDK(sdkPath, host, resolve, explicitAVDManager) {
  const info = await fs.lstat(sdkPath);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('--sdk must name an existing SDK directory, not a symlink.');
  const sdk = await fs.realpath(sdkPath);
  const adb = await resolve(path.join(sdk, 'platform-tools', 'adb'), ['adb']);
  const emulator = await resolve(path.join(sdk, 'emulator', 'emulator'), ['emulator']);
  const image = path.join(sdk, 'system-images', 'android-35', 'default', host.abi);
  for (const file of ['source.properties', 'system.img']) {
    let stat;
    try { stat = await fs.lstat(path.join(image, file)); } catch { throw new Error(`Install system-images;android-35;default;${host.abi} into the selected SDK before setup.`); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Installed system image must contain regular SDK files.');
  }
  return {sdk, adb, emulator, avdmanager: await findAVDManager(sdk, explicitAVDManager, resolve)};
}

async function main(argv = process.argv.slice(2), hooks = {}) {
  if (argv.length === 1 && ['--help', 'help', '-h'].includes(argv[0])) return {help: HELP};
  const options = parse(argv);
  const host = target(hooks);
  if (options['--plan']) return plan(options, host);
  if (!host.supported) throw new Error('Existing-SDK preparation supports macOS x64/arm64 and Linux x64 only.');
  if (Number((hooks.nodeVersion || process.versions.node).split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  if ((hooks.uid ?? process.getuid?.()) === 0) throw new Error('Run setup as the intended non-root service user.');
  const run = hooks.execute || execute;
  const resolve = hooks.resolveExecutable || resolveExecutable;
  const sdk = await installedSDK(options['--sdk'], host, resolve, options['--avdmanager']);
  const rootPath = path.resolve(options['--root']);
  if (sameOrInside(sdk.sdk, rootPath) || sameOrInside(rootPath, sdk.sdk)) throw new Error('The new private runtime root and existing SDK must be separate directories.');
  const java = await findJava(options['--java'], host.platform, run, resolve);
  const dependencies = {};
  for (const name of ['scrcpy', 'ffmpeg', 'ffprobe']) dependencies[name] = await resolve(undefined, [name]);
  const preliminary = sdkEnvironment(rootPath, sdk.sdk, java, host.platform);
  const version = await run(java, ['-version'], {env: preliminary, timeoutMs: 10000});
  const javaVersion = /(?:^|\r?\n)(?:java|openjdk)\s+(?:version\s+)?"?(\d+)(?:\.(\d+))?/.exec(version.stderr || version.stdout || '');
  if (!javaVersion || Number(javaVersion[1]) < 17) throw new Error('Java 17 or newer is required. Select its actual bin/java using --java.');
  const root = await claimRoot(rootPath, 'agent-mobile-existing-sdk-setup');
  const env = sdkEnvironment(root, sdk.sdk, java, host.platform);
  let step = 'directories';
  try {
    for (const name of ['home', 'tmp', 'android-home', 'templates', 'emulator-home', 'data', 'runtime', 'cache', 'config-home', 'user-data']) await privateDirectory(path.join(root, name));
    const statusFile = path.join(root, 'setup-status.json');
    await fs.writeFile(statusFile, JSON.stringify({schema: 1, state: 'installing', startsService: false, startsEmulator: false}) + '\n', {mode: 0o600, flag: 'wx'});
    step = 'clean-template';
    const avd = path.join(root, 'templates', 'clean35.avd');
    await run(sdk.avdmanager, ['create', 'avd', '--name', 'agent-mobile-clean35', '--package', `system-images;android-35;default;${host.abi}`, '--path', avd], {env, input: 'no\n', timeoutMs: 120000});
    const avdConfig = path.join(avd, 'config.ini');
    const stat = await fs.lstat(avdConfig);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid fresh AVD configuration.');
    await fs.writeFile(avdConfig, normalizeAVDConfig(await fs.readFile(avdConfig, 'utf8')), {mode: 0o600});
    await fs.chmod(avdConfig, 0o600);
    const config = {
      dataDir: path.join(root, 'data'), sdkRoot: sdk.sdk, adbPath: sdk.adb, emulatorPath: sdk.emulator,
      scrcpyPath: dependencies.scrcpy, ffmpegPath: dependencies.ffmpeg, ffprobePath: dependencies.ffprobe,
      headless: true, maxDevices: 1, controlPort: 7341, adbServerPort: 5038, emulatorPortStart: 5554,
      bootTimeoutMs: 600000, stopTimeoutMs: 60000, templates: {clean35: {avdDir: avd}}, webrtc: {enabled: false},
    };
    step = 'validate-template';
    const provisioner = new Provisioner({config});
    await provisioner.validateTemplate('clean35');
    const configPath = path.join(root, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    step = 'host-checks';
    const report = await doctor(config, provisioner, {
      platform: host.platform, architecture: host.architecture,
      ...(hooks.hostFileSystem ? {hostFileSystem: hooks.hostFileSystem} : {}),
      execute: (file, args, options = {}) => run(file, args, {env, timeoutMs: options.timeout || 10000}),
    });
    const checks = Object.fromEntries(report.checks.map(({name, ...check}) => [name, check]));
    try {
      const output = await run(dependencies.ffmpeg, ['-version'], {env, timeoutMs: 10000});
      checks.ffmpeg = {ok: true, version: String(output.stdout || output.stderr).split(/\r?\n/).find(Boolean)?.slice(0, 160)};
    } catch { checks.ffmpeg = {ok: false}; }
    const result = {
      schema: 1, state: 'prepared', ready: false, prerequisitesReady: report.ready && checks.ffmpeg.ok,
      target: `${host.platform}-${host.architecture}`, configPath, sdkRoot: sdk.sdk, template: 'clean35',
      source: 'existing-sdk', downloads: [], sdkLicensesAccepted: false,
      ...(report.linux ? {host: report.linux, kvm: report.linux.ok} : {}),
      acceleration: report.acceleration.ok, accelerationDiagnostic: report.acceleration.diagnostic,
      dependencies: {...dependencies, java, avdmanager: sdk.avdmanager}, checks,
      webRTCEnabled: false, startsService: false, startsEmulator: false, realEmulatorAcceptance: 'not-run',
      limitations: plan(options, host).limitations,
      next: 'Run doctor with configPath, then start the service and perform disposable device/media acceptance. Keep the existing SDK in place.',
    };
    await protectTree(root, {root, withWebRTC: false});
    await fs.writeFile(statusFile, JSON.stringify(result, null, 2) + '\n', {mode: 0o600});
    return result;
  } catch (error) {
    await fs.writeFile(path.join(root, 'setup-status.json'), JSON.stringify({schema: 1, state: 'failed', step, ready: false, message: error.message, diagnostics: error.diagnostics}, null, 2) + '\n', {mode: 0o600}).catch(() => {});
    throw error;
  }
}

if (require.main === module) main().then(result => process.stdout.write(result.help || JSON.stringify(result, null, 2) + '\n')).catch(error => {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
});

module.exports = {main, parse, plan, target, sdkEnvironment, HELP};
