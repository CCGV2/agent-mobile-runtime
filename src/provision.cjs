'use strict';

const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');

const ID = /^[a-z][a-z0-9-]{0,47}$/;
const MARKER = 'managed.json';
const MAX_CONFIG_BYTES = 256 * 1024;
// These point to the installed, operator-selected SDK rather than guest data.
const SDK_PATH_KEYS = new Set([
  'image.sysdir.1', 'image.sysdir.2', 'skin.path', 'kernel.path',
  'disk.systemPartition.initPath', 'disk.vendorPartition.initPath', 'disk.ramdisk.path',
]);

function validID(value, label = 'device id') {
  if (typeof value !== 'string' || !ID.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function inside(root, entry) {
  const relative = path.relative(root, entry);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function excluded(name) {
  return name === 'snapshots' || name === 'cache' || name.startsWith('cache.img') ||
    name === 'hardware-qemu.ini' || name.startsWith('hardware-qemu.ini.') ||
    name === 'emulator-user.ini' || name === 'quickbootChoice.ini' ||
    name === 'read-snapshot.txt' || name === 'snapshot.img' ||
    name === 'grpc.token' || /(?:\.lock|\.qcow2|\.tmp|\.pid)$/.test(name);
}

async function regularFile(file, limit) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Expected a regular template file');
  if (limit && info.size > limit) throw new Error('Template configuration is too large');
  return info;
}

async function inspectTree(directory) {
  const entries = await fs.readdir(directory, {withFileTypes: true});
  for (const entry of entries) {
    const location = path.join(directory, entry.name);
    // Inspect even entries excluded from the clone. A template is trusted input,
    // but a symlink can silently turn a later edit into a host-data disclosure.
    const info = await fs.lstat(location);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error('Template contains a symlink or unsupported file type');
    }
    if (info.isDirectory()) await inspectTree(location);
  }
}

async function copyTree(source, destination) {
  await fs.mkdir(destination, {mode: 0o700});
  for (const entry of await fs.readdir(source, {withFileTypes: true})) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    const info = await fs.lstat(from);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile())) {
      throw new Error('Template changed or contains unsupported entries');
    }
    if (excluded(entry.name)) continue;
    if (info.isDirectory()) await copyTree(from, to);
    else {
      // Reflink when available (notably APFS); copying a multi-gigabyte AVD
      // should not eagerly duplicate every block. Other filesystems fall back.
      await fs.copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      await fs.chmod(to, 0o600);
    }
  }
}

function parseINI(text) {
  const config = new Map();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
    const split = line.indexOf('=');
    if (split < 1) throw new Error('Invalid AVD configuration');
    const key = line.slice(0, split).trim();
    const value = line.slice(split + 1).trim();
    if (!/^[A-Za-z][A-Za-z0-9_.-]*$/.test(key) || /[\0\r\n]/.test(value)) throw new Error('Invalid AVD configuration');
    if (config.has(key)) throw new Error('Duplicate AVD configuration key');
    config.set(key, value);
  }
  return config;
}

function serializeINI(config) {
  return [...config].map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

async function rewriteConfig(text, sourceRoot, targetRoot, id) {
  const config = parseINI(text);
  for (const [key, value] of config) {
    if (!value || SDK_PATH_KEYS.has(key)) continue;
    if (!/(?:\.path|\.initPath)$/i.test(key)) continue;
    const location = path.resolve(sourceRoot, value);
    if (!inside(sourceRoot, location)) throw new Error('Template references external writable data');
    // A referenced file must exist and cannot escape via an intermediate link.
    // Full tree validation also rejects links, including excluded directories.
    const info = await fs.lstat(location);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Invalid template data reference');
    const relative = path.relative(sourceRoot, location);
    if (relative.split(path.sep).some(excluded)) {
      // Runtime caches/snapshots are recreated; do not reference excluded files.
      if (/cache|snap/i.test(key)) config.delete(key);
      else throw new Error('Template references excluded runtime data');
    } else config.set(key, path.join(targetRoot, relative));
  }
  config.set('AvdId', id);
  config.set('avd.ini.displayname', id);
  config.set('avd.ini.encoding', 'UTF-8');
  config.set('hw.camera.back', 'none');
  config.set('hw.camera.front', 'none');
  config.set('hw.audioInput', 'no');
  config.set('fastboot.forceColdBoot', 'yes');
  config.set('fastboot.forceFastBoot', 'no');
  config.set('fastboot.forceChosenSnapshotBoot', 'no');
  config.delete('fastboot.chosenSnapshotFile');
  // Avoid source-specific runtime paths that may exist in older templates.
  config.delete('disk.snapStorage.path');
  return serializeINI(config);
}

class Provisioner {
  constructor({config}) {
    if (!config || typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir)) {
      throw new Error('An absolute runtime data directory is required');
    }
    this.config = config;
    this.queue = Promise.resolve();
  }

  _exclusive(action) {
    const result = this.queue.then(action);
    this.queue = result.catch(() => {});
    return result;
  }

  async _root() {
    const directory = path.resolve(this.config.dataDir);
    if (directory === path.parse(directory).root) throw new Error('Invalid runtime data directory');
    await fs.mkdir(directory, {recursive: true, mode: 0o700});
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Runtime data directory must not be a symlink');
    const root = await fs.realpath(directory);
    const devices = path.join(root, 'devices');
    await fs.mkdir(devices, {mode: 0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const devicesInfo = await fs.lstat(devices);
    if (!devicesInfo.isDirectory() || devicesInfo.isSymbolicLink()) throw new Error('Device directory must not be a symlink');
    return devices;
  }

  async validateTemplate(name) {
    validID(name, 'template name');
    if (!Object.hasOwn(this.config.templates || {}, name)) throw new Error('Unknown template');
    const directory = this.config.templates[name]?.avdDir;
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Template requires an absolute AVD directory');
    const info = await fs.lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Template directory must not be a symlink');
    const root = await fs.realpath(directory);
    const devices = path.join(path.resolve(this.config.dataDir), 'devices');
    if (root === devices || inside(devices, root)) throw new Error('Managed devices cannot be templates');
    await inspectTree(root);
    await regularFile(path.join(root, 'config.ini'), MAX_CONFIG_BYTES);
    const content = await fs.readFile(path.join(root, 'config.ini'), 'utf8');
    // Validate before copying any bytes. A private dummy path is sufficient to
    // exercise every writable-reference check.
    await rewriteConfig(content, root, path.join(root, '.validation-only'), 'validation');
    return {name, avdDir: root, config: content};
  }

  async listTemplates() {
    return Promise.all(Object.keys(this.config.templates || {}).sort().map(async name => {
      try { await this.validateTemplate(name); return {name, available: true}; }
      catch { return {name, available: false, error: 'Template unavailable'}; }
    }));
  }

  async create({id, template}) {
    validID(id);
    validID(template, 'template name');
    return this._exclusive(async () => {
      const baseline = await this.validateTemplate(template);
      const root = await this._root();
      if (baseline.avdDir === root || inside(root, baseline.avdDir) || inside(baseline.avdDir, root)) {
        throw new Error('Template and managed devices must have disjoint directories');
      }
      const current = await fs.readdir(root, {withFileTypes: true});
      const max = this.config.maxDevices ?? 2;
      if (!Number.isInteger(max) || max < 1) throw new Error('Invalid device limit');
      if (current.filter(entry => entry.isDirectory()).length >= max) throw new Error('Device limit reached');
      const deviceDir = path.join(root, id);
      const avdHome = path.join(deviceDir, 'avd');
      const avdDir = path.join(avdHome, `${id}.avd`);
      // Exclusive mkdir means existing instances are never overwritten.
      await fs.mkdir(deviceDir, {mode: 0o700});
      try {
        await fs.mkdir(avdHome, {mode: 0o700});
        await copyTree(baseline.avdDir, avdDir);
        await fs.writeFile(path.join(avdDir, 'config.ini'), await rewriteConfig(baseline.config, baseline.avdDir, avdDir, id), {mode: 0o600});
        await fs.writeFile(path.join(avdHome, `${id}.ini`), `avd.ini.encoding=UTF-8\npath=${avdDir}\n`, {mode: 0o600, flag: 'wx'});
        await fs.writeFile(path.join(deviceDir, MARKER), JSON.stringify({schema: 1, id, template}) + '\n', {mode: 0o600, flag: 'wx'});
        return {id, template, avdName: id, deviceDir, avdHome, avdDir};
      } catch (error) {
        await fs.rm(deviceDir, {recursive: true, force: true});
        throw error;
      }
    });
  }

  async destroy(device) {
    validID(device?.id);
    return this._exclusive(async () => {
      const root = await this._root();
      const deviceDir = path.join(root, device.id);
      // Ignore caller-supplied deletion paths; every path is reconstructed.
      const info = await fs.lstat(deviceDir);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Device directory is not owned');
      if (await fs.realpath(deviceDir) !== deviceDir) throw new Error('Device directory escaped runtime root');
      const markerPath = path.join(deviceDir, MARKER);
      await regularFile(markerPath, 4096);
      const marker = JSON.parse(await fs.readFile(markerPath, 'utf8'));
      if (marker.schema !== 1 || marker.id !== device.id || !ID.test(marker.template || '')) throw new Error('Device ownership marker mismatch');
      // rm does not follow links inside a directory. An externally supplied
      // deviceDir, avdDir, or marker path never participates in this operation.
      await fs.rm(deviceDir, {recursive: true, force: false});
    });
  }
}

module.exports = {Provisioner};
