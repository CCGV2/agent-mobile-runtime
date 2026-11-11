'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {constants} = require('node:fs');
const {inspectLinuxHost, accelerationDiagnostic} = require('../src/linux-host.cjs');
const {doctor} = require('../src/doctor.cjs');

function hostFiles({missing = false, character = true, symlink = false, read = true, write = true,
  cpu = 'processor : 0\nflags : fpu vmx hypervisor\n'} = {}) {
  return {
    async readFile(filename, encoding) {
      assert.equal(filename, '/proc/cpuinfo'); assert.equal(encoding, 'utf8');
      return cpu;
    },
    async lstat(filename) {
      assert.equal(filename, '/dev/kvm');
      if (missing) throw Object.assign(new Error('missing'), {code: 'ENOENT'});
      return {isSymbolicLink: () => symlink, isCharacterDevice: () => character};
    },
    async access(filename, mode) {
      assert.equal(filename, '/dev/kvm');
      assert.ok([constants.R_OK, constants.W_OK].includes(mode));
      if ((mode === constants.R_OK && !read) || (mode === constants.W_OK && !write)) {
        throw Object.assign(new Error('private filesystem detail'), {code: 'EACCES'});
      }
    },
  };
}

test('Linux requires an actual readable and writable KVM character device on x86_64', async () => {
  const result = await inspectLinuxHost({architecture: 'x64', filesystem: hostFiles()});
  assert.equal(result.ok, true);
  assert.deepEqual(result.kvm, {path: '/dev/kvm', present: true, characterDevice: true, readable: true, writable: true});
  assert.deepEqual(result.remediation, []);
  assert.equal(result.virtualization.hardwareFlags, true);
  assert.equal(result.virtualization.hypervisor, true);
  assert.equal(result.virtualization.nestedMayBeRequired, true);
});

test('missing devices, regular files, symlinks and partial permissions fail closed with actionable guidance', async () => {
  for (const options of [{missing: true}, {character: false}, {symlink: true}, {read: false}, {write: false}]) {
    const result = await inspectLinuxHost({architecture: 'x64', filesystem: hostFiles(options)});
    assert.equal(result.ok, false);
    assert.ok(result.remediation.length);
    assert.ok(!JSON.stringify(result).includes('private filesystem detail'));
    if (options.read === false || options.write === false) {
      assert.ok(result.remediation.some(value => value.includes('kvm device group') && value.includes('world writable')));
    } else assert.ok(result.remediation.some(value => value.includes('nested virtualization') && value.includes('passed through')));
  }
});

test('Linux ARM64 and desktop windows are explicitly unsupported even if the KVM device is accessible', async () => {
  const arm = await inspectLinuxHost({architecture: 'arm64', filesystem: hostFiles()});
  assert.equal(arm.ok, false);
  assert.match(arm.remediation.join(' '), /x86_64 only/);
  const gui = await inspectLinuxHost({architecture: 'x64', headless: false, filesystem: hostFiles()});
  assert.equal(gui.ok, false);
  assert.match(gui.remediation.join(' '), /headless=true.*Xvfb/);
});

test('CPU flags are advisory and their absence does not bypass the KVM device or SDK checks', async () => {
  const bare = await inspectLinuxHost({architecture: 'x64', filesystem: hostFiles({cpu: 'flags : fpu svm\n'})});
  assert.equal(bare.virtualization.hardwareFlags, true);
  assert.equal(bare.virtualization.hypervisor, false);
  const masked = await inspectLinuxHost({architecture: 'x64', filesystem: hostFiles({cpu: 'flags : fpu hypervisor\n'})});
  assert.equal(masked.ok, true, 'The real SDK acceleration check decides when CPU flags are masked.');
  assert.equal(masked.virtualization.hardwareFlags, false);
  const absent = hostFiles(); absent.readFile = async () => { throw new Error('unavailable'); };
  const result = await inspectLinuxHost({architecture: 'x64', filesystem: absent});
  assert.equal(result.ok, true);
  assert.equal(result.virtualization.cpuFlagsAvailable, false);
  assert.equal(result.virtualization.hardwareFlags, null);
});

test('acceleration diagnostics are bounded and remove terminal controls', () => {
  const result = accelerationDiagnostic(Buffer.from('\x1b[31mKVM permission denied\x1b[0m\r\n\0'), 'x'.repeat(1000));
  assert.ok(result.startsWith('KVM permission denied\n'));
  assert.ok(Buffer.byteLength(result) <= 512);
  assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result));
});

const config = {adbPath: 'adb', emulatorPath: 'emulator', scrcpyPath: 'scrcpy', ffprobePath: 'ffprobe', headless: true};
const provisioner = {async listTemplates() { return [{name: 'clean35', available: true}]; }};
async function executable(_file, args) {
  return {stdout: args[0] === '-accel-check' ? 'KVM acceleration can be used\n' : 'installed tool\n', stderr: ''};
}

test('doctor cannot report ready when Linux KVM, architecture or GUI requirements fail', async () => {
  for (const options of [
    {hostFileSystem: hostFiles({missing: true})},
    {hostFileSystem: hostFiles({write: false})},
    {architecture: 'arm64', hostFileSystem: hostFiles()},
  ]) {
    const result = await doctor(config, provisioner, {platform: 'linux', architecture: 'x64', execute: executable, ...options});
    assert.equal(result.ready, false); assert.equal(result.linux.ok, false);
    assert.equal(result.platform, 'linux');
    assert.ok(result.linux.remediation.length);
  }
  const gui = await doctor({...config, headless: false}, provisioner, {
    platform: 'linux', architecture: 'x64', execute: executable, hostFileSystem: hostFiles(),
  });
  assert.equal(gui.ready, false);
  assert.match(gui.linux.remediation.join(' '), /desktop windows are not supported/);
});

test('doctor keeps SDK acceleration authoritative and reports only bounded captured diagnostics', async () => {
  const result = await doctor(config, provisioner, {
    platform: 'linux', architecture: 'x64', hostFileSystem: hostFiles(),
    async execute(file, args) {
      if (args[0] !== '-accel-check') return executable(file, args);
      throw Object.assign(new Error('SECRET_COMMAND_ARGUMENT'), {
        stdout: 'accel:\n', stderr: '\x1b[31mKVM_CREATE_VM failed\x1b[0m\n' + 'x'.repeat(1000),
      });
    },
  });
  assert.equal(result.linux.ok, true);
  assert.equal(result.ready, false);
  assert.equal(result.acceleration.ok, false);
  assert.match(result.acceleration.diagnostic, /KVM_CREATE_VM failed/);
  assert.ok(Buffer.byteLength(result.acceleration.diagnostic) <= 512);
  assert.ok(!JSON.stringify(result).includes('SECRET_COMMAND_ARGUMENT'));
  assert.match(result.acceleration.remediation, /nested-virtualization/);
});

test('doctor exposes bounded Linux loader diagnostics without echoing executable arguments', async () => {
  const result = await doctor(config, provisioner, {
    platform: 'linux', architecture: 'x64', hostFileSystem: hostFiles(),
    async execute(file, args) {
      if (file !== 'scrcpy') return executable(file, args);
      throw Object.assign(new Error('SECRET_COMMAND_ARGUMENT'), {
        stderr: 'error while loading shared libraries: libavformat.so: cannot open shared object file\n' + 'x'.repeat(1000),
      });
    },
  });
  const scrcpy = result.checks.find(value => value.name === 'scrcpy');
  assert.equal(result.ready, false); assert.equal(scrcpy.ok, false);
  assert.match(scrcpy.diagnostic, /libavformat\.so/);
  assert.ok(Buffer.byteLength(scrcpy.diagnostic) <= 512);
  assert.ok(!JSON.stringify(result).includes('SECRET_COMMAND_ARGUMENT'));
});

test('Linux ready requires both host and SDK checks, while macOS does not inspect Linux device files', async () => {
  const linux = await doctor(config, provisioner, {platform: 'linux', architecture: 'x64', execute: executable, hostFileSystem: hostFiles()});
  assert.equal(linux.ready, true); assert.equal(linux.linux.ok, true);
  assert.match(linux.acceleration.diagnostic, /KVM acceleration/);
  const mac = await doctor({...config, headless: false}, provisioner, {
    platform: 'darwin', architecture: 'x64', execute: executable,
    hostFileSystem: new Proxy({}, {get() { throw new Error('Must not inspect Linux files on macOS'); }}),
  });
  assert.equal(mac.ready, true);
  assert.equal(mac.linux, undefined);
});
