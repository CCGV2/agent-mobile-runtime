'use strict';

const path = require('node:path');
const {spawn} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {fail, RuntimeError} = require('./errors.cjs');
const {localAddresses, sanitizeOffer, sanitizeAnswer} = require('./webrtc-policy.cjs');

// A lease owns a media-only OS process, NOT a native emulator Rtc connection.
// Killing this retained child actually closes its DTLS/SRTP sockets. Signaling
// cancellation alone is not treated as revocation of an established peer.
class WebRTCManager {
  constructor({config, resolveAccess, spawnProcess = spawn, workerPath = path.join(__dirname, '..', 'webrtc', 'worker.py'), addresses = localAddresses, now = Date.now}) {
    this.config = config;
    this.options = config.webrtc;
    this.resolveAccess = resolveAccess;
    this.spawnProcess = spawnProcess;
    this.workerPath = workerPath;
    this.addresses = addresses;
    this.now = now;
    this.peers = new Map();
    this.ownerValid = () => false;
    this.closing = false;
    this.timer = setInterval(() => { void this.sweep().catch(() => {}); }, 500);
    this.timer.unref();
  }

  setOwnerValidator(validator) { this.ownerValid = validator; }
  enabled() { return this.options?.enabled === true; }
  _public(record) {
    return {id: record.id, sessionId: record.sessionId, expiresAt: new Date(record.expires).toISOString(), hardExpiresAt: new Date(record.hardExpires).toISOString(), mode: 'local-media-only'};
  }
  _assertOwner(owner) {
    if (typeof owner !== 'string' || owner.length > 150 || !this.ownerValid(owner)) fail('unauthorized', 'Operator media authorization expired.', 401);
  }
  _find(sessionId, id, owner) {
    this._assertOwner(owner);
    const record = this.peers.get(id);
    if (!record || record.sessionId !== sessionId || record.owner !== owner || record.cancelled || this.now() >= record.expires || this.now() >= record.hardExpires) fail('live_unavailable', 'Live preview is unavailable; reconnect explicitly.', 409);
    return record;
  }

  async open(session, owner, offer) {
    if (!this.enabled()) fail('live_disabled', 'Local WebRTC is not configured.', 409);
    if (this.closing) fail('closing', 'Media service is stopping.', 503);
    this._assertOwner(owner);
    if (this.peers.size >= this.config.maxDevices || [...this.peers.values()].some(p => p.sessionId === session.id)) fail('live_busy', 'This device already has a live preview; close it before reconnecting.', 409);
    const current = this.now();
    const record = {id: randomUUID(), sessionId: session.id, owner, created: current,
      expires: current + this.options.leaseSeconds * 1000,
      hardExpires: current + this.options.maxLifetimeSeconds * 1000,
      cancelled: false, exited: false, buffer: Buffer.alloc(0)};
    record.exit = new Promise(resolve => { record.resolveExit = resolve; });
    record.answer = new Promise((resolve, reject) => { record.resolveAnswer = resolve; record.rejectAnswer = reject; });
    record.cancel = new Promise((_, reject) => { record.rejectCancel = reject; });
    // Attach rejection handling before async validation/discovery begins.
    record.answer.catch(() => {});
    record.cancel.catch(() => {});
    this.peers.set(record.id, record);
    record.deadline = setTimeout(() => {
      record.rejectAnswer(new RuntimeError('live_timeout', 'Live preview negotiation timed out.', 504));
      void this._terminate(record).catch(() => {});
    }, this.options.negotiationTimeoutMs);
    record.deadline.unref();
    try {
      const addresses = [...this.addresses()];
      const sdp = await Promise.race([sanitizeOffer(offer, {addresses}), record.cancel]);
      if (record.cancelled) fail('live_cancelled', 'Live preview was revoked.', 409);
      const access = Promise.resolve().then(() => this.resolveAccess(session.device));
      access.then(value => { if (record.cancelled) void value.close().catch(() => {}); }).catch(() => {});
      record.access = await Promise.race([access, record.cancel]);
      if (record.cancelled) fail('live_cancelled', 'Live preview was revoked.', 409);
      const authorization = {};
      for (const method of ['streamScreenshot', 'streamAudio']) {
        const headers = await Promise.race([record.access.headers(`/android.emulation.control.EmulatorController/${method}`), record.cancel]);
        authorization[method] = headers.authorization;
      }
      if (record.cancelled) fail('live_cancelled', 'Live preview was revoked.', 409);
      this._assertOwner(owner);
      const child = this.spawnProcess(this.options.pythonPath, [
        this.workerPath, '--proto-dir', this.options.protoDir, '--grpc-address', record.access.address,
        '--width', String(this.options.maxWidth), '--height', String(this.options.maxHeight),
        '--fps', String(this.options.fps), '--max-lifetime', String(this.options.maxLifetimeSeconds),
      ], {shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: {
        PATH: process.env.PATH || '/usr/bin:/bin', LANG: 'C.UTF-8',
        HOME: path.join(this.config.dataDir, 'home'),
        PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1',
      }});
      record.child = child;
      child.once('error', () => {
        record.rejectAnswer(new RuntimeError('live_worker_failed', 'Live media worker could not start.', 503));
        void this._terminate(record).catch(() => {});
      });
      child.once('close', () => {
        record.exited = true; record.cancelled = true;
        clearTimeout(record.deadline);
        record.resolveExit();
        record.rejectAnswer(new RuntimeError('live_closed', 'Live media worker stopped.', 409));
        record.rejectCancel(new RuntimeError('live_closed', 'Live media worker stopped.', 409));
        void this._cleanup(record).catch(() => {});
      });
      child.stdin.on('error', () => { void this._terminate(record).catch(() => {}); });
      child.stdout.on('data', chunk => {
        record.buffer = Buffer.concat([record.buffer, chunk]);
        if (record.buffer.length > 128 * 1024) { void this._terminate(record).catch(() => {}); return; }
        let end;
        while ((end = record.buffer.indexOf(10)) !== -1) {
          const line = record.buffer.subarray(0, end); record.buffer = record.buffer.subarray(end + 1);
          let message;
          try { message = JSON.parse(line.toString('utf8')); }
          catch { void this._terminate(record).catch(() => {}); return; }
          if (message.type === 'answer' && !record.answerSeen && typeof message.sdp === 'string') {
            record.answerSeen = true;
            void sanitizeAnswer(message.sdp, {addresses}).then(answer => {
              if (record.cancelled || !this.ownerValid(owner)) throw new Error('Revoked');
              clearTimeout(record.deadline);
              record.resolveAnswer(answer);
            }).catch(() => { void this._terminate(record).catch(() => {}); });
          } else if (message.type === 'error' || message.type === 'closed' || !['ready', 'state'].includes(message.type)) {
            record.rejectAnswer(new RuntimeError('live_worker_failed', 'Live media negotiation failed.', 503));
            void this._terminate(record).catch(() => {});
          }
        }
      });
      child.once('spawn', () => {
        if (record.cancelled) return;
        child.stdin.write(JSON.stringify({type: 'start', offer: sdp, authorization}) + '\n');
      });
      const answer = await record.answer;
      if (record.cancelled) fail('live_cancelled', 'Live preview was revoked.', 409);
      return {...this._public(record), answer: {type: 'answer', sdp: answer}};
    } catch (error) {
      await this._terminate(record);
      if (error instanceof RuntimeError) throw error;
      fail('live_failed', 'Unable to establish local media. Check WebRTC dependencies and emulator state.', 503);
    }
  }

  async renew(sessionId, id, owner) {
    const record = this._find(sessionId, id, owner);
    record.expires = Math.min(record.hardExpires, this.now() + this.options.leaseSeconds * 1000);
    return this._public(record);
  }

  async close(sessionId, id, owner) {
    const record = this._find(sessionId, id, owner);
    await this._terminate(record);
    return {closed: true};
  }

  async _cleanup(record) {
    clearTimeout(record.deadline);
    if (record.access) {
      const access = record.access; record.access = null;
      await access.close();
    }
    if (!record.child || record.exited) this.peers.delete(record.id);
  }

  async _terminate(record) {
    record.cancelled = true;
    record.rejectAnswer(new RuntimeError('live_closed', 'Live preview was revoked.', 409));
    record.rejectCancel(new RuntimeError('live_closed', 'Live preview was revoked.', 409));
    clearTimeout(record.deadline);
    if (!record.child) { await this._cleanup(record); return; }
    if (record.terminating) return record.terminating;
    record.terminating = (async () => {
      if (!record.exited) {
        try { record.child.stdin.end(); record.child.kill('SIGTERM'); } catch {}
        let timer;
        const stopped = await Promise.race([record.exit.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), this.options.shutdownTimeoutMs); })]);
        clearTimeout(timer);
        if (!stopped) {
          try { record.child.kill('SIGKILL'); } catch {}
          let killTimer;
          const dead = await Promise.race([record.exit.then(() => true), new Promise(resolve => { killTimer = setTimeout(() => resolve(false), this.options.shutdownTimeoutMs); })]);
          clearTimeout(killTimer);
          if (!dead) fail('live_revoke_failed', 'Media process exit is unconfirmed. Control remains held; inspect the owned process.', 503);
        }
      }
      await this._cleanup(record);
    })();
    return record.terminating;
  }

  async closeDevice(sessionId) {
    await this._terminateAll([...this.peers.values()].filter(p => p.sessionId === sessionId));
  }
  async closeOwner(owner) {
    await this._terminateAll([...this.peers.values()].filter(p => p.owner === owner));
  }
  async _terminateAll(records) {
    const results = await Promise.allSettled(records.map(record => this._terminate(record)));
    if (results.some(result => result.status === 'rejected')) fail('live_revoke_failed', 'Some media process exits are unconfirmed. Inspect owned processes before continuing.', 503);
  }
  async sweep() {
    await this._terminateAll([...this.peers.values()].filter(record => this.closing || record.cancelled || this.now() >= record.expires || this.now() >= record.hardExpires || !this.ownerValid(record.owner)));
  }
  async shutdown() {
    this.closing = true; clearInterval(this.timer);
    await this._terminateAll([...this.peers.values()]);
  }
}

module.exports = {WebRTCManager};
