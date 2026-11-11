'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createHash} = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {main, parse, validateDownloadURL, environment, normalizeAVDConfig, EXTRACT, MANIFEST} = require('../scripts/setup-linux.cjs');
const {Provisioner} = require('../src/provision.cjs');
const run = promisify(execFile);
const hash = value => createHash('sha256').update(value).digest('hex');
// Captured from real command-line tools 22 / Android 35 AOSP x86_64 preparation.
// Keep the full generated configuration so SDK placeholders cannot disappear
// behind a minimal test double again.
const REAL_AVD_CONFIG = `PlayStore.enabled=no
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
environment.height=0
environment.width=0
fastboot.forceChosenSnapshotBoot=no
fastboot.forceFastBoot=yes
firstboot.bootFromDownloadableSnapshot=yes
firstboot.bootFromLocalSnapshot=yes
firstboot.saveToLocalSnapshot=yes
hw.accelerometer=yes
hw.accelerometer_uncalibrated=yes
hw.arc=false
hw.battery=yes
hw.camera.back.orientation=90
hw.camera.front.orientation=90
hw.cpu.arch=x86_64
hw.dPad=yes
hw.display1.density=0
hw.display1.flag=0
hw.display1.height=0
hw.display1.width=0
hw.display1.xOffset=-1
hw.display1.yOffset=-1
hw.display2.density=0
hw.display2.flag=0
hw.display2.height=0
hw.display2.width=0
hw.display2.xOffset=-1
hw.display2.yOffset=-1
hw.display3.density=0
hw.display3.flag=0
hw.display3.height=0
hw.display3.width=0
hw.display3.xOffset=-1
hw.display3.yOffset=-1
hw.displayRegion.0.1.height=0
hw.displayRegion.0.1.width=0
hw.displayRegion.0.1.xOffset=-1
hw.displayRegion.0.1.yOffset=-1
hw.displayRegion.0.2.height=0
hw.displayRegion.0.2.width=0
hw.displayRegion.0.2.xOffset=-1
hw.displayRegion.0.2.yOffset=-1
hw.displayRegion.0.3.height=0
hw.displayRegion.0.3.width=0
hw.displayRegion.0.3.xOffset=-1
hw.displayRegion.0.3.yOffset=-1
hw.gltransport=pipe
hw.gltransport.asg.dataRingSize=32768
hw.gltransport.asg.writeBufferSize=1048576
hw.gltransport.asg.writeStepSize=4096
hw.gltransport.drawFlushInterval=800
hw.gps=yes
hw.gsmModem=yes
hw.gyroscope=yes
hw.hotplug_multi_display=no
hw.initialOrientation=portrait
hw.keyboard=no
hw.keyboard.charmap=qwerty2
hw.keyboard.lid=yes
hw.lcd.backlight=yes
hw.lcd.circular=false
hw.lcd.depth=32
hw.lcd.transparent=false
hw.lcd.vsync=60
hw.mainKeys=yes
hw.multi_display_window=no
hw.rotaryInput=no
hw.screen=multi-touch
hw.sdCard=yes
hw.sensor.hinge=no
hw.sensor.hinge.count=0
hw.sensor.hinge.fold_to_displayRegion.0.1_at_posture=1
hw.sensor.hinge.resizable.config=1
hw.sensor.hinge.sub_type=0
hw.sensor.hinge.type=0
hw.sensor.roll=no
hw.sensor.roll.count=0
hw.sensor.roll.resize_to_displayRegion.0.1_at_posture=6
hw.sensor.roll.resize_to_displayRegion.0.2_at_posture=6
hw.sensor.roll.resize_to_displayRegion.0.3_at_posture=6
hw.sensors.gyroscope_uncalibrated=yes
hw.sensors.heading=no
hw.sensors.heart_rate=no
hw.sensors.humidity=yes
hw.sensors.light=yes
hw.sensors.magnetic_field=yes
hw.sensors.magnetic_field_uncalibrated=yes
hw.sensors.orientation=yes
hw.sensors.pressure=yes
hw.sensors.proximity=yes
hw.sensors.rgbclight=no
hw.sensors.temperature=yes
hw.sensors.wrist_tilt=no
hw.touchpad0=no
hw.touchpad0.height=400
hw.touchpad0.width=600
hw.trackBall=yes
hw.useext4=yes
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
test.delayAdbTillBootComplete=0
test.monitorAdb=0
test.quitAfterBootTimeOut=-1
userdata.useQcow2=no
vm.heapSize=32M
hw.lcd.width=720
hw.lcd.height=1280
hw.lcd.density=320
hw.ramSize=2048
hw.cpu.ncore=2
hw.gpu.enabled=yes
hw.gpu.mode=software
hw.camera.back=none
hw.camera.front=none
hw.audioInput=no
hw.audioOutput=yes
showDeviceFrame=no
fastboot.forceColdBoot=yes\n`;


async function fixture(t, {kvm = false, acceleration = false} = {}) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-linux-setup-')));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const root = path.join(parent, 'owned');
  const java = path.join(parent, 'java');
  const python = path.join(parent, 'python');
  await fs.writeFile(java, 'test executable', {mode: 0o700});
  await fs.writeFile(python, 'test executable', {mode: 0o700});
  const content = {command: Buffer.from('verified-command-archive'), scrcpy: Buffer.from('verified-scrcpy-archive')};
  const manifest = {...MANIFEST, commandLineTools: {...MANIFEST.commandLineTools, sha256: hash(content.command)}, scrcpy: {...MANIFEST.scrcpy, sha256: hash(content.scrcpy)}};
  const calls = [];
  const revisions = {'platform-tools': '37.0.1', emulator: '37.2.13', 'platforms;android-35': '2', 'build-tools;35.0.0': '35.0.0', 'system-images;android-35;default;x86_64': '2'};
  const hooks = {
    platform: 'linux', architecture: 'x64', uid: 1234, manifest,
    kvmAvailable: async () => kvm,
    async download(spec, filename) {
      calls.push({download: spec.url});
      await fs.writeFile(filename, spec.url === manifest.commandLineTools.url ? content.command : spec.url === manifest.scrcpy.url ? content.scrcpy : '<repository/>', {flag: 'wx', mode: 0o600});
    },
    async extract(archive, destination) {
      calls.push({extract: path.basename(archive)});
      const base = path.basename(archive).startsWith('command-') ? path.join(destination, 'cmdline-tools', 'bin') : path.join(destination, 'scrcpy-linux-x86_64-v5.0.1');
      await fs.mkdir(base, {recursive: true, mode: 0o700});
      for (const name of base.endsWith('bin') ? ['sdkmanager', 'avdmanager'] : ['scrcpy', 'scrcpy-server']) await fs.writeFile(path.join(base, name), 'test', {mode: 0o700});
    },
    async execute(file, args, options) {
      calls.push({file, args, options});
      if (file === java) return {stdout: '', stderr: 'openjdk version "17.0.15"'};
      if (file === python && args[1]?.includes('sys.version_info')) return {stdout: '[3,12]', stderr: ''};
      if (args.includes('--install')) {
        for (const [name, revision] of Object.entries(revisions)) {
          const directory = path.join(root, 'sdk', ...name.split(';'));
          await fs.mkdir(directory, {recursive: true, mode: 0o700});
          await fs.writeFile(path.join(directory, 'source.properties'), `Pkg.Revision=${revision}\n`, {mode: 0o600});
        }
      }
      if (args[1]?.includes("findall('.//remotePackage')")) return {stdout: JSON.stringify(Object.entries(revisions).map(([name, revision]) => ({path: name, revision: revision.split('.').concat(['0', '0']).slice(0, 3).join('.'), url: 'https://dl.google.com/android/repository/test.zip', checksum: 'a'.repeat(40), checksumType: 'sha1'}))), stderr: ''};
      if (path.basename(file) === 'avdmanager') {
        const directory = args[args.indexOf('--path') + 1];
        await fs.mkdir(directory, {recursive: true, mode: 0o700});
        await fs.writeFile(path.join(directory, 'config.ini'), REAL_AVD_CONFIG, {mode: 0o600});
      }
      if (args.some(value => value.endsWith?.('setup-webrtc.cjs'))) {
        const venv = path.join(root, 'webrtc', 'venv');
        await fs.mkdir(path.join(venv, 'bin'), {recursive: true, mode: 0o700});
        await fs.mkdir(path.join(venv, 'lib'), {mode: 0o700});
        await fs.symlink('lib', path.join(venv, 'lib64'));
        await fs.symlink(python, path.join(venv, 'bin', 'python'));
        await fs.symlink('python', path.join(venv, 'bin', 'python3'));
        await fs.symlink('python', path.join(venv, 'bin', 'python3.12'));
      }
      if (args.includes('-accel-check') && !acceleration) throw new Error('no KVM');
      return {stdout: '', stderr: ''};
    },
  };
  const argv = ['--root', root, '--java', java, '--python', python, '--accept-sdk-licenses'];
  return {parent, root, java, python, argv, hooks, calls, content};
}

test('plan is cross-platform, performs no writes or subprocesses, and keeps media disabled', async t => {
  const f = await fixture(t);
  const result = await main(['--root', f.root, '--plan', '--with-webrtc'], {platform: 'darwin', uid: 0, execute() { throw new Error('must not execute'); }});
  assert.equal(result.mode, 'plan'); assert.equal(result.webRTCEnabled, false);
  assert.equal(result.requiresKVMForAcceptance, true); assert.equal(result.startsService, false);
  await assert.rejects(fs.stat(f.root), {code: 'ENOENT'});
});

test('apply requires Linux x86_64, non-root and explicit SDK license authorization before writing', async t => {
  const f = await fixture(t);
  for (const hooks of [{...f.hooks, platform: 'darwin'}, {...f.hooks, architecture: 'arm64'}, {...f.hooks, uid: 0}]) await assert.rejects(main(f.argv, hooks));
  await assert.rejects(main(f.argv.filter(value => value !== '--accept-sdk-licenses'), f.hooks), /explicit --accept-sdk-licenses/);
  assert.equal(f.calls.length, 0);
  await assert.rejects(fs.stat(f.root), {code: 'ENOENT'});
});

test('rejects duplicate, incomplete and path-based setup options', () => {
  for (const argv of [[], ['--root', 'relative'], ['--root', '/'], ['--root', '/tmp/setup', '--root', '/other'], ['--root', '/tmp/setup', '--python', 'python'], ['--root', '/tmp/setup', '--url', 'https://attacker.example'], ['--root']]) assert.throws(() => parse(argv));
});

test('all downloads require pinned HTTPS hosts and reject credentials, alternate ports and downgrades', async t => {
  for (const url of ['http://dl.google.com/archive', 'https://attacker.example/sdk.zip', 'https://github.com:444/path', 'https://user:password@github.com/path', 'file:///host/private']) assert.throws(() => validateDownloadURL(url));
  assert.equal(validateDownloadURL(MANIFEST.commandLineTools.url).hostname, 'dl.google.com');
  assert.equal(validateDownloadURL('https://release-assets.githubusercontent.com/download?signature=temporary').hostname, 'release-assets.githubusercontent.com');
  const f = await fixture(t);
  await assert.rejects(main(f.argv, {...f.hooks, manifest: {...f.hooks.manifest, commandLineTools: {...f.hooks.manifest.commandLineTools, url: 'https://attacker.example/sdk.zip'}}}), /destination denied/);
  assert.equal(f.calls.length, 0);
});

test('rejects unowned nonempty roots, symlinks and existing config/service state without changing them', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.root, {mode: 0o700});
  const sentinel = path.join(f.root, 'config.json');
  await fs.writeFile(sentinel, 'existing-user-config', {mode: 0o600});
  await assert.rejects(main(f.argv, f.hooks), /nonempty/);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'existing-user-config');
  await fs.rm(sentinel); await fs.mkdir(path.join(f.root, 'data')); await fs.writeFile(path.join(f.root, 'data', 'service.lock'), 'existing-service');
  await assert.rejects(main(f.argv, f.hooks), /nonempty/);
  const linked = path.join(f.parent, 'linked'); await fs.symlink(f.root, linked);
  await assert.rejects(main(f.argv.map(value => value === f.root ? linked : value), f.hooks), /symlink/);
  assert.equal(f.calls.some(call => call.download), false);
});

test('a hash mismatch fails before archive execution and leaves private diagnostic state', async t => {
  const f = await fixture(t);
  const manifest = {...f.hooks.manifest, commandLineTools: {...f.hooks.manifest.commandLineTools, sha256: '0'.repeat(64)}};
  await assert.rejects(main(f.argv, {...f.hooks, manifest}), /SHA-256 mismatch/);
  assert.equal(f.calls.some(call => call.extract), false);
  const result = JSON.parse(await fs.readFile(path.join(f.root, 'setup-status.json'), 'utf8'));
  assert.equal(result.state, 'failed'); assert.equal(result.ready, false);
  assert.equal((await fs.stat(path.join(f.root, 'setup-status.json'))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.root)).mode & 0o777, 0o700);
});

test('prepares a dedicated SDK and clean template but cannot claim runtime readiness without KVM acceptance', async t => {
  const f = await fixture(t);
  const result = await main(f.argv, f.hooks);
  assert.equal(result.state, 'prepared'); assert.equal(result.ready, false);
  assert.equal(result.kvm, false); assert.equal(result.acceleration, false);
  assert.equal(result.startsEmulator, false); assert.equal(result.realEmulatorAcceptance, 'not-run');
  const config = JSON.parse(await fs.readFile(result.configPath, 'utf8'));
  assert.equal(config.webrtc.enabled, false); assert.equal(config.headless, true);
  assert.equal(config.dataDir, path.join(f.root, 'data'));
  assert.equal(config.sdkRoot, path.join(f.root, 'sdk'));
  const avd = await fs.readFile(path.join(config.templates.clean35.avdDir, 'config.ini'), 'utf8');
  assert.match(avd, /hw.camera.back=none/); assert.match(avd, /hw.audioInput=no/); assert.match(avd, /hw.audioOutput=yes/); assert.match(avd, /hw.gpu.mode=software/);
  assert.equal(avd.includes('webcam0'), false);
  assert.equal(avd.includes('disk.dataPartition.path=<temp>'), false);
  assert.equal(avd.includes('avd.id=<build>'), false); assert.equal(avd.includes('avd.name=<build>'), false);
  const provisioner = new Provisioner({config});
  await provisioner.validateTemplate('clean35');
  const device = await provisioner.create({id: 'prepared-test', template: 'clean35'});
  const cloned = await fs.readFile(path.join(device.avdDir, 'config.ini'), 'utf8');
  assert.match(cloned, /AvdId=prepared-test\n/);
  assert.equal(cloned.includes('disk.dataPartition.path='), false, 'Emulator must create default data inside the private clone');
  await provisioner.destroy(device);
  const create = f.calls.find(call => call.args?.includes('avd'));
  assert.ok(create); assert.equal(create.args.includes('--force'), false);
  assert.equal(f.calls.some(call => call.args?.includes('-avd')), false);
  const provenance = JSON.parse(await fs.readFile(path.join(f.root, 'install-manifest.json'), 'utf8'));
  assert.equal(provenance.sdkPackages.length, MANIFEST.sdkPackages.length);
  assert.equal(provenance.sdkPackages[0].checksumType, 'sha1');
  assert.equal((await fs.stat(result.configPath)).mode & 0o777, 0o600);
});

test('normalizes only the observed SDK placeholders and validates all other writable references before preparation succeeds', async t => {
  const normalized = normalizeAVDConfig('disk.dataPartition.path=<temp>\navd.id=<build>\navd.name=<build>\ncustom.path=<temp>\n');
  assert.equal(normalized.includes('disk.dataPartition.path='), false);
  assert.equal(normalized.includes('avd.id='), false); assert.equal(normalized.includes('avd.name='), false);
  assert.ok(normalized.includes('custom.path=<temp>\n'));
  for (const reference of ['/home/operator/private.img', '../private.img', '<unknown>']) {
    const f = await fixture(t);
    const execute = f.hooks.execute;
    await assert.rejects(main(f.argv, {...f.hooks, async execute(file, args, options) {
      const result = await execute(file, args, options);
      if (path.basename(file) === 'avdmanager') {
        const filename = path.join(f.root, 'templates', 'clean35.avd', 'config.ini');
        await fs.writeFile(filename, REAL_AVD_CONFIG.replace('disk.dataPartition.path=<temp>', `disk.dataPartition.path=${reference}`));
      }
      return result;
    }}), /external writable|ENOENT/);
    const status = JSON.parse(await fs.readFile(path.join(f.root, 'setup-status.json'), 'utf8'));
    assert.equal(status.state, 'failed'); assert.equal(status.step, 'validate-template');
    await assert.rejects(fs.stat(path.join(f.root, 'config.json')), {code: 'ENOENT'});
  }
});

test('SDK commands receive a private environment without host credentials or desktop/audio session access', async t => {
  const f = await fixture(t);
  await main(f.argv, f.hooks);
  for (const call of f.calls.filter(call => call.file)) {
    const env = call.options.env;
    assert.equal(env.HOME, path.join(f.root, 'home'));
    assert.equal(env.JAVA_TOOL_OPTIONS, `-Duser.home="${path.join(f.root, 'home')}"`);
    for (const key of ['AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK', 'DISPLAY', 'WAYLAND_DISPLAY', 'PULSE_SERVER', 'DBUS_SESSION_BUS_ADDRESS', 'LD_PRELOAD', 'NODE_OPTIONS', 'ANDROID_SERIAL']) assert.equal(env[key], undefined);
  }
  const env = environment(f.root, f.java, f.python);
  assert.equal(env.ANDROID_AVD_HOME, path.join(f.root, 'templates'));
  assert.equal(env.XDG_RUNTIME_DIR, path.join(f.root, 'runtime'));
});

test('creates missing private parents but refuses symlinked or shared-writable parents', async t => {
  const f = await fixture(t);
  const nested = path.join(f.parent, 'missing', 'parents', 'owned');
  const badDigest = {...f.hooks.manifest, commandLineTools: {...f.hooks.manifest.commandLineTools, sha256: '0'.repeat(64)}};
  await assert.rejects(main(f.argv.map(value => value === f.root ? nested : value), {...f.hooks, manifest: badDigest}), /SHA-256/);
  assert.equal((await fs.stat(path.dirname(nested))).mode & 0o777, 0o700);
  const link = path.join(f.parent, 'parent-link'); await fs.symlink(path.dirname(nested), link);
  await assert.rejects(main(f.argv.map(value => value === f.root ? path.join(link, 'new') : value), f.hooks), /parent directories/);
  const shared = path.join(f.parent, 'shared'); await fs.mkdir(shared, {mode: 0o777}); await fs.chmod(shared, 0o777);
  await assert.rejects(main(f.argv.map(value => value === f.root ? path.join(shared, 'new') : value), f.hooks), /parent directories/);
});

test('optional WebRTC preparation never enables the listener or starts a process service', async t => {
  const f = await fixture(t, {kvm: true, acceleration: true});
  await fs.chmod(f.python, 0o755);
  await main([...f.argv, '--with-webrtc'], f.hooks);
  const call = f.calls.find(call => call.args?.some(value => value.endsWith?.('setup-webrtc.cjs')));
  assert.ok(call); assert.ok(call.args.includes('--python'));
  const config = JSON.parse(await fs.readFile(path.join(f.root, 'config.json'), 'utf8'));
  assert.equal(config.webrtc.enabled, false);
  assert.equal(config.webrtc.protoDir, path.join(f.root, 'webrtc', 'proto'));
  assert.equal((await fs.stat(f.python)).mode & 0o777, 0o755, 'Never chmod a trusted external interpreter through its venv link');
  assert.equal(await fs.realpath(config.webrtc.pythonPath), f.python);
});

test('venv may not link to arbitrary external executables or global site-packages', async t => {
  const f = await fixture(t);
  const execute = f.hooks.execute;
  const outside = path.join(f.parent, 'unrelated'); await fs.writeFile(outside, 'private', {mode: 0o644});
  await assert.rejects(main([...f.argv, '--with-webrtc'], {...f.hooks, async execute(file, args, options) {
    const result = await execute(file, args, options);
    if (args.some(value => value.endsWith?.('setup-webrtc.cjs'))) await fs.symlink(outside, path.join(f.root, 'webrtc', 'venv', 'lib', 'escape'));
    return result;
  }}), /escapes its managed boundary/);
  assert.equal((await fs.stat(outside)).mode & 0o777, 0o644);
});

test('safe extraction refuses traversal, symlinks and ambiguous archive names before touching outside staging', async t => {
  let python;
  for (const candidate of ['/usr/local/bin/python3.12', '/usr/bin/python3']) {
    try { await fs.access(candidate); python = candidate; break; } catch {}
  }
  if (!python) { t.skip('Python required for extraction verification'); return; }
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-linux-archive-')));
  t.after(() => fs.rm(parent, {recursive: true, force: true}));
  const zip = path.join(parent, 'bad.zip');
  for (const [index, name] of ['../outside', '/absolute', 'directory/../../outside', 'back\\slash', 'duplicate'].entries()) {
    await run(python, ['-c', 'import zipfile,sys;z=zipfile.ZipFile(sys.argv[1],"w");z.writestr(sys.argv[2],"payload");z.writestr(sys.argv[2],"again") if sys.argv[2]=="duplicate" else None;z.close()', zip, name]);
    await assert.rejects(run(python, ['-c', EXTRACT, zip, path.join(parent, `stage-${index}`)]));
  }
  await run(python, ['-c', 'import zipfile,stat,sys;z=zipfile.ZipFile(sys.argv[1],"w");i=zipfile.ZipInfo("link");i.create_system=3;i.external_attr=(stat.S_IFLNK|0o777)<<16;z.writestr(i,"/outside");z.close()', zip]);
  await assert.rejects(run(python, ['-c', EXTRACT, zip, path.join(parent, 'stage-link')]));
  await assert.rejects(fs.stat(path.join(parent, 'outside')), {code: 'ENOENT'});
});
