'use strict';

const net = require('node:net');
const fs = require('node:fs/promises');
const path = require('node:path');
const {constants} = require('node:fs');
const {createHash} = require('node:crypto');
const {serveMCP} = require('./mcp.cjs');
const {RuntimeError, publicError, fail} = require('./errors.cjs');

const MAX_HANDSHAKE = 16384;
const MAX_ARTIFACT = 8 * 1024 * 1024;
const SESSION_ID = /^m-[a-f0-9-]{36}$/;
const TEMPLATE = /^[a-z][a-z0-9-]{0,47}$/;

function brokerSocketPath(config) {
  if (!path.isAbsolute(config?.dataDir || '') || typeof process.getuid !== 'function') throw new Error('A private absolute runtime directory on macOS or Linux is required.');
  const digest = createHash('sha256').update(path.resolve(config.dataDir)).digest('hex').slice(0, 24);
  // A data-directory socket can exceed macOS's sockaddr_un limit. The short,
  // deterministic namespace remains private to the service OS user.
  return path.join(process.platform === 'darwin' ? '/private/tmp' : '/tmp', `agent-mobile-${process.getuid()}-${digest}`, 'mcp.sock');
}

async function ownedDirectory(directory, create = false) {
  if (create) {
    try { await fs.mkdir(directory, {mode: 0o700}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || info.mode & 0o077) throw new Error('MCP broker directory must be owned and private.');
}

async function validateBrokerEndpoint(config) {
  const filename = brokerSocketPath(config);
  await ownedDirectory(path.dirname(filename));
  const info = await fs.lstat(filename);
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600) throw new Error('MCP broker socket must be owned and private.');
  return filename;
}

async function clearStaleBroker(config) {
  const filename = brokerSocketPath(config);
  try { await ownedDirectory(path.dirname(filename)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let info;
  try { await validateBrokerEndpoint(config); info = await fs.lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const active = await new Promise((resolve, reject) => {
    const socket = net.connect(filename);
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Cannot confirm that the MCP broker socket is stale.')); }, 1000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', error => {
      clearTimeout(timer); socket.destroy();
      if (['ECONNREFUSED', 'ENOENT'].includes(error.code)) resolve(false);
      else reject(new Error('Cannot confirm that the MCP broker socket is stale.'));
    });
  });
  if (active) throw new Error('MCP broker is still active; refusing to remove its socket.');
  const current = await fs.lstat(filename);
  if (current.ino !== info.ino || current.dev !== info.dev) throw new Error('MCP broker socket changed during recovery.');
  await fs.unlink(filename);
  await fs.rmdir(path.dirname(filename)).catch(error => { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; });
}

function handshake(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail('invalid_attach', 'Invalid MCP attachment.');
  const keys = Object.keys(value);
  if (value.mode === 'key') {
    if (keys.some(key => !['mode', 'key', 'template'].includes(key)) || typeof value.key !== 'string' || !value.key.length || value.key.length > 200 || /[\x00-\x1f\x7f]/.test(value.key) || !TEMPLATE.test(value.template || '')) fail('invalid_attach', 'A bounded session key and configured template are required.');
  } else if (value.mode === 'session') {
    if (keys.some(key => !['mode', 'sessionId', 'token'].includes(key)) || !SESSION_ID.test(value.sessionId || '') || !/^[a-f0-9]{64}$/.test(value.token || '')) fail('invalid_attach', 'Invalid private session attachment.');
  } else fail('invalid_attach', 'Unsupported MCP attachment mode.');
  return value;
}

function boundClient(runtime, id, expectedTokenHash) {
  if (!/^[a-f0-9]{64}$/.test(expectedTokenHash || '')) fail('unauthorized', 'Private session authentication required.', 401);
  const visible = async operation => {
    try { return await operation(); }
    catch (error) {
      // Match ControlClient's HTTP error contract. Only deliberate runtime
      // errors are public; filesystem/child-process messages stay private.
      if (error instanceof RuntimeError) error.public = true;
      throw error;
    }
  };
  return {
    sessionId: id,
    action(action, args) { return visible(async () => {
      // Cancellation cannot undo a dispatched Android input. Wait for the real
      // runtime promise so disconnect fencing is based on actual completion.
      const result = await runtime.execute(id, action, args, {expectedTokenHash});
      return Buffer.isBuffer(result) ? {mime: 'image/png', data: result.toString('base64')} : result;
    }); },
    request(route, options) { return visible(async () => {
      const prefix = `/v1/sessions/${id}/artifacts/`;
      const recordingId = route.startsWith(prefix) ? route.slice(prefix.length) : '';
      if (!options?.binary || !/^[a-f0-9-]{36}$/.test(recordingId)) fail('invalid_artifact', 'Only this session’s completed recordings are available.');
      const artifact = await runtime.artifact(id, recordingId, {expectedTokenHash});
      const handle = await fs.open(artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARTIFACT) fail('artifact_too_large', 'Artifact exceeds the 8 MiB MCP transfer limit; use the authenticated operator artifact API.');
        const buffer = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < buffer.length) {
          const {bytesRead} = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (!bytesRead) throw new Error('Incomplete artifact.');
          offset += bytesRead;
        }
        if ((await handle.stat()).size !== stat.size) throw new Error('Artifact changed while reading.');
        return {buffer, mime: artifact.mime};
      } finally { await handle.close(); }
    }); },
  };
}

function createMCPBroker({runtime, config = runtime.config, graceMs = config.mcpGraceMs ?? 300000}) {
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 3600000) throw new Error('Invalid MCP session grace period.');
  const socketPath = brokerSocketPath(config);
  const entries = new Map();
  const sockets = new Set(), attaching = new Set(), cleanups = new Set();
  let closing = false, listening = false;

  const exists = id => runtime.sessions.has(id);
  function entryFor(id, managed) {
    let entry = entries.get(id);
    if (!entry) { entry = {id, managed, status: 'idle', owner: null, timer: null}; entries.set(id, entry); }
    return entry;
  }
  function retire(entry) {
    if (closing || entries.get(entry.id) !== entry || ['retiring', 'blocked'].includes(entry.status)) return;
    clearTimeout(entry.timer); entry.timer = null; entry.status = 'retiring';
    const cleanup = Promise.resolve().then(() => runtime.destroySession(entry.id)).then(() => {
      if (entries.get(entry.id) === entry) entries.delete(entry.id);
    }, () => {
      // Do not release the device slot or pretend uncertain termination worked.
      if (entries.get(entry.id) === entry) entry.status = 'blocked';
    });
    cleanups.add(cleanup);
    cleanup.finally(() => cleanups.delete(cleanup));
  }
  function retain(entry) {
    if (closing || entries.get(entry.id) !== entry || entry.owner || ['retiring', 'blocked'].includes(entry.status)) return;
    clearTimeout(entry.timer);
    if (!entry.managed) { entries.delete(entry.id); return; }
    entry.status = 'idle';
    entry.timer = setTimeout(() => retire(entry), graceMs);
    entry.timer.unref();
  }

  const server = net.createServer(socket => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0), claimed, mcp, detached = false;
    const reject = error => {
      if (!socket.destroyed) {
        socket.end(JSON.stringify({error: publicError(error)})+'\n');
        socket.destroySoon();
      }
    };
    const disconnected = () => {
      if (detached) return;
      detached = true;
      mcp?.close();
    };
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); disconnected(); });
    const timer = setTimeout(() => { reject(new RuntimeError('attach_timeout', 'MCP attachment timed out.')); socket.destroySoon(); }, 5000);
    timer.unref();
    socket.once('close', () => clearTimeout(timer));
    async function attach(value, remainder) {
      const request = handshake(value);
      let assigned;
      if (request.mode === 'key') assigned = await runtime.ensureSession({key: request.key, template: request.template});
      else {
        if (!runtime.authorizeSession(request.sessionId, request.token)) fail('unauthorized', 'Private session authentication required.', 401);
        assigned = {...runtime.state(request.sessionId), managed: runtime.sessions.get(request.sessionId)?.mcpManaged === true,
          expectedTokenHash: createHash('sha256').update(request.token).digest('hex')};
      }
      let entry = entries.get(assigned.id);
      if (entry && !exists(entry.id)) { clearTimeout(entry.timer); entries.delete(entry.id); entry = null; }
      entry = entry || entryFor(assigned.id, assigned.managed === true);
      if (closing || socket.destroyed || detached) { if (!entry.owner) retain(entry); return; }
      if (entry.owner || ['draining', 'retiring', 'blocked'].includes(entry.status)) fail('session_connected', 'Session is already connected or still being reconciled.', 409);
      let client;
      try { client = boundClient(runtime, assigned.id, assigned.expectedTokenHash); }
      catch (error) { retain(entry); throw error; }
      clearTimeout(entry.timer); entry.timer = null;
      const owner = {};
      entry.owner = owner; entry.status = 'active'; claimed = entry;
      socket.write(JSON.stringify({attached: true, sessionId: assigned.id})+'\n');
      mcp = serveMCP({client, input: socket, output: socket,
        onClose({pending}) {
          if (entries.get(entry.id) !== entry || entry.owner !== owner) return;
          if (closing) { entry.owner = null; return; }
          if (pending) {
            if (entry.managed) retire(entry);
            else entry.status = 'draining';
          } else { entry.owner = null; retain(entry); }
          if (!socket.destroyed) socket.destroy();
        },
        onIdle() {
          if (entries.get(entry.id) !== entry || entry.owner !== owner || entry.status !== 'draining') return;
          entry.owner = null; retain(entry);
        },
      });
      if (remainder.length) socket.unshift(remainder);
      socket.resume();
    }
    const first = chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf(10);
      if (end < 0) {
        if (buffer.length > MAX_HANDSHAKE) { clearTimeout(timer); reject(new RuntimeError('invalid_attach', 'MCP attachment exceeds size limit.')); socket.destroySoon(); }
        return;
      }
      socket.pause(); socket.off('data', first); clearTimeout(timer);
      if (end > MAX_HANDSHAKE) { reject(new RuntimeError('invalid_attach', 'MCP attachment exceeds size limit.')); socket.destroySoon(); return; }
      let value;
      try { value = JSON.parse(buffer.subarray(0, end).toString('utf8')); }
      catch { reject(new RuntimeError('invalid_attach', 'Invalid MCP attachment.')); socket.destroySoon(); return; }
      const pending = attach(value, buffer.subarray(end + 1)).catch(error => {
        // A rejected second attachment must never release the first owner.
        if (claimed) disconnected();
        reject(error);
      });
      attaching.add(pending);
      pending.finally(() => attaching.delete(pending));
    };
    socket.on('data', first);
  });

  return {
    socketPath,
    async listen() {
      if (closing || listening) throw new Error('MCP broker cannot be started twice.');
      await ownedDirectory(path.dirname(socketPath), true);
      const old = process.umask(0o077);
      let ready;
      try {
        ready = new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
      } finally { process.umask(old); }
      await ready;
      await fs.chmod(socketPath, 0o600);
      await validateBrokerEndpoint(config);
      listening = true;
      for (const session of runtime.listManagedSessions()) retain(entryFor(session.id, true));
    },
    async close() {
      if (closing) return;
      closing = true;
      for (const entry of entries.values()) clearTimeout(entry.timer);
      for (const socket of sockets) socket.destroy();
      if (listening) await new Promise(resolve => server.close(resolve));
      await Promise.allSettled([...attaching, ...cleanups]);
      await fs.rmdir(path.dirname(socketPath)).catch(error => { if (!['ENOTEMPTY', 'ENOENT'].includes(error.code)) throw error; });
    },
  };
}

module.exports = {createMCPBroker, brokerSocketPath, clearStaleBroker, validateBrokerEndpoint};
