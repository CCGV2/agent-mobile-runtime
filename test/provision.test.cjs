'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {Provisioner} = require('../src/provision.cjs');

async function fixture(t, content = '') {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-provision-'));
  const root = await fs.realpath(temporary);
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const avdDir = path.join(root, 'baseline.avd');
  await fs.mkdir(avdDir);
  await fs.writeFile(path.join(avdDir, 'config.ini'), [
    'AvdId=personal-phone',
    'image.sysdir.1=system-images/android-35/google_apis/x86_64/',
    'hw.camera.front=webcam0',
    'hw.camera.back=virtualscene',
    'hw.audioInput=yes',
    'fastboot.forceFastBoot=yes',
    content,
  ].join('\n') + '\n');
  await fs.writeFile(path.join(avdDir, 'userdata-qemu.img'), 'baseline-userdata');
  await fs.writeFile(path.join(avdDir, 'sdcard.img'), 'baseline-sdcard');
  const config = {dataDir: path.join(root, 'runtime'), templates: {clean: {avdDir}}, maxDevices: 2};
  return {root, avdDir, config, provisioner: new Provisioner({config})};
}

test('clones a private AVD, rewrites writable data, and removes inherited device integrations', async t => {
  const f = await fixture(t, 'disk.dataPartition.path=userdata-qemu.img\nsdcard.path=sdcard.img');
  const device = await f.provisioner.create({id: 'phone-a', template: 'clean'});
  assert.equal(device.deviceDir, path.join(f.config.dataDir, 'devices', 'phone-a'));
  assert.equal(device.avdName, 'phone-a');
  assert.equal(await fs.readFile(path.join(device.avdDir, 'userdata-qemu.img'), 'utf8'), 'baseline-userdata');
  const ini = await fs.readFile(path.join(device.avdDir, 'config.ini'), 'utf8');
  assert.ok(ini.includes(`disk.dataPartition.path=${device.avdDir}/userdata-qemu.img\n`));
  assert.ok(ini.includes(`sdcard.path=${device.avdDir}/sdcard.img\n`));
  assert.ok(ini.includes('image.sysdir.1=system-images/android-35/google_apis/x86_64/\n'));
  assert.ok(ini.includes('hw.camera.front=none\n'));
  assert.ok(ini.includes('hw.camera.back=none\n'));
  assert.ok(ini.includes('hw.audioInput=no\n'));
  assert.ok(ini.includes('fastboot.forceColdBoot=yes\n'));
  assert.ok(ini.includes('fastboot.forceFastBoot=no\n'));
  assert.equal(await fs.readFile(path.join(device.avdHome, 'phone-a.ini'), 'utf8'), `avd.ini.encoding=UTF-8\npath=${device.avdDir}\n`);
  const marker = JSON.parse(await fs.readFile(path.join(device.deviceDir, 'managed.json'), 'utf8'));
  assert.deepEqual(marker, {schema: 1, id: 'phone-a', template: 'clean'});
  await fs.writeFile(path.join(device.avdDir, 'sdcard.img'), 'changed');
  assert.equal(await fs.readFile(path.join(f.avdDir, 'sdcard.img'), 'utf8'), 'baseline-sdcard');
  if (process.platform !== 'win32') assert.equal((await fs.stat(device.avdDir)).mode & 0o777, 0o700);
});

test('does not copy locks, snapshots, cache or qcow2 backing references', async t => {
  const f = await fixture(t);
  for (const name of ['hardware-qemu.ini', 'userdata-qemu.img.qcow2', 'cache.img', 'emulator-user.ini', 'quickbootChoice.ini']) {
    await fs.writeFile(path.join(f.avdDir, name), 'runtime residue');
  }
  await fs.mkdir(path.join(f.avdDir, 'snapshots'));
  await fs.writeFile(path.join(f.avdDir, 'snapshots', 'default_boot'), 'snapshot');
  await fs.mkdir(path.join(f.avdDir, 'hardware-qemu.ini.lock'));
  const device = await f.provisioner.create({id: 'phone-a', template: 'clean'});
  assert.deepEqual((await fs.readdir(device.avdDir)).sort(), ['config.ini', 'sdcard.img', 'userdata-qemu.img']);
});

test('rejects template symlinks, even inside excluded directories', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.avdDir, 'snapshots'));
  await fs.symlink(path.join(f.root, 'private-data'), path.join(f.avdDir, 'snapshots', 'link'));
  await assert.rejects(f.provisioner.create({id: 'phone-a', template: 'clean'}), /symlink/);
  await assert.rejects(fs.stat(path.join(f.config.dataDir, 'devices', 'phone-a')), {code: 'ENOENT'});
});

test('rejects absolute or relative writable references outside the template', async t => {
  const f = await fixture(t, 'disk.dataPartition.path=../private.img');
  await fs.writeFile(path.join(f.root, 'private.img'), 'do not copy');
  await assert.rejects(f.provisioner.create({id: 'phone-a', template: 'clean'}), /external writable/);
  const configFile = path.join(f.avdDir, 'config.ini');
  await fs.writeFile(configFile, `sdcard.path=${path.join(f.root, 'private.img')}\n`);
  await assert.rejects(f.provisioner.validateTemplate('clean'), /external writable/);
});

test('rejects duplicate keys and unsafe ids without touching existing data', async t => {
  const f = await fixture(t);
  for (const id of ['../escape', 'a/b', '', 'Phone', 'a\npath=/tmp']) {
    await assert.rejects(f.provisioner.create({id, template: 'clean'}), /Invalid device id/);
  }
  await assert.rejects(f.provisioner.create({id: 'phone-a', template: 'unknown'}), /Unknown template/);
  const device = await f.provisioner.create({id: 'phone-a', template: 'clean'});
  await fs.writeFile(path.join(device.deviceDir, 'preserve'), 'keep');
  await assert.rejects(f.provisioner.create({id: 'phone-a', template: 'clean'}), {code: 'EEXIST'});
  assert.equal(await fs.readFile(path.join(device.deviceDir, 'preserve'), 'utf8'), 'keep');
  await fs.appendFile(path.join(f.avdDir, 'config.ini'), 'AvdId=duplicate\n');
  await assert.rejects(f.provisioner.validateTemplate('clean'), /Duplicate/);
});

test('serializes allocations so the instance quota cannot be raced', async t => {
  const f = await fixture(t);
  f.config.maxDevices = 1;
  const results = await Promise.allSettled([
    f.provisioner.create({id: 'phone-a', template: 'clean'}),
    f.provisioner.create({id: 'phone-b', template: 'clean'}),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /Device limit/);
});

test('removes incomplete devices after post-copy validation fails', async t => {
  const f = await fixture(t);
  const validate = f.provisioner.validateTemplate.bind(f.provisioner);
  f.provisioner.validateTemplate = async name => ({...await validate(name), config: 'sdcard.path=/outside/private.img\n'});
  await assert.rejects(f.provisioner.create({id: 'phone-a', template: 'clean'}), /external writable/);
  assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'devices')), []);
});

test('rejects symlinks for the data directory and devices directory', async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, 'elsewhere'));
  await fs.symlink(path.join(f.root, 'elsewhere'), f.config.dataDir);
  await assert.rejects(f.provisioner.create({id: 'phone-a', template: 'clean'}), /symlink/);
  await fs.unlink(f.config.dataDir);
  await fs.mkdir(f.config.dataDir);
  await fs.symlink(path.join(f.root, 'elsewhere'), path.join(f.config.dataDir, 'devices'));
  await assert.rejects(f.provisioner.create({id: 'phone-a', template: 'clean'}), /symlink/);
  assert.deepEqual(await fs.readdir(path.join(f.root, 'elsewhere')), []);
});

test('destroy reconstructs the path and requires a matching ownership marker', async t => {
  const f = await fixture(t);
  const device = await f.provisioner.create({id: 'phone-a', template: 'clean'});
  await fs.writeFile(path.join(device.deviceDir, 'managed.json'), JSON.stringify({schema: 1, id: 'other', template: 'clean'}));
  await assert.rejects(f.provisioner.destroy(device), /ownership marker/);
  await fs.writeFile(path.join(device.deviceDir, 'managed.json'), JSON.stringify({schema: 1, id: 'phone-a', template: 'clean'}));
  await f.provisioner.destroy({...device, deviceDir: f.avdDir, avdDir: f.root});
  assert.equal(await fs.readFile(path.join(f.avdDir, 'userdata-qemu.img'), 'utf8'), 'baseline-userdata');
  await assert.rejects(fs.stat(device.deviceDir), {code: 'ENOENT'});
});

test('destroy rejects a linked instance and a linked marker', async t => {
  const f = await fixture(t);
  const device = await f.provisioner.create({id: 'phone-a', template: 'clean'});
  const marker = path.join(device.deviceDir, 'managed.json');
  await fs.unlink(marker);
  await fs.symlink(path.join(f.avdDir, 'config.ini'), marker);
  await assert.rejects(f.provisioner.destroy(device), /regular template file/);
  await fs.rm(device.deviceDir, {recursive: true});
  await fs.symlink(f.avdDir, device.deviceDir);
  await assert.rejects(f.provisioner.destroy(device), /not owned/);
});

test('template inventory does not reveal host paths or filesystem errors', async t => {
  const f = await fixture(t);
  f.config.templates.missing = {avdDir: path.join(f.root, 'not-there')};
  assert.deepEqual(await f.provisioner.listTemplates(), [
    {name: 'clean', available: true},
    {name: 'missing', available: false, error: 'Template unavailable'},
  ]);
});

test('refuses a runtime directory nested inside a template instead of recursively cloning itself', async t => {
  const f = await fixture(t);
  f.config.dataDir = path.join(f.avdDir, 'runtime');
  await assert.rejects(f.provisioner.create({id: 'phone-a', template: 'clean'}), /disjoint directories/);
  assert.deepEqual(await fs.readdir(path.join(f.config.dataDir, 'devices')), []);
});
