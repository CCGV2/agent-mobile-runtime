'use strict';

const {readPrivate} = require('./storage.cjs');

class ControlClient {
  constructor({port, token, sessionId}) {
    this.origin = `http://127.0.0.1:${port}`;
    this.token = token;
    this.sessionId = sessionId;
  }
  async request(route, {method = 'GET', body, signal, binary = false} = {}) {
    if (!route.startsWith('/v1/') || route.includes('?') || route.includes('#')) throw new Error('Invalid local route.');
    const response = await fetch(this.origin + route, {
      method, redirect: 'error', signal: signal || AbortSignal.timeout(660000),
      headers: {authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : {'content-type': 'application/json'})},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
      let code = 'request_failed', message = 'Request failed; inspect device state before retrying.';
      try { const value = await response.json(); code = value.error.code; message = value.error.message; } catch {}
      const error = new Error(message); error.code = code; error.public = true; throw error;
    }
    if (binary) {
      const length = Number(response.headers.get('content-length'));
      if (!Number.isSafeInteger(length) || length < 1 || length > 8*1024*1024) {
        await response.body?.cancel();
        const error = new Error('Artifact exceeds the 8 MiB MCP transfer limit; use the authenticated operator artifact API.');
        error.public = true; throw error;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.length !== length) throw new Error('Incomplete artifact.');
      return {buffer, mime: response.headers.get('content-type')};
    }
    return response.json();
  }
  action(action, args = {}, {signal} = {}) {
    return this.request(`/v1/sessions/${this.sessionId}/action`, {method: 'POST', body: {action, args}, signal});
  }
  static async session(config, filename) {
    const value = JSON.parse(await readPrivate(filename));
    if (value.schema !== 1 || !/^m-[a-f0-9-]{36}$/.test(value.sessionId || '') || !/^[a-f0-9]{64}$/.test(value.token || '')) throw new Error('Invalid session credential file.');
    return new ControlClient({port: config.controlPort, token: value.token, sessionId: value.sessionId});
  }
}

module.exports = {ControlClient};
