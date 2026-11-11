'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {main, parse} = require('../scripts/setup-existing-sdk.cjs');
const {resolveExecutable} = require('../scripts/setup-linux.cjs');
const {loadConfig} = require('../src/config.cjs');
const {Provisioner} = require('../src/provision.cjs');

// These are actual SDK 22 / Android 35 AOSP generator fields, including the
// placeholders that previously prevented new templates from validating.
// Unrelated sensor and display defaults are omitted.
const FRESH_AVD_CONFIG = `PlayStore.enabled=no
abi.type=x86_64
avd.id=<build>
avd.ini.encoding=UTF-8
avd.name=<build>
disk.cachePartition=yes
disk.cachePartition.size=66MB
disk.dataPartition.path=<temp>
disk.dataPartition.size=10G
disk.systemPartition.size=0
disk.vendorPartition.size=0
fastboot.forceChosenSnapshotBoot=no
fastboot.forceFastBoot=yes
firstboot.bootFromDownloadableSnapshot=yes
firstboot.bootFromLocalSnapshot=yes
firstboot.saveToLocalSnapshot=yes
hw.cpu.arch=x86_64
hw.keyboard=no
hw.mainKeys=yes
hw.sdCard=yes
image.sysdir.1=system-images/android-35/default/x86_64/
kernel.newDeviceNaming=autodetect
kernel.supportsYaffs2=autodetect
runtime.network.latency=none
runtime.network.speed=full
sdcard.size=512 MB
tag.display=Default Android System Image
tag.displaynames=Default Android System Image
tag.id=default
tag.ids=default
target=android-35
userdata.useQcow2=no
vm.heapSize=32M
`;

async function fixture(t, {architecture = 'x64', acceleration = true, avdConfig = FRESH_AVD_CONFIG} = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-existing-sdk-')));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const root = path.join(parent, 'private');
  const sdk = path.join(parent, 'SDK with spaces');
  const tools = path.join(parent, 'tools');
  const paths = {
    java: path.join(tools, 'jdk', 'bin', 'java'),
    scrcpy: path.join(tools, 'scrcpy'), ffmpeg: path.join(tools, 'ffmpeg'), ffprobe: path.join(tools, 'ffprobe'),
    adb: path.join(sdk, 'platform-tools', 'adb'), emulator: path.join(sdk, 'emulator', 'emulator'),
    avdmanager: path.join(sdk, 'cmdline-tools', '22.0', 'bin', 'avdmanager'),
  };
  for (const filename of Object.values(paths)) {
    await fs.mkdir(path.dirname(filename), {recursive: true, mode: 0o700});
    await fs.writeFile(filename, 'trusted SDK test executable\n', {mode: 0o700});
  }
  const abi = architecture === 'arm64' ? 'arm64-v8a' : 'x86_64';
  const image = path.join(sdk, 'system-images', 'android-35', 'default', abi);
  await fs.mkdir(image, {recursive: true, mode: 0o700});
  await fs.writeFile(path.join(image, 'source.properties'), 'Pkg.Revision=2\n', {mode: 0o600});
  await fs.writeFile(path.join(image, 'system.img'), 'installed source image\n', {mode: 0o600});
  const calls = [];
  const hooks = {
    platform: 'darwin', architecture, uid: 1234, nodeVersion: '22.23.1',
    resolveExecutable: (filename, names) => resolveExecutable(filename || paths[names[0]], names),
    async execute(file, args, options) {
      calls.push({file, args, options});
      if (file === paths.java) return {stdout: '', stderr: 'openjdk version "17.0.15"'};
      if (file === '/usr/libexec/java_home') return {stdout: path.dirname(path.dirname(paths.java)) + '\n', stderr: ''};
      if (file === paths.avdmanager) {
        const avd = args[args.indexOf('--path') + 1];
        await fs.mkdir(avd, {mode: 0o700});
        await fs.writeFile(path.join(avd, 'config.ini'), avdConfig.replaceAll('x86_64', abi), {mode: 0o600});
        return {stdout: 'Created dedicated AVD\n', stderr: ''};
      }
      if (file === paths.emulator && args.includes('-accel-check') && !acceleration) {
        const error = new Error('Hardware acceleration unavailable'); error.stderr = 'acceleration disabled'; throw error;
      }
      return {stdout: `${path.basename(file)} available\n`, stderr: ''};
    },
  };
  const argv = ['--root', root, '--sdk', sdk, '--java', paths.java];
  return {parent, root, sdk, paths, image, calls, hooks, argv};
}

test('existing-SDK plan/help do not inspect files, run tools or create a directory', async t => {
  const f = await fixture(t);
  const root = path.join(f.parent, 'nonexistent-plan');
  const sdk = path.join(f.parent, 'nonexistent-sdk');
  const result = await main(['--root', root, '--sdk', sdk, '--plan'], {...f.hooks, execute() { throw new Error('Unexpected subprocess'); }});
  assert.equal(result.mode, 'plan');
  assert.equal(result.target, 'darwin-x64');
  assert.deepEqual(result.downloads, []);
  assert.equal(result.startsEmulator, false);
  assert.equal(result.sdkLicensesAccepted, false);
  assert.equal(result.template, 'clean35');
  await assert.rejects(fs.lstat(root), {code: 'ENOENT'});
  assert.match((await main(['--help'])).help, /existing|already installed/);
  assert.equal(f.calls.length, 0);
});

test('existing-SDK setup rejects unknown arguments, duplicate values and ambiguous directories', () => {
  for (const argv of [[], ['--root', '/'], ['--root', 'relative', '--sdk', '/sdk'], ['--root', '/private', '--sdk', '/sdk', '--sdk', '/other'], ['--root', '/private', '--sdk', '/sdk', '--accept-sdk-licenses']]) assert.throws(() => parse(argv));
});

test('unsupported hosts, root and old Node fail before setup can inspect or create SDK paths', async () => {
  const argv = ['--root', '/nonexistent/mobile', '--sdk', '/nonexistent/sdk'];
  for (const hooks of [{platform: 'win32', architecture: 'x64'}, {platform: 'linux', architecture: 'arm64'}, {platform: 'darwin', architecture: 'x64', uid: 0}, {platform: 'darwin', architecture: 'x64', uid: 1234, nodeVersion: '21.7.2'}]) await assert.rejects(main(argv, hooks), /supports|non-root|22 or newer/);
});

test('missing image, dependency and Java 17 are reported before claiming an installation root', async t => {
  const missingImage = await fixture(t);
  await fs.rm(path.join(missingImage.image, 'system.img'));
  await assert.rejects(main(missingImage.argv, missingImage.hooks), /Install system-images;android-35;default;x86_64/);
  await assert.rejects(fs.lstat(missingImage.root), {code: 'ENOENT'});
  const missingTool = await fixture(t);
  await fs.rm(missingTool.paths.scrcpy);
  await assert.rejects(main(missingTool.argv, missingTool.hooks), /Missing required local executable/);
  await assert.rejects(fs.lstat(missingTool.root), {code: 'ENOENT'});
  const oldJava = await fixture(t);
  oldJava.hooks.execute = async () => ({stdout: '', stderr: 'openjdk version "11.0.29"'});
  await assert.rejects(main(oldJava.argv, oldJava.hooks), /Java 17 or newer/);
  await assert.rejects(fs.lstat(oldJava.root), {code: 'ENOENT'});
});

test('new installation and existing SDK directories must be disjoint', async t => {
  const f = await fixture(t);
  await assert.rejects(main(['--root', path.join(f.sdk, 'private'), '--sdk', f.sdk, '--java', f.paths.java], f.hooks), /separate directories/);
  await assert.rejects(fs.lstat(path.join(f.sdk, 'private')), {code: 'ENOENT'});
  assert.equal(f.calls.length, 0);
});

test('avdmanager from another SDK is rejected before writing a private root because its package lookup ignores SDK environment overrides', async t => {
  const f = await fixture(t);
  const other = path.join(f.parent, 'other-SDK', 'cmdline-tools', '22.0', 'bin', 'avdmanager');
  await fs.mkdir(path.dirname(other), {recursive: true, mode: 0o700});
  await fs.writeFile(other, 'other trusted command-line tools', {mode: 0o700});
  await assert.rejects(main([...f.argv, '--avdmanager', other], f.hooks), /avdmanager must belong to the selected SDK/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.lstat(f.root), {code: 'ENOENT'});
  await fs.rm(f.paths.avdmanager);
  await fs.symlink(other, f.paths.avdmanager);
  await assert.rejects(main(f.argv, f.hooks), /SDK-local avdmanager is missing/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.lstat(f.root), {code: 'ENOENT'});
});

test('prepares actual SDK-generator fields into a valid private template without changing the existing SDK or starting a VM', async t => {
  const f = await fixture(t);
  const sourceImage = await fs.readFile(path.join(f.image, 'system.img'));
  const result = await main(f.argv, f.hooks);
  assert.equal(result.state, 'prepared');
  assert.equal(result.ready, false);
  assert.equal(result.prerequisitesReady, true);
  assert.equal(result.startsEmulator, false);
  assert.equal(result.startsService, false);
  assert.equal(result.realEmulatorAcceptance, 'not-run');
  assert.equal(result.webRTCEnabled, false);
  const config = await loadConfig(result.configPath);
  assert.equal(config.sdkRoot, f.sdk);
  assert.equal(config.adbPath, f.paths.adb);
  assert.equal(config.scrcpyPath, f.paths.scrcpy);
  assert.equal(config.dataDir, path.join(f.root, 'data'));
  assert.equal((await fs.stat(result.configPath)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.root)).mode & 0o777, 0o700);
  assert.deepEqual(await fs.readFile(path.join(f.image, 'system.img')), sourceImage);
  assert.deepEqual((await fs.readdir(f.sdk)).sort(), ['cmdline-tools', 'emulator', 'platform-tools', 'system-images']);
  const provisioner = new Provisioner({config});
  await provisioner.validateTemplate('clean35');
  const device = await provisioner.create({id: 'existing-sdk-test', template: 'clean35'});
  const cloned = await fs.readFile(path.join(device.avdDir, 'config.ini'), 'utf8');
  assert.equal(cloned.includes('<temp>'), false);
  assert.equal(cloned.includes('<build>'), false);
  assert.match(cloned, /AvdId=existing-sdk-test/);
  assert.match(cloned, /hw.audioInput=no/);
  assert.match(cloned, /image.sysdir.1=system-images\/android-35\/default\/x86_64\//);
  await provisioner.destroy(device);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'setup-owner.json'), 'utf8')).kind, 'agent-mobile-existing-sdk-setup');
  const create = f.calls.find(call => call.file === f.paths.avdmanager);
  assert.equal(create.options.env.HOME, path.join(f.root, 'home'));
  assert.equal(create.options.env.ANDROID_HOME, f.sdk);
  assert.equal(create.options.env.ANDROID_SDK_ROOT, f.sdk);
  assert.equal(create.options.env.ANDROID_AVD_HOME, path.join(f.root, 'templates'));
  assert.equal(create.options.env.ANDROID_USER_HOME, path.join(f.root, 'android-home'));
  assert.equal(create.options.env.JAVA_TOOL_OPTIONS, `-Duser.home="${path.join(f.root, 'home')}"`);
  for (const name of ['AWS_PROFILE', 'SSH_AUTH_SOCK', 'PULSE_SERVER', 'DBUS_SESSION_BUS_ADDRESS', 'DISPLAY']) assert.equal(create.options.env[name], undefined);
  assert.equal(create.options.input, 'no\n');
  assert.equal(f.calls.filter(call => call.file === f.paths.emulator).every(call => ['-version', '-accel-check'].includes(call.args[0])), true);
  await assert.rejects(main(f.argv, f.hooks), /nonempty setup root/);
});

test('Apple Silicon selects the installed ARM image and clearly retains its unverified device boundary', async t => {
  const f = await fixture(t, {architecture: 'arm64'});
  const result = await main(f.argv, f.hooks);
  assert.equal(result.target, 'darwin-arm64');
  assert.equal(result.realEmulatorAcceptance, 'not-run');
  assert.ok(result.limitations.some(value => value.includes('Apple Silicon')));
  assert.ok(f.calls.find(call => call.file === f.paths.avdmanager).args.includes('system-images;android-35;default;arm64-v8a'));
});

test('macOS finds the actual selected JDK through java_home instead of using the system java shim', async t => {
  const f = await fixture(t);
  const result = await main(['--root', f.root, '--sdk', f.sdk], f.hooks);
  assert.equal(result.dependencies.java, f.paths.java);
  assert.equal(f.calls.some(call => call.file === '/usr/libexec/java_home'), true);
});

test('missing acceleration is prepared but explicitly not ready, preserving diagnostics for repair', async t => {
  const f = await fixture(t, {acceleration: false});
  const result = await main(f.argv, f.hooks);
  assert.equal(result.state, 'prepared');
  assert.equal(result.prerequisitesReady, false);
  assert.equal(result.ready, false);
  assert.equal(result.acceleration, false);
  assert.match(result.accelerationDiagnostic, /acceleration disabled/);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'setup-status.json'), 'utf8')).prerequisitesReady, false);
});

test('existing-SDK Linux preparation still requires actual KVM access before reporting prerequisites ready', async t => {
  const f = await fixture(t);
  f.hooks.platform = 'linux';
  f.hooks.hostFileSystem = {
    async readFile() { return 'flags : vmx\n'; },
    async lstat() { const error = new Error('missing KVM'); error.code = 'ENOENT'; throw error; },
  };
  const result = await main(f.argv, f.hooks);
  assert.equal(result.target, 'linux-x64');
  assert.equal(result.state, 'prepared');
  assert.equal(result.prerequisitesReady, false);
  assert.equal(result.kvm, false);
  assert.equal(result.host.kvm.present, false);
  assert.equal(result.acceleration, true);
});

test('unknown external writable template references still fail strict validation and retain private diagnostics', async t => {
  const f = await fixture(t, {avdConfig: FRESH_AVD_CONFIG + 'disk.dataPartition.initPath=/outside/user-data.img\n'});
  await assert.rejects(main(f.argv, f.hooks), /external writable data/);
  const status = JSON.parse(await fs.readFile(path.join(f.root, 'setup-status.json'), 'utf8'));
  assert.equal(status.state, 'failed');
  assert.equal(status.step, 'validate-template');
  await assert.rejects(fs.lstat(path.join(f.root, 'config.json')), {code: 'ENOENT'});
});

test('existing and symlinked roots or SDK roots are not repurposed', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.root, {mode: 0o700});
  await fs.writeFile(path.join(f.root, 'existing.txt'), 'keep me\n');
  await assert.rejects(main(f.argv, f.hooks), /nonempty setup root/);
  assert.equal(await fs.readFile(path.join(f.root, 'existing.txt'), 'utf8'), 'keep me\n');
  const linked = await fixture(t);
  const destination = path.join(linked.parent, 'owned-target');
  await fs.mkdir(destination, {mode: 0o700});
  await fs.symlink(destination, linked.root);
  await assert.rejects(main(linked.argv, linked.hooks), /not a symlink/);
  assert.deepEqual(await fs.readdir(destination), []);
  const sdkLink = path.join(linked.parent, 'SDK-link');
  await fs.symlink(linked.sdk, sdkLink);
  await assert.rejects(main(['--root', path.join(linked.parent, 'other'), '--sdk', sdkLink, '--java', linked.paths.java], linked.hooks), /not a symlink/);
});
