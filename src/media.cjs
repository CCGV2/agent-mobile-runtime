const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {spawn, execFile} = require('node:child_process');
const {promisify} = require('node:util');

const execFileAsync = promisify(execFile);
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RECORDING_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ACTIVE = new Set(['starting', 'recording', 'stopping']);
const TYPES = {screen: {extension: '.mkv', mime: 'video/x-matroska'}, audio: {extension: '.opus', mime: 'audio/ogg'}};

function identifier(value, recording = false) {
  if (typeof value !== 'string' || !(recording ? RECORDING_ID : DEVICE_ID).test(value)) throw new Error('Invalid recording or device identifier');
  return value;
}

function publicRecord(record) {
  const fields = ['id', 'deviceId', 'kind', 'state', 'startedAt', 'endedAt', 'durationSec', 'bytes', 'validation', 'error'];
  return Object.fromEntries(fields.filter(key => record[key] !== undefined).map(key => [key, record[key]]));
}

class MediaManager {
  constructor({config, spawnProcess = spawn, onEvent = () => {}}) {
    this.config = config;
    this.spawnProcess = spawnProcess;
    this.onEvent = onEvent;
    this.devices = new Map();
    this.loading = new Map();
    this.closed = false;
  }

  async directory(deviceId) {
    identifier(deviceId);
    await fs.mkdir(this.config.dataDir, {recursive: true, mode: 0o700});
    let current = await fs.realpath(this.config.dataDir);
    // Resolve the configured root once, but never follow links below it.
    for (const component of ['devices', deviceId, 'artifacts', 'media']) {
      current = path.join(current, component);
      await fs.mkdir(current, {mode: 0o700}).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid media directory');
    }
    return current;
  }

  environment() {
    const env = {
      PATH: process.env.PATH || '/usr/bin:/bin',
      LANG: 'C.UTF-8',
      HOME: path.join(this.config.dataDir, 'home'),
      ANDROID_USER_HOME: path.join(this.config.dataDir, 'android-home'),
      ADB_SERVER_SOCKET: `tcp:127.0.0.1:${this.config.adbServerPort || 5038}`,
      ANDROID_ADB_SERVER_PORT: String(this.config.adbServerPort || 5038),
    };
    if (this.config.adbPath) env.ADB = this.config.adbPath;
    if (this.config.sdkRoot) env.ANDROID_HOME = env.ANDROID_SDK_ROOT = this.config.sdkRoot;
    return env;
  }

  async usedBytes(directory) {
    let total = 0;
    for (const filename of await fs.readdir(directory)) {
      if (!/^([a-f0-9-]+)\.(mkv|opus)$/.test(filename) || !RECORDING_ID.test(filename.slice(0, filename.lastIndexOf('.')))) continue;
      const stat = await fs.lstat(path.join(directory, filename));
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid recording output');
      total += stat.size;
      if (!Number.isSafeInteger(total)) throw new Error('Recording storage quota exceeded');
    }
    return total;
  }

  async load(deviceId) {
    identifier(deviceId);
    if (this.devices.has(deviceId)) return this.devices.get(deviceId);
    if (this.loading.has(deviceId)) return this.loading.get(deviceId);
    const promise = (async () => {
      const directory = await this.directory(deviceId);
      const records = new Map();
      for (const filename of await fs.readdir(directory)) {
        if (!filename.endsWith('.json') || !RECORDING_ID.test(filename.slice(0, -5))) continue;
        try {
          const filenamePath = path.join(directory, filename);
          const stat = await fs.lstat(filenamePath);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) continue;
          const meta = JSON.parse(await fs.readFile(filenamePath, 'utf8'));
          if (meta.id !== filename.slice(0, -5) || meta.deviceId !== deviceId || !Object.hasOwn(TYPES, meta.kind) || !['starting', 'recording', 'stopping', 'completed', 'failed'].includes(meta.state)
            || typeof meta.startedAt !== 'string' || !Number.isFinite(Date.parse(meta.startedAt)) || !Number.isInteger(meta.durationSec) || meta.durationSec < 1
            || !Number.isSafeInteger(meta.bytes) || meta.bytes < 0) continue;
          const record = {...publicRecord(meta), directory, persisted: Promise.resolve(), finished: true};
          if (ACTIVE.has(record.state)) {
            record.state = 'failed';
            record.error = 'Recording interrupted by runtime restart';
            record.endedAt = new Date().toISOString();
            delete record.validation;
            // PIDs in old metadata are deliberately never used as authority to kill.
            await this.persist(record);
          }
          records.set(record.id, record);
        } catch { /* Ignore untrusted or incomplete catalog files. */ }
      }
      this.devices.set(deviceId, records);
      return records;
    })();
    this.loading.set(deviceId, promise);
    try { return await promise; } finally { this.loading.delete(deviceId); }
  }

  persist(record) {
    const content = JSON.stringify(publicRecord(record)) + '\n';
    const write = async () => {
      const temporary = path.join(record.directory, `.${record.id}-${randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, content, {flag: 'wx', mode: 0o600});
        await fs.rename(temporary, path.join(record.directory, record.id + '.json'));
      } finally { await fs.unlink(temporary).catch(() => {}); }
    };
    record.persisted = (record.persisted || Promise.resolve()).catch(() => {}).then(write);
    return record.persisted;
  }

  event(record) {
    try { this.onEvent(publicRecord(record)); } catch { /* Observer errors do not control media processes. */ }
  }

  filename(record) {
    return path.join(record.directory, record.id + TYPES[record.kind].extension);
  }

  async start(device, options = {}) {
    if (this.closed) throw new Error('Media service is shutting down');
    identifier(device?.id);
    if (typeof device.serial !== 'string' || !/^emulator-\d{4,5}$/.test(device.serial)) throw new Error('Recording requires a managed emulator');
    const kind = options.kind === undefined ? 'screen' : options.kind;
    if (!Object.hasOwn(TYPES, kind)) throw new Error('Recording kind must be screen or audio');
    const maximum = this.config.mediaMaxDurationSec || 300;
    const durationSec = options.durationSec === undefined ? Math.min(60, maximum) : options.durationSec;
    if (!Number.isInteger(durationSec) || durationSec < 1 || durationSec > maximum) throw new Error(`Recording duration must be between 1 and ${maximum} seconds`);
    const directory = await this.directory(device.id);
    const records = await this.load(device.id);
    const usedBytes = await this.usedBytes(directory);
    if (this.closed) throw new Error('Media service is shutting down');
    if ([...records.values()].some(record => ACTIVE.has(record.state))) throw new Error('Device already has an active recording');
    const byteLimit = (this.config.mediaMaxBytes || 512 * 1024 * 1024) - usedBytes;
    if (byteLimit <= 0) throw new Error('Device recording storage quota exceeded');
    const record = {
      id: randomUUID(), deviceId: device.id, kind, state: 'starting', durationSec,
      startedAt: new Date().toISOString(), directory, bytes: 0,
      persisted: Promise.resolve(), finished: false, byteLimit,
    };
    record.done = new Promise(resolve => { record.resolveDone = resolve; });
    // Reserve before any further await, so simultaneous calls cannot launch twice.
    records.set(record.id, record);
    try {
      await this.persist(record);
      await fs.mkdir(this.environment().HOME, {recursive: true, mode: 0o700});
      await fs.mkdir(this.environment().ANDROID_USER_HOME, {recursive: true, mode: 0o700});
      if (record.finished || record.finishing || record.stopRequested) throw new Error('Recording startup was cancelled');
      const args = ['--serial', device.serial, '--no-playback', '--no-window', '--no-control', '--require-audio', '--audio-source=output', '--audio-codec=opus', `--record=${this.filename(record)}`, `--time-limit=${durationSec}`];
      if (kind === 'audio') args.push('--no-video');
      const ready = new Promise((resolve, reject) => { record.resolveReady = resolve; record.rejectReady = reject; });
      record.child = this.spawnProcess(this.config.scrcpyPath || 'scrcpy', args, {stdio: ['ignore', 'ignore', 'ignore'], env: this.environment(), shell: false});
      record.child.once('spawn', () => record.resolveReady());
      record.child.once('error', () => {
        record.rejectReady(new Error('Unable to start recording; verify scrcpy installation'));
        void this.finish(record, 'Unable to start recording; verify scrcpy installation');
      });
      record.child.once('close', (code, signal) => {
        record.unconfirmedExit = false;
        record.resolveReady();
        const expected = code === 0 || (record.stopRequested && ['SIGINT', 'SIGTERM'].includes(signal));
        void this.finish(record, record.failure || (expected ? null : 'Recording process exited unsuccessfully'));
      });
      const spawnTimeout = setTimeout(() => {
        record.rejectReady(new Error('Recording process did not start'));
        record.failure = 'Recording process did not start';
        void this.stop(device.id, record.id);
      }, this.config.mediaSpawnTimeoutMs || 10000);
      spawnTimeout.unref();
      try { await ready; } finally { clearTimeout(spawnTimeout); }
      if (record.finished || record.finishing || record.stopRequested) {
        await record.done;
        throw new Error(record.error || 'Recording ended before it became ready');
      }
      record.state = 'recording';
      await this.persist(record);
      if (record.finished || record.finishing || record.stopRequested) {
        await record.done;
        throw new Error(record.error || 'Recording ended before it became ready');
      }
      this.event(record);
      record.poll = setInterval(() => { void this.checkSize(record); }, this.config.mediaPollMs || 250);
      record.poll.unref();
      record.deadline = setTimeout(() => { void this.stop(device.id, record.id).catch(() => {}); }, durationSec * 1000 + 3000);
      record.deadline.unref();
      return publicRecord(record);
    } catch (error) {
      if (record.child && !record.finished && !record.finishing) {
        record.failure = 'Recording startup failed';
        await this.stop(device.id, record.id);
      } else if (!record.finished && !record.finishing) await this.finish(record, 'Recording startup failed');
      if (record.finishing) await record.done;
      throw error;
    }
  }

  async checkSize(record) {
    if (record.finished || record.finishing || record.checking) return;
    record.checking = true;
    try {
      const stat = await fs.lstat(this.filename(record));
      record.bytes = stat.size;
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > record.byteLimit) {
        record.failure = stat.size > record.byteLimit ? 'Recording exceeded device byte limit' : 'Invalid recording output';
        await this.stop(record.deviceId, record.id);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') {
        record.failure = 'Cannot inspect recording output';
        await this.stop(record.deviceId, record.id).catch(() => {});
      }
    } finally { record.checking = false; }
  }

  async validate(record) {
    const filename = this.filename(record);
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 4 || stat.size > (record.byteLimit || this.config.mediaMaxBytes || 512 * 1024 * 1024)) throw new Error('Invalid or oversized recording output');
    const handle = await fs.open(filename, 'r');
    try {
      const header = Buffer.alloc(Math.min(65536, stat.size));
      await handle.read(header, 0, header.length, 0);
      if (record.kind === 'screen' ? !header.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) : header.toString('ascii', 0, 4) !== 'OggS' || !header.includes(Buffer.from('OpusHead'))) throw new Error('Recording container header is invalid');
    } finally { await handle.close(); }
    let validation = 'container-header';
    if (this.config.ffprobePath) {
      const {stdout} = await execFileAsync(this.config.ffprobePath, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', filename], {timeout: 15000, maxBuffer: 1024 * 1024, env: this.environment(), shell: false});
      const types = new Set(JSON.parse(stdout).streams?.map(stream => stream.codec_type));
      if (!types.has('audio') || (record.kind === 'screen' && !types.has('video'))) throw new Error('Recording is missing an expected audio or video track');
      validation = 'audio-track-verified';
    }
    return {bytes: stat.size, validation};
  }

  async finish(record, failure) {
    if (record.finished || record.finishing) return record.done;
    record.finishing = true;
    clearInterval(record.poll);
    clearTimeout(record.deadline);
    try {
      if (!failure) {
        try { Object.assign(record, await this.validate(record)); }
        catch { failure = 'Recording output validation failed'; }
      }
      record.state = failure ? 'failed' : 'completed';
      record.endedAt = new Date().toISOString();
      if (failure) {
        record.error = failure;
        delete record.validation;
        await fs.unlink(this.filename(record)).catch(() => {});
      }
      try { await this.persist(record); }
      catch {
        record.state = 'failed';
        record.error = 'Cannot persist recording result';
        delete record.validation;
      }
      this.event(record);
    } finally {
      record.finished = true;
      record.finishing = false;
      record.resolveDone?.(publicRecord(record));
    }
    return publicRecord(record);
  }

  async stop(deviceId, recordingId) {
    identifier(recordingId, true);
    const record = (await this.load(deviceId)).get(recordingId);
    if (!record) throw new Error('Recording not found for device');
    if (record.finished) return publicRecord(record);
    if (record.finishing || record.state === 'stopping') return record.done;
    record.state = 'stopping';
    record.stopRequested = true;
    clearTimeout(record.deadline);
    await this.persist(record).catch(() => {});
    if (!record.child) return this.finish(record, 'Recording process unavailable');
    const grace = this.config.mediaStopTimeoutMs || 2000;
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL']) {
      if (record.finished || record.finishing) break;
      try { record.child.kill(signal); } catch { /* The close/error event can race with termination. */ }
      let timer;
      await Promise.race([record.done, new Promise(resolve => { timer = setTimeout(resolve, grace); })]);
      clearTimeout(timer);
    }
    if (!record.finished && !record.finishing) {
      record.unconfirmedExit = true;
      await this.finish(record, record.failure || 'Recording process did not exit');
    }
    return record.done;
  }

  async list(deviceId) {
    return [...(await this.load(deviceId)).values()].map(publicRecord).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  async artifact(deviceId, recordingId) {
    identifier(recordingId, true);
    const record = (await this.load(deviceId)).get(recordingId);
    if (!record || record.state !== 'completed') throw new Error('Completed recording not found for device');
    await this.directory(deviceId);
    const stat = await fs.lstat(this.filename(record));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.bytes) throw new Error('Recording artifact has changed');
    return {path: this.filename(record), mime: TYPES[record.kind].mime, filename: record.id + TYPES[record.kind].extension, size: stat.size};
  }

  async stopDevice(deviceId) {
    const records = await this.load(deviceId);
    await Promise.all([...records.values()].filter(record => !record.finished).map(record => this.stop(deviceId, record.id)));
    if ([...records.values()].some(record => record.unconfirmedExit)) throw new Error('Recording process termination not confirmed');
  }

  async shutdown() {
    this.closed = true;
    await Promise.all([...this.devices.keys()].map(deviceId => this.stopDevice(deviceId)));
  }
}

module.exports = {MediaManager};
