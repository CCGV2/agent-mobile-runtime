'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {randomBytes, createHash} = require('node:crypto');
const {fail} = require('./errors.cjs');

const digest = value => createHash('sha256').update(value).digest('hex');
const COOKIE = 'agent_mobile_operator';

class Viewer {
  constructor({now = Date.now} = {}) {
    this.now = now;
    this.codes = new Map();
    this.sessions = new Map();
  }

  prune() {
    for (const store of [this.codes, this.sessions]) for (const [key, expires] of store) if (expires <= this.now()) store.delete(key);
  }

  cookie(req) {
    const matches = (req.headers.cookie || '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
    if (matches.length !== 1) return null;
    const value = matches[0].slice(COOKIE.length + 1);
    return /^[a-f0-9]{64}$/.test(value) ? value : null;
  }

  authenticated(req) {
    return this.identity(req) !== null;
  }

  identity(req) {
    this.prune();
    const token = this.cookie(req);
    return token && this.sessions.has(digest(token)) ? `viewer:${digest(token)}` : null;
  }

  hasIdentity(identity) { this.prune(); return typeof identity === 'string' && identity.startsWith('viewer:') && this.sessions.has(identity.slice(7)); }

  invalidate(req, res) {
    const identity = this.identity(req);
    // Revoke synchronously, before any asynchronous peer teardown. Otherwise a
    // second request can open a new peer after closeOwner took its snapshot.
    if (identity) this.sessions.delete(identity.slice(7));
    res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return identity;
  }

  async handle(req, res, pathname, {body, json, admin, revoke = async () => {}}) {
    this.prune();
    const files = {'/': ['index.html', 'text/html; charset=utf-8'], '/viewer.js': ['app.js', 'text/javascript; charset=utf-8'], '/viewer.css': ['style.css', 'text/css; charset=utf-8']};
    if (Object.hasOwn(files, pathname) && ['GET', 'HEAD'].includes(req.method)) {
      const [filename, mime] = files[pathname];
      const bytes = await fs.readFile(path.join(__dirname, '..', 'viewer', filename));
      res.writeHead(200, {
        'content-type': mime, 'content-length': bytes.length, 'cache-control': 'no-store',
        'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
        'permissions-policy': 'camera=(), microphone=(), geolocation=(), display-capture=()',
        'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
      return true;
    }
    if (pathname === '/v1/admin/viewer-login' && req.method === 'POST') {
      // Only the node-held operator bearer credential may mint a login link.
      // A session MCP credential or ambient browser cookie cannot mint one.
      if (!admin) fail('unauthorized', 'Operator authentication required.', 401);
      const value = await body(req);
      if (!value || Array.isArray(value) || typeof value !== 'object' || Object.keys(value).length) fail('invalid_arguments', 'No login arguments are accepted.');
      if (this.codes.size >= 16) fail('login_capacity', 'Too many pending operator logins.', 429);
      const code = randomBytes(32).toString('base64url');
      const expires = this.now() + 120000;
      this.codes.set(digest(code), expires);
      json(res, 200, {code, expiresAt: new Date(expires).toISOString()});
      return true;
    }
    if (pathname === '/viewer/login' && req.method === 'POST') {
      const value = await body(req);
      this.prune();
      if (!value || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.code)) fail('unauthorized', 'Operator login is invalid or expired.', 401);
      const key = digest(value.code);
      if (!this.codes.delete(key)) fail('unauthorized', 'Operator login is invalid or expired.', 401);
      const previous = this.identity(req);
      if (previous) {
        this.invalidate(req, res);
        await revoke(previous);
      }
      // Other logins may have completed while a replaced identity's media was
      // being revoked. Failure never restores the old identity or issues a new one.
      if (this.sessions.size >= 8) fail('login_capacity', 'Too many active operator logins.', 429);
      const token = randomBytes(32).toString('hex');
      this.sessions.set(digest(token), this.now() + 1800000);
      res.setHeader('set-cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800`);
      json(res, 200, {ok: true});
      return true;
    }
    if (pathname === '/viewer/logout' && req.method === 'POST') {
      const previous = this.invalidate(req, res);
      if (previous) await revoke(previous);
      json(res, 200, {ok: true});
      return true;
    }
    return false;
  }
}

module.exports = {Viewer};
