'use strict';

const http = require('node:http');
const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const {RuntimeError, fail, publicError} = require('./errors.cjs');
const {identifier} = require('./runtime.cjs');
const {validateAction, validate} = require('./actions.cjs');
const {Viewer} = require('./viewer.cjs');
const {createHash} = require('node:crypto');

function json(res, status, value) {
  res.writeHead(status, {'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
  res.end(JSON.stringify(value));
}

async function body(req, maxBytes = 16384) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail('content_type', 'Use application/json.', 415);
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) fail('payload_too_large', 'Request exceeds size limit.', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('invalid_json', 'Invalid JSON.'); }
}

function pngResult(buffer) {
  return {mime: 'image/png', data: buffer.toString('base64'), width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)};
}

async function sendArtifact(req, res, runtime, sessionId, recordingId, operator) {
  const info = await runtime.artifact(sessionId, recordingId, {operator});
  const handle = await fs.open(info.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > runtime.config.artifactMaxBytes) fail('invalid_artifact', 'Artifact unavailable.', 409);
    let start = 0, end = stat.size - 1, partial = false;
    if (req.headers.range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
      if (!match || (!match[1] && !match[2])) fail('invalid_range', 'Only one byte range is supported.', 416);
      if (!match[1]) { start = Math.max(0, stat.size - Number(match[2])); }
      else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= stat.size) fail('invalid_range', 'Range outside artifact.', 416);
      partial = true;
    }
    const headers = {'content-type': info.mime, 'content-length': end-start+1, 'accept-ranges': 'bytes', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-disposition': `inline; filename="${recordingId}.${info.mime.startsWith('audio/') ? 'opus' : 'mkv'}"`};
    if (partial) headers['content-range'] = `bytes ${start}-${end}/${stat.size}`;
    res.writeHead(partial ? 206 : 200, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = handle.createReadStream({start, end, autoClose: false});
    await new Promise((resolve, reject) => {
      stream.on('error', reject);
      res.once('close', () => { stream.destroy(); resolve(); });
      res.once('finish', resolve);
      stream.pipe(res);
    });
  } finally { await handle.close(); }
}

function createServer({runtime, provisioner}) {
  const port = runtime.config.controlPort;
  const expectedHost = `127.0.0.1:${port}`;
  const streams = new Map();
  const viewer = new Viewer();
  const adminIdentity = `admin:${createHash('sha256').update(runtime.adminToken || '').digest('hex')}`;
  runtime.webrtc?.setOwnerValidator(owner => owner === adminIdentity || viewer.hasIdentity(owner));
  const server = http.createServer(async (req, res) => {
    try {
      if (req.headers.host !== expectedHost || (req.headers.origin && req.headers.origin !== `http://${expectedHost}`)) fail('origin_denied', 'Only the local control origin is accepted.', 403);
      const url = new URL(req.url, `http://${expectedHost}`);
      if (url.search) fail('invalid_request', 'Query parameters are not supported.');
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, {ok: !runtime.closing, protocolVersion: 1});
      const bearer = /^Bearer ([a-zA-Z0-9]+)$/.exec(req.headers.authorization || '')?.[1];
      const operatorBearer = runtime.authorizeAdmin(bearer);
      const viewerIdentity = viewer.identity(req);
      if (['/viewer/logout', '/viewer/login'].includes(url.pathname) && req.method === 'POST' && viewerIdentity) {
        if (req.headers.origin !== `http://${expectedHost}`) fail('origin_denied', 'Browser identity changes require the local browser origin.', 403);
      }
      if (await viewer.handle(req, res, url.pathname, {body, json, admin: operatorBearer, revoke: owner => runtime.closeLiveOwner?.(owner)})) return;
      const parts = url.pathname.split('/').filter(Boolean);
      const admin = parts[0] === 'v1' && parts[1] === 'admin';
      if (admin && !(operatorBearer || viewer.authenticated(req))) fail('unauthorized', 'Operator authentication required.', 401);
      if (admin && parts.length === 3 && parts[2] === 'templates' && req.method === 'GET') return json(res, 200, await provisioner.listTemplates());
      if (admin && parts.length === 3 && parts[2] === 'sessions') {
        if (req.method === 'GET') return json(res, 200, runtime.list());
        if (req.method === 'POST') {
          const value = await body(req);
          validate({type: 'object', properties: {template: {type: 'string', minLength: 1, maxLength: 48}, key: {type: 'string', minLength: 1, maxLength: 200}}, required: ['template']}, value);
          return json(res, 201, await runtime.createSession(value));
        }
      }
      if (admin && parts[2] === 'sessions' && parts[4] === 'live') {
        if (!operatorBearer && req.headers.origin !== `http://${expectedHost}`) fail('origin_denied', 'Live preview requires the exact browser origin.', 403);
        const id = parts[3];
        if (!identifier(id) || req.method !== 'POST' || url.pathname.includes('%') || url.pathname.includes('//')) fail('not_found', 'Live endpoint not found.', 404);
        const owner = operatorBearer ? adminIdentity : viewerIdentity;
        if (!owner) fail('unauthorized', 'Operator authentication required.', 401);
        if (parts.length === 5) {
          const value = await body(req, 65536);
          validate({type: 'object', properties: {offer: {type: 'string', minLength: 1, maxLength: 49152}}, required: ['offer']}, value);
          return json(res, 200, await runtime.live(id, 'open', owner, value));
        }
        if (parts.length === 7 && /^[a-f0-9-]{36}$/.test(parts[5]) && ['renew', 'close'].includes(parts[6])) {
          const value = await body(req);
          validate({type: 'object', properties: {}}, value);
          return json(res, 200, await runtime.live(id, parts[6], owner, {id: parts[5]}));
        }
        fail('not_found', 'Live endpoint not found.', 404);
      }
      let sessionId, endpoint, recordingId;
      if (admin && parts[2] === 'sessions' && parts.length >= 4) {
        sessionId = parts[3]; endpoint = parts[4]; recordingId = parts[5];
      } else if (parts[0] === 'v1' && parts[1] === 'sessions' && parts.length >= 3) {
        sessionId = parts[2]; endpoint = parts[3]; recordingId = parts[4];
        if (!runtime.authorizeSession(sessionId, bearer)) fail('unauthorized', 'Session authentication required.', 401);
      } else fail('not_found', 'Endpoint not found.', 404);
      if (!identifier(sessionId) || parts.length > (admin ? 6 : 5)) fail('not_found', 'Endpoint not found.', 404);
      if (admin && !endpoint && req.method === 'DELETE') {
        for (const response of streams.get(sessionId) || []) response.destroy();
        return json(res, 200, await runtime.destroySession(sessionId));
      }
      if (endpoint === 'state' && !recordingId && req.method === 'GET') return json(res, 200, runtime.state(sessionId));
      if (endpoint === 'action' && !recordingId && req.method === 'POST') {
        const value = await body(req);
        validate({type: 'object', properties: {action: {type: 'string', minLength: 1, maxLength: 40}, args: {}}, required: ['action']}, value);
        validateAction(value.action, value.args || {});
        if (admin && value.action === 'takeover') for (const response of streams.get(sessionId) || []) response.destroy();
        const result = await runtime.execute(sessionId, value.action, value.args, {operator: admin});
        return json(res, 200, Buffer.isBuffer(result) ? pngResult(result) : result);
      }
      if (endpoint === 'artifacts' && /^[a-f0-9-]{36}$/.test(recordingId || '') && ['GET', 'HEAD'].includes(req.method)) {
        let set = streams.get(sessionId); if (!set) streams.set(sessionId, set = new Set());
        set.add(res);
        try { await sendArtifact(req, res, runtime, sessionId, recordingId, admin); }
        finally { set.delete(res); if (!set.size) streams.delete(sessionId); }
        return;
      }
      fail('not_found', 'Endpoint not found.', 404);
    } catch (error) {
      if (res.headersSent) res.destroy();
      else json(res, error instanceof RuntimeError ? error.status : 500, {error: publicError(error)});
    }
  });
  server.requestTimeout = runtime.config.bootTimeoutMs + 30000;
  server.headersTimeout = 10000;
  server.maxRequestsPerSocket = 1000;
  server.on('clientError', (_error, socket) => socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'));
  return server;
}

module.exports = {createServer, pngResult};
