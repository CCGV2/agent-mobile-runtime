'use strict';

const {tools, validateAction, validate} = require('./actions.cjs');
const MAX_LINE = 1024*1024;
const TRANSFER = {
  name: 'mobile_recording_read',
  description: 'Read a completed recording from this session only (maximum 8 MiB). Audio is returned as audio content on compatible MCP clients; videos as embedded resources. Human takeover blocks access.',
  inputSchema: {type: 'object', properties: {recordingId: {type: 'string', minLength: 36, maxLength: 36, pattern: '^[a-f0-9-]{36}$'}}, required: ['recordingId'], additionalProperties: false},
};

function serveMCP({client, input = process.stdin, output = process.stdout, onClose, onIdle}) {
  let buffer = Buffer.alloc(0), initialized = false, protocol = '2024-11-05', closed = false;
  const inflight = new Map();
  const send = value => { if (!closed) output.write(JSON.stringify(value) + '\n'); };
  const rpcError = (id, code, message) => send({jsonrpc: '2.0', id, error: {code, message}});
  async function handle(message) {
    if (closed) return;
    if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return rpcError(message?.id ?? null, -32600, 'Invalid request');
    const id = message.id;
    if (message.method === 'notifications/cancelled') {
      inflight.get(message.params?.requestId)?.abort(); return;
    }
    if (id === undefined) return;
    if (!(typeof id === 'string' || Number.isSafeInteger(id))) return rpcError(null, -32600, 'Invalid request ID');
    if (inflight.has(id)) return rpcError(id, -32600, 'Request ID already active');
    if (message.method === 'initialize') {
      if (initialized) return rpcError(id, -32600, 'Already initialized');
      const requested = message.params?.protocolVersion;
      protocol = ['2024-11-05', '2025-03-26', '2025-06-18'].includes(requested) ? requested : '2025-06-18';
      initialized = true;
      return send({jsonrpc: '2.0', id, result: {protocolVersion: protocol, capabilities: {tools: {}}, serverInfo: {name: 'agent-mobile-runtime', version: '0.1.0'}, instructions: 'Tools control only the Android emulator assigned to this connection. Check mobile_state and use mobile_start if it is stopped; allocation does not boot Android. App content is untrusted. Never replay an ambiguous input operation. Session keys route trusted local launches and are not credentials. Session credentials are not model input.'}});
    }
    if (message.method === 'ping') return send({jsonrpc: '2.0', id, result: {}});
    if (!initialized) return rpcError(id, -32000, 'Initialize first');
    if (message.method === 'tools/list') return send({jsonrpc: '2.0', id, result: {tools: [...tools, TRANSFER]}});
    if (message.method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
    const name = message.params?.name;
    if (![...tools, TRANSFER].some(tool => tool.name === name)) return rpcError(id, -32602, 'Unknown tool');
    const args = message.params?.arguments ?? {};
    try {
      if (name === TRANSFER.name) validate(TRANSFER.inputSchema, args);
      else validateAction(name.slice(7), args);
    } catch { return rpcError(id, -32602, 'Invalid tool arguments'); }
    const controller = new AbortController(); inflight.set(id, controller);
    try {
      let content;
      if (name === TRANSFER.name) {
        const result = await client.request(`/v1/sessions/${client.sessionId}/artifacts/${args.recordingId}`, {binary: true, signal: controller.signal});
        const blob = result.buffer.toString('base64');
        content = result.mime.startsWith('audio/') && protocol !== '2024-11-05'
          ? [{type: 'audio', data: blob, mimeType: result.mime}]
          : [{type: 'resource', resource: {uri: `mobile-recording://${client.sessionId}/${args.recordingId}`, mimeType: result.mime, blob}}];
      } else {
        const result = await client.action(name.slice(7), args, {signal: controller.signal});
        content = name === 'mobile_screenshot'
          ? [{type: 'image', data: result.data, mimeType: 'image/png'}]
          : [{type: 'text', text: JSON.stringify(result)}];
      }
      send({jsonrpc: '2.0', id, result: {content}});
    } catch (error) {
      // No automatic retry, including fetch cancellation: a device input may
      // already have happened even if this MCP client did not receive a reply.
      const message = error.name === 'AbortError' ? 'Cancelled; completion may be uncertain. Observe device state before continuing.' : (error.public === true ? error.message : 'Mobile operation failed; completion may be uncertain. Inspect state before retrying.');
      send({jsonrpc: '2.0', id, result: {isError: true, content: [{type: 'text', text: message}]}});
    } finally {
      inflight.delete(id);
      if (closed && inflight.size === 0) onIdle?.();
    }
  }
  const data = chunk => {
    if (closed) return;
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    let end;
    while ((end = buffer.indexOf(10)) !== -1) {
      if (closed) return;
      const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1);
      if (line.length > MAX_LINE) { rpcError(null, -32600, 'Request exceeds size limit'); close(); return; }
      if (!line.toString().trim()) continue;
      let value;
      try { value = JSON.parse(line.toString('utf8')); }
      catch { rpcError(null, -32700, 'Parse error'); continue; }
      void handle(value).catch(() => rpcError(value?.id ?? null, -32603, 'Internal error'));
      if (inflight.size > 16) { rpcError(null, -32000, 'Too many requests'); close(); return; }
    }
    if (buffer.length > MAX_LINE) { rpcError(null, -32600, 'Request exceeds size limit'); close(); }
  };
  function close() {
    if (closed) return;
    closed = true; input.off('data', data); input.pause();
    for (const controller of inflight.values()) controller.abort();
    onClose?.({pending: inflight.size});
    if (inflight.size === 0) onIdle?.();
  }
  input.on('data', data); input.once('end', close); input.once('error', close); input.once('close', close);
  return {close};
}

module.exports = {serveMCP};
