'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes, randomUUID, createHash, timingSafeEqual} = require('node:crypto');
const {RuntimeError, fail} = require('./errors.cjs');
const {privateDir, readPrivate, atomicJSON, writePrivate} = require('./storage.cjs');

const hash = value => createHash('sha256').update(value).digest('hex');
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; return true; }
};

class MobileRuntime {
  constructor({config, backend, provisioner, media, webrtc = null}) {
    this.config = config;
    this.backend = backend;
    this.provisioner = provisioner;
    this.media = media;
    this.webrtc = webrtc;
    this.sessions = new Map();
    this.children = new Map();
    this.boots = new Map();
    this.frames = new Map();
    this.locks = new Map();
    this.persist = Promise.resolve();
    this.closing = false;
  }

  async init() {
    await privateDir(this.config.dataDir);
    await privateDir(path.join(this.config.dataDir, 'secrets'));
    await privateDir(path.join(this.config.dataDir, 'secrets', 'sessions'));
    this.lockFile = path.join(this.config.dataDir, 'service.lock');
    try { await writePrivate(this.lockFile, JSON.stringify({pid: process.pid, startedAt: new Date().toISOString()})); }
    catch (error) {
      if (error.code === 'EEXIST') fail('runtime_locked', 'Runtime data is locked. Stop the other service, or use unlock after verifying it has exited.', 409);
      throw error;
    }
    this.ownsLock = true;
    try {
      const tokenFile = path.join(this.config.dataDir, 'secrets', 'admin-token');
      try { this.adminToken = (await readPrivate(tokenFile)).trim(); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        this.adminToken = randomBytes(32).toString('hex');
        await writePrivate(tokenFile, this.adminToken + '\n');
      }
      if (!/^[a-f0-9]{64}$/.test(this.adminToken)) throw new Error('Invalid admin credential.');
      try {
        const saved = JSON.parse(await readPrivate(path.join(this.config.dataDir, 'runtime.json')));
        if (saved.schema !== 1 || !Array.isArray(saved.sessions)) throw new Error('Invalid runtime state.');
        for (const session of saved.sessions) {
          this._validateSaved(session);
          if (this.sessions.has(session.id) || session.key && [...this.sessions.values()].some(existing => existing.key === session.key)) throw new Error('Duplicate runtime session identity.');
          if (['booting', 'running', 'stopping'].includes(session.state)) {
            session.state = 'interrupted';
            session.recoveryRequired = true;
          }
          this.sessions.set(session.id, session);
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await this._save();
      return this;
    } catch (error) { await this._unlock(); throw error; }
  }

  _validateSaved(s) {
    if (!s || !identifier(s.id) || !identifier(s.device?.id) || s.id !== s.device.id || !/^[a-f0-9]{64}$/.test(s.tokenHash || '')) throw new Error('Invalid runtime session.');
    if (s.key !== undefined && (typeof s.key !== 'string' || !s.key.length || s.key.length > 200)) throw new Error('Invalid runtime session key.');
    if ((s.mcpManaged !== undefined && typeof s.mcpManaged !== 'boolean') || (s.mcpManaged === true && !s.key)) throw new Error('Invalid managed MCP session.');
    const base = path.join(this.config.dataDir, 'devices', s.id);
    if (s.device.deviceDir !== base || s.device.avdHome !== path.join(base, 'avd') || s.device.avdDir !== path.join(base, 'avd', `${s.id}.avd`) || s.device.avdName !== s.id) throw new Error('Invalid managed device paths.');
    const port = s.device.port;
    if (!Number.isInteger(port) || port < 5554 || port > 5682 || port % 2 || s.device.serial !== `emulator-${port}`) throw new Error('Invalid managed device port.');
    if (!['stopped', 'booting', 'running', 'stopping', 'failed', 'interrupted'].includes(s.state)) throw new Error('Invalid device state.');
  }

  _with(key, work) {
    const previous = this.locks.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(work);
    const tail = operation.catch(() => {});
    this.locks.set(key, tail);
    tail.finally(() => { if (this.locks.get(key) === tail) this.locks.delete(key); });
    return operation;
  }

  _save() {
    const value = {schema: 1, sessions: [...this.sessions.values()]};
    const snapshot = JSON.parse(JSON.stringify(value));
    this.persist = this.persist.catch(() => {}).then(() => atomicJSON(path.join(this.config.dataDir, 'runtime.json'), snapshot));
    return this.persist;
  }

  async _audit(sessionId, operation, outcome) {
    // No input arguments, screen contents, media, credentials, or host paths.
    await fs.appendFile(path.join(this.config.dataDir, 'audit.jsonl'), JSON.stringify({at: new Date().toISOString(), sessionId, operation, outcome}) + '\n', {mode: 0o600});
  }

  authorizeAdmin(token) { return typeof token === 'string' && this._equal(token, this.adminToken); }
  authorizeSession(id, token) {
    const session = this.sessions.get(id);
    return !!session && typeof token === 'string' && token.length <= 256 && this._equal(hash(token), session.tokenHash);
  }
  _equal(a, b) {
    const left = Buffer.from(a || ''); const right = Buffer.from(b || '');
    return left.length === right.length && timingSafeEqual(left, right);
  }
  _matchesSessionCapability(session, expectedTokenHash) {
    return expectedTokenHash === undefined || !!session && typeof expectedTokenHash === 'string' && /^[a-f0-9]{64}$/.test(expectedTokenHash) && this._equal(session.tokenHash, expectedTokenHash);
  }

  async createSession({template, key} = {}) {
    return this._with('create', () => this._createSession({template, key}));
  }

  // Trusted local broker entry point. A logical key routes a connection; the
  // private credential remains a separate capability and is never regenerated
  // merely because a reconnect cannot read the existing one. expectedTokenHash
  // is a broker-only snapshot of that credential, never public/model output.
  async ensureSession({template, key} = {}) {
    return this._with('create', async () => {
      if (this.closing) fail('closing', 'Runtime is stopping.', 503);
      if (typeof key !== 'string' || !key.length || key.length > 200) fail('invalid_key', 'Invalid session key.');
      const session = [...this.sessions.values()].find(s => s.key === key);
      if (!session) return {...await this._createSession({template, key}, true), managed: true};
      if (session.template !== template) fail('session_template_mismatch', 'That session key belongs to a different template.', 409);
      const credentialFile = path.join(this.config.dataDir, 'secrets', 'sessions', `${session.id}.json`);
      let expectedTokenHash;
      try {
        const credential = JSON.parse(await readPrivate(credentialFile));
        if (credential.schema !== 1 || credential.sessionId !== session.id || !/^[a-f0-9]{64}$/.test(credential.token || '') || !this.authorizeSession(session.id, credential.token)) throw new Error('Invalid session credential.');
        expectedTokenHash = hash(credential.token);
      } catch {
        fail('session_credentials_unavailable', 'Existing session credentials are unavailable or invalid; inspect the session before reconnecting.', 409);
      }
      if (this.closing) fail('closing', 'Runtime is stopping.', 503);
      return {...this.state(session.id), credentialFile, managed: session.mcpManaged === true, expectedTokenHash};
    });
  }

  // These routing/ownership details stay out of the public state/list API.
  listManagedSessions() {
    return [...this.sessions.values()].filter(s => s.mcpManaged === true).map(({id, key, template, state}) => ({id, key, template, state}));
  }

  async _createSession({template, key}, mcpManaged = false) {
    if (this.closing) fail('closing', 'Runtime is stopping.', 503);
    if (key !== undefined && (typeof key !== 'string' || !key.length || key.length > 200)) fail('invalid_key', 'Invalid session key.');
    if (key && [...this.sessions.values()].some(s => s.key === key)) fail('session_exists', 'That logical session already exists.', 409);
    if (this.sessions.size >= this.config.maxDevices) fail('capacity', 'Device capacity reached; destroy an unused session.', 409);
    const id = `m-${randomUUID()}`;
    const used = new Set([...this.sessions.values()].map(s => s.device.port));
    let port = this.config.emulatorPortStart;
    while (used.has(port)) port += 2;
    await this._audit(id, 'create', 'started');
    if (this.closing) fail('closing', 'Runtime is stopping.', 503);
    let device, registered = false, credentialWritten = false;
    const credentialFile = path.join(this.config.dataDir, 'secrets', 'sessions', `${id}.json`);
    try {
      device = {...await this.provisioner.create({id, template}), port, serial: `emulator-${port}`};
      if (this.closing) fail('closing', 'Runtime is stopping.', 503);
      const token = randomBytes(32).toString('hex');
      const session = {id, key, device, template, tokenHash: hash(token), state: 'stopped', takeover: false, recoveryRequired: false, createdAt: new Date().toISOString(), ...(mcpManaged ? {mcpManaged: true} : {})};
      await writePrivate(credentialFile, JSON.stringify({schema: 1, sessionId: id, token}) + '\n');
      credentialWritten = true;
      if (this.closing) fail('closing', 'Runtime is stopping.', 503);
      this.sessions.set(id, session);
      registered = true;
      await this._save();
      if (this.closing) fail('closing', 'Runtime is stopping.', 503);
      await this._audit(id, 'create', 'completed');
      if (this.closing) fail('closing', 'Runtime is stopping.', 503);
      return {...this.state(id), credentialFile, ...(mcpManaged ? {expectedTokenHash: hash(token)} : {})};
    } catch (error) {
      if (registered) this.sessions.delete(id);
      if (credentialWritten) await fs.rm(credentialFile, {force: true});
      if (device) await this.provisioner.destroy(device);
      if (registered) await this._save();
      throw error;
    }
  }

  _session(id) {
    const s = this.sessions.get(id);
    if (!s) fail('not_found', 'Session not found.', 404);
    return s;
  }
  state(id) {
    const s = this._session(id);
    return {id: s.id, deviceId: s.device.id, template: s.template, state: s.state, takeover: s.takeover, recoveryRequired: s.recoveryRequired, createdAt: s.createdAt,
      capabilities: {screen: true, internalAudioRecording: true, realtimeMedia: this.webrtc?.enabled() === true, realtimeMediaMode: 'local-media-only', hostNetworkIsolation: false, textInput: 'printable-ascii'}};
  }
  list() { return [...this.sessions.keys()].map(id => this.state(id)); }

  async execute(id, action, args = {}, {operator = false, expectedTokenHash} = {}) {
    const current = this.sessions.get(id);
    if (action === 'stop' && (operator || !current?.takeover) && this._matchesSessionCapability(current, expectedTokenHash)) this.boots.get(id)?.abort();
    return this._with(id, async () => {
      if (this.closing) fail('closing', 'Runtime is stopping.', 503);
      const s = this._session(id);
      if (!this._matchesSessionCapability(s, expectedTokenHash)) fail('unauthorized', 'Session authentication required.', 401);
      if (!args || Array.isArray(args) || typeof args !== 'object') fail('invalid_arguments', 'Arguments must be an object.');
      if (action === 'state') return this.state(id);
      const agentActions = new Set(['start', 'stop', 'snapshot', 'screenshot', 'tap', 'swipe', 'text', 'key', 'launch_app', 'apps', 'recording_start', 'recording_stop', 'recording_list']);
      if (!agentActions.has(action) && !(operator && ['takeover', 'release', 'install_app', 'recover'].includes(action))) fail('unknown_action', 'Unsupported action.');
      if (!operator && s.takeover) fail('human_control', 'Operator has control. Wait for release.', 409);
      const input = ['tap', 'swipe', 'text', 'key'].includes(action);
      if (operator && input) {
        if (!s.takeover) fail('takeover_required', 'Take control before sending operator input.', 409);
        const frame = this.frames.get(id);
        if (!frame || frame.id !== args.frameId || Date.now() - frame.at > 10000) fail('stale_frame', 'Capture a fresh operator screenshot before input.', 409);
        // Consume before sending anything; ambiguous input never reuses a frame.
        this.frames.delete(id);
      }
      if (input || ['start', 'stop', 'takeover', 'release', 'launch_app', 'install_app', 'recover'].includes(action)) this.frames.delete(id);
      await this._audit(id, action, 'started');
      let result;
      try {
        if (action === 'start') result = await this._start(s);
        else if (action === 'stop') { await this._stop(s); result = this.state(id); }
        else if (action === 'recover') {
          if (args.confirmStopped !== true) fail('confirmation_required', 'Confirm that you inspected and stopped the interrupted emulator.');
          await this._stop(s, {confirmed: true}); result = this.state(id);
        } else if (action === 'takeover') {
          await this.webrtc?.closeDevice(id);
          // Stop recordings before a person enters potentially sensitive content.
          await this.media.stopDevice(id);
          s.takeover = true; await this._save(); result = this.state(id);
        } else if (action === 'release') { await this.webrtc?.closeDevice(id); s.takeover = false; await this._save(); result = this.state(id); }
        else if (action === 'recording_list') result = await this.media.list(id);
        else if (action === 'recording_stop') result = await this.media.stop(id, args.recordingId);
        else {
          if (s.state !== 'running') fail('not_running', 'Start the device before using it.', 409);
          const methods = {snapshot: 'snapshot', screenshot: 'screenshot', tap: 'tap', swipe: 'swipe', text: 'text', key: 'key', launch_app: 'launchApp', install_app: 'installApp', apps: 'apps'};
          if (action === 'recording_start') result = await this.media.start(s.device, args);
          else {
            if (action === 'install_app') {
              if (!path.isAbsolute(args.apkPath || '')) fail('invalid_apk', 'APK path must be absolute.');
              const handle = await fs.open(args.apkPath, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
              try { if (!(await handle.stat()).isFile() || !args.apkPath.endsWith('.apk')) fail('invalid_apk', 'APK must be a regular .apk file.'); }
              finally { await handle.close(); }
            }
            result = await this.backend[methods[action]](s.device, args);
            if (operator && action === 'screenshot') {
              const frameId = randomUUID();
              this.frames.set(id, {id: frameId, at: Date.now()});
              result = {mime: 'image/png', data: result.toString('base64'), width: result.readUInt32BE(16), height: result.readUInt32BE(20), frameId};
            }
          }
        }
      } catch (error) { await this._audit(id, action, 'failed_or_uncertain'); throw error; }
      await this._audit(id, action, 'completed');
      return result === undefined ? {ok: true} : result;
    });
  }

  async _start(s) {
    if (s.state === 'running') return this.state(s.id);
    if (s.recoveryRequired) fail('recovery_required', 'Stop and reconcile the interrupted device before starting it.', 409);
    // Persist intent BEFORE spawning: a crash in the spawn/save gap must never
    // make a live emulator's disk appear safe to delete.
    s.state = 'booting'; s.recoveryRequired = true; s.launchIntent = true;
    delete s.device.pid;
    const controller = new AbortController(); this.boots.set(s.id, controller);
    let child;
    try {
      await this._save();
      if (controller.signal.aborted) throw new DOMException('Boot cancelled', 'AbortError');
      child = await this.backend.launch(s.device);
    }
    catch (error) {
      s.state = 'stopped'; s.recoveryRequired = false; s.launchIntent = false;
      this.boots.delete(s.id);
      await this._save(); throw error;
    }
    this.children.set(s.id, child);
    s.device.pid = child.pid;
    s.launchIntent = false;
    const exited = () => {
      if (this.children.get(s.id) !== child) return;
      this.children.delete(s.id);
      if (s.state !== 'stopping') {
        // A launcher can exit before its VM/transport has fully disappeared.
        // Require named-device reconciliation before reuse or disk deletion.
        s.state = 'failed'; s.recoveryRequired = true;
        void this._save().catch(() => {});
        void this.media.stopDevice(s.id).catch(() => {});
        void this.webrtc?.closeDevice(s.id).catch(() => {});
      }
    };
    child.once('exit', exited);
    child.once('error', exited);
    // Drain output without persisting app content or emulator command arguments.
    child.stdout?.resume(); child.stderr?.resume();
    try {
      await this._save();
      await this.backend.waitReady(s.device, {signal: controller.signal});
      if (!this.children.has(s.id)) throw new Error('Emulator exited during boot.');
      s.state = 'running'; s.recoveryRequired = false; await this._save();
      return this.state(s.id);
    } catch (error) {
      try { await this._stop(s); } catch { s.state = 'interrupted'; s.recoveryRequired = true; await this._save(); }
      throw error;
    } finally { this.boots.delete(s.id); }
  }

  async _stop(s, {confirmed = false} = {}) {
    await this.webrtc?.closeDevice(s.id);
    await this.media.stopDevice(s.id);
    if (s.state === 'stopped' && !s.recoveryRequired && !this.children.has(s.id)) return;
    s.state = 'stopping'; await this._save();
    const child = this.children.get(s.id);
    try {
      if (child) {
        const exit = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        let timer;
        const stopped = await Promise.race([exit.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), this.config.stopTimeoutMs); })]);
        clearTimeout(timer);
        if (!stopped) {
          child.kill('SIGKILL');
          let killTimer;
          const dead = await Promise.race([exit.then(() => true), new Promise(resolve => { killTimer = setTimeout(() => resolve(false), this.config.stopTimeoutMs); })]);
          clearTimeout(killTimer);
          if (!dead) throw new Error('Owned emulator did not exit.');
        }
        this.children.delete(s.id);
        await this.backend.recover(s.device);
      } else {
        const recovery = await this.backend.recover(s.device);
        if (s.launchIntent && !s.device.pid && recovery?.state !== 'stopped' && !confirmed) {
          fail('recovery_required', 'Interrupted launch has no recorded process identity. Inspect it and use explicit operator recovery.', 409);
        }
        // A recorded PID is only a liveness check, never a signal target. PID reuse
        // or a booting emulator with no ADB transport requires operator recovery.
        const deadline = Date.now() + this.config.stopTimeoutMs;
        while (alive(s.device.pid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
        if (alive(s.device.pid)) fail('recovery_required', 'Cannot confirm the previous emulator exited. Inspect it manually; no PID was signaled.', 409);
      }
      delete s.device.pid;
      s.state = 'stopped'; s.recoveryRequired = false; s.launchIntent = false; await this._save();
    } catch (error) { s.state = 'interrupted'; s.recoveryRequired = true; await this._save(); throw error; }
  }

  async destroySession(id) {
    if (this.closing) fail('closing', 'Runtime is stopping.', 503);
    this.boots.get(id)?.abort();
    return this._with(id, async () => {
      if (this.closing) fail('closing', 'Runtime is stopping.', 503);
      const s = this._session(id);
      await this._audit(id, 'destroy', 'started');
      await this._stop(s);
      // Revoke first. A failed deletion leaves a stopped, revoked session for an
      // operator to retry, never a live credential to a partially deleted disk.
      s.tokenHash = hash(randomBytes(32));
      await this._save();
      await fs.rm(path.join(this.config.dataDir, 'secrets', 'sessions', `${id}.json`), {force: true});
      await this.provisioner.destroy(s.device);
      this.frames.delete(id);
      this.sessions.delete(id); await this._save();
      await this._audit(id, 'destroy', 'completed');
      return {destroyed: true, id};
    });
  }

  async artifact(id, recordingId, {operator = false, expectedTokenHash} = {}) {
    return this._with(id, async () => {
      if (this.closing) fail('closing', 'Runtime is stopping.', 503);
      const s = this._session(id);
      if (!this._matchesSessionCapability(s, expectedTokenHash)) fail('unauthorized', 'Session authentication required.', 401);
      if (!operator && s.takeover) fail('human_control', 'Operator has control.', 409);
      return this.media.artifact(id, recordingId);
    });
  }

  async live(id, operation, owner, value = {}) {
    return this._with(id, async () => {
      if (this.closing) fail('closing', 'Runtime is stopping.', 503);
      const s = this._session(id);
      if (!this.webrtc?.enabled()) fail('live_disabled', 'Local WebRTC is not configured.', 409);
      if (s.state !== 'running') fail('not_running', 'Start this device before live preview.', 409);
      if (operation === 'open') {
        await this._audit(id, 'live_open', 'started');
        try {
          const result = await this.webrtc.open(s, owner, value.offer);
          await this._audit(id, 'live_open', 'completed');
          return result;
        } catch (error) { await this._audit(id, 'live_open', 'failed_or_uncertain'); throw error; }
      }
      if (operation === 'renew') return this.webrtc.renew(id, value.id, owner);
      if (operation === 'close') return this.webrtc.close(id, value.id, owner);
      fail('unknown_action', 'Unsupported live operation.');
    });
  }

  async closeLiveOwner(owner) { await this.webrtc?.closeOwner(owner); }

  async close() {
    this.closing = true;
    for (const controller of this.boots.values()) controller.abort();
    const failures = [];
    try { await this.webrtc?.shutdown(); } catch (error) { failures.push(error); }
    await Promise.all([...this.locks.values()]);
    for (const s of this.sessions.values()) {
      try { await this._stop(s); } catch (error) { failures.push(error); }
    }
    try { await this.media.shutdown(); } catch (error) { failures.push(error); }
    await this.persist;
    await this._unlock();
    if (failures.length) throw new AggregateError(failures, 'Some owned devices require recovery.');
  }
  async _unlock() {
    if (this.ownsLock) { this.ownsLock = false; await fs.rm(this.lockFile, {force: true}); }
  }
}

module.exports = {MobileRuntime, identifier, alive};
