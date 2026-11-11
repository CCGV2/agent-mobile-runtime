'use strict';

const os = require('node:os');
const net = require('node:net');
const {createHash} = require('node:crypto');

const MAX_SDP = 48 * 1024;
const MAX_LINE = 2048;
const MAX_CANDIDATES = 32;
const UUID_MDNS = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local$/i;
const ICE_CHARS = /^[A-Za-z0-9+/]+$/;
const FINGERPRINT_BYTES = {'sha-256': 32, 'sha-384': 48, 'sha-512': 64};

function reject(reason) { throw new Error(`WebRTC SDP rejected: ${reason}`); }

function canonicalAddress(value) {
  if (typeof value !== 'string' || value.includes('%')) return null;
  const family = net.isIP(value);
  if (family === 4) {
    const octets = value.split('.').map(Number);
    if (octets[0] === 169 && octets[1] === 254) return null;
    if (octets[0] >= 224 || octets.every(part => part === 0)) return null;
    return value;
  }
  if (family === 6) {
    // IPv4-mapped/compatible spellings make allowlists ambiguous. Browser host
    // candidates must use the ordinary IPv4 form for those interfaces.
    if (value.includes('.')) return null;
    const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    if (canonical === '::' || canonical.startsWith('::ffff:') || /^fe[89ab]/.test(canonical) || canonical.startsWith('ff')) return null;
    if (canonical !== '::1' && /^::(?:[0-9a-f]{1,4}:)?[0-9a-f]{1,4}$/.test(canonical)) return null;
    return canonical;
  }
  return null;
}

function localAddresses() {
  const addresses = new Set(['127.0.0.1', '::1']);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      const address = canonicalAddress(entry.address);
      if (address) addresses.add(address);
    }
  }
  return [...addresses].sort();
}

function decimal(value, min, max) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value) || value.length > 10) reject('invalid numeric field');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) reject('numeric field outside policy');
  return number;
}

function once(scope, key, value) {
  if (scope.has(key)) reject('duplicate negotiation attribute');
  scope.set(key, value);
}

function connection(line, allowed) {
  const match = /^c=IN (IP4|IP6) ([^ ]+)$/.exec(line);
  if (!match) reject('invalid connection address');
  const [, family, value] = match;
  if ((family === 'IP4' && value === '0.0.0.0') || (family === 'IP6' && value === '::')) return;
  const canonical = canonicalAddress(value);
  if (!canonical || net.isIP(value) !== (family === 'IP4' ? 4 : 6) || !allowed.has(canonical)) reject('nonlocal connection address');
}

function fingerprint(scope, value) {
  const match = /^(sha-256|sha-384|sha-512) ((?:[0-9A-Fa-f]{2}:)*[0-9A-Fa-f]{2})$/.exec(value);
  if (!match || match[2].split(':').length !== FINGERPRINT_BYTES[match[1]]) reject('weak or malformed DTLS fingerprint');
  once(scope, `fingerprint:${match[1]}`, match[2].toUpperCase());
}

function effective(scope, session, key) {
  const local = scope.get(key); const inherited = session.get(key);
  if (local !== undefined && inherited !== undefined && local !== inherited) reject('conflicting negotiation attributes');
  return local ?? inherited;
}

function candidate(line, media, expandAddress) {
  const parts = line.slice('a=candidate:'.length).split(' ');
  if (parts.some(part => !part) || parts.length < 8 || (parts.length - 8) % 2) reject('malformed ICE candidate');
  const [foundation, component, protocol, priority, address, port, typ, kind] = parts;
  if (!/^[A-Za-z0-9+/]{1,32}$/.test(foundation) || component !== '1' || protocol.toLowerCase() !== 'udp' || typ !== 'typ' || kind !== 'host') reject('only UDP component-one host candidates are permitted');
  decimal(priority, 1, 0xffffffff);
  decimal(port, 32768, 65535);
  const seen = new Set();
  for (let index = 8; index < parts.length; index += 2) {
    const key = parts[index]; const value = parts[index + 1];
    if (seen.has(key)) reject('duplicate candidate extension');
    seen.add(key);
    if (key === 'generation') {
      if (value !== '0') reject('ICE restart is not permitted');
    } else if (key === 'network-id' || key === 'network-cost') decimal(value, 0, 65535);
    else if (key === 'ufrag') {
      if (!ICE_CHARS.test(value) || value.length < 4 || value.length > 256) reject('invalid candidate username');
      media.candidateUfrags.push(value);
    } else reject('unsupported candidate extension');
  }
  return expandAddress(address).map(resolved => {
    const output = [...parts];
    output[2] = 'UDP'; output[4] = resolved;
    if (UUID_MDNS.test(address)) {
      // Different base addresses need different ICE foundations. No name is
      // resolved: these are only the destinations the host already authorizes.
      output[0] = createHash('sha256').update(`${foundation}|${resolved}`).digest('hex').slice(0, 32);
    }
    return {key: `1|UDP|${resolved}|${port}`, line: `a=candidate:${output.join(' ')}`};
  });
}

async function sanitize(sdp, direction, options = {}) {
  if (typeof sdp !== 'string' || Buffer.byteLength(sdp) > MAX_SDP || !sdp.length) reject('invalid SDP size');
  if (/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/.test(sdp) || /\r(?!\n)/.test(sdp)) reject('control character');
  const lines = sdp.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.some(line => !line || line.length > MAX_LINE || line !== line.trim())) reject('invalid SDP line');
  if (lines[0] !== 'v=0') reject('unsupported SDP version');

  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'addresses')) reject('unsupported host address policy option');

  const addresses = options.addresses ?? localAddresses();
  if (!addresses || typeof addresses === 'string' || typeof addresses[Symbol.iterator] !== 'function') reject('invalid host address policy');
  const allowed = new Set();
  for (const value of addresses) {
    const address = canonicalAddress(value);
    if (!address) reject('invalid host address policy');
    allowed.add(address);
  }
  if (!allowed.size) reject('empty host address policy');
  const expandAddress = value => {
    const numeric = canonicalAddress(value);
    if (numeric) {
      if (!allowed.has(numeric)) reject('candidate is not a host-owned address');
      return [numeric];
    }
    if (!UUID_MDNS.test(value)) reject('candidate hostname is not permitted');
    if (direction !== 'recvonly') reject('worker answers require numeric candidates');
    // Chrome hides its local ICE addresses behind ephemeral UUID.local labels.
    // Those labels are opaque markers, not DNS inputs. Trying each exact host
    // interface at the already-authorized high port adds no destination beyond
    // what an explicit numeric candidate may name. No DNS/mDNS socket is opened.
    return [...allowed].sort();
  };

  const session = new Map(); const media = [];
  const transformed = [];
  let current = null; let candidateCount = 0;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      const match = /^m=(audio|video) ([0-9]+) UDP\/TLS\/RTP\/SAVPF ([0-9]+(?: [0-9]+)*)$/.exec(line);
      if (!match) reject('only audio and video RTP media are permitted');
      const port = decimal(match[2], 1, 65535);
      if (port !== 9 && port < 32768) reject('media port outside policy');
      const payloads = match[3].split(' ').map(value => decimal(value, 0, 127));
      if (payloads.length > 64 || new Set(payloads).size !== payloads.length) reject('invalid media payload list');
      current = {kind: match[1], startIndex: transformed.length, attributes: new Map(), payloads: new Set(payloads), candidates: 0, candidateKeys: new Set(), candidateUfrags: []};
      media.push(current);
      if (media.length > 2 || media.slice(0, -1).some(item => item.kind === current.kind)) reject('duplicate media section');
    } else if (line.startsWith('c=')) {
      connection(line, allowed); once(current?.attributes ?? session, 'connection', line);
    } else if (line.startsWith('a=candidate:')) {
      if (!current) reject('misplaced ICE candidate');
      for (const expanded of candidate(line, current, expandAddress)) {
        if (current.candidateKeys.has(expanded.key)) continue;
        if (++candidateCount > MAX_CANDIDATES) reject('candidate limit exceeded after normalization');
        current.candidateKeys.add(expanded.key); current.candidates++;
        transformed.push(expanded.line);
      }
      continue;
    } else if (line.startsWith('a=')) {
      const value = line.slice(2); const attrs = current?.attributes ?? session;
      if (/^(?:sendrecv|sendonly|recvonly|inactive)$/.test(value)) {
        if (value !== direction) reject('media direction is not permitted');
        once(attrs, 'direction', value);
      } else if (value.startsWith('ice-ufrag:') || value.startsWith('ice-pwd:')) {
        const colon = value.indexOf(':'); const key = value.slice(0, colon); const credential = value.slice(colon + 1);
        if (!ICE_CHARS.test(credential) || credential.length < (key === 'ice-pwd' ? 22 : 4) || credential.length > 256) reject('weak or malformed ICE credential');
        once(attrs, key, credential);
      } else if (value.startsWith('fingerprint:')) fingerprint(attrs, value.slice(12));
      else if (value.startsWith('setup:')) {
        const setup = value.slice(6);
        if (direction === 'recvonly' ? setup !== 'actpass' : !['active', 'passive'].includes(setup)) reject('invalid DTLS setup role');
        once(attrs, 'setup', setup);
      } else if (value.startsWith('mid:')) {
        if (!current || !/^[A-Za-z0-9_-]{1,32}$/.test(value.slice(4))) reject('invalid media identifier');
        once(attrs, 'mid', value.slice(4));
      } else if (value.startsWith('group:')) {
        if (current || !/^group:BUNDLE [A-Za-z0-9_-]{1,32} [A-Za-z0-9_-]{1,32}$/.test(value)) reject('only one bundled audio/video transport is permitted');
        once(session, 'bundle', value.slice(13).split(' '));
      } else if (value === 'rtcp-mux' || value === 'rtcp-mux-only' || value === 'rtcp-rsize' || value === 'end-of-candidates') {
        if (!current) reject('misplaced media attribute');
        once(attrs, value, true);
      } else if (value.startsWith('rtcp:')) {
        if (!current) reject('misplaced RTCP address');
        const match = /^rtcp:([0-9]+) IN (IP4|IP6) ([^ ]+)$/.exec(value);
        if (!match) reject('invalid RTCP address');
        const port = decimal(match[1], 1, 65535);
        if (port !== 9 && port < 32768) reject('RTCP port outside policy');
        connection(`c=IN ${match[2]} ${match[3]}`, allowed); once(attrs, 'rtcp', value);
      } else if (value === 'ice-options:trickle') once(attrs, 'ice-options', value);
      else if (value === 'extmap-allow-mixed') once(attrs, value, true);
      else if (value === 'rtcp-xr:rcvr-rtt=all' || value === 'rtcp-xr:rcvr-rtt=all:10000') {
        // Current Chrome advertises this optional RTCP reporting capability.
        // The receiver does not need XR: remove it instead of forwarding an
        // unsupported extension into the media library.
        if (!current) reject('misplaced RTCP reporting capability');
        continue;
      }
      else if (/^msid-semantic: ?WMS(?: [A-Za-z0-9_*.-]{1,128})*$/.test(value)) {
        if (current) reject('misplaced stream semantics'); once(session, 'msid-semantic', value);
      } else if (/^extmap:[0-9]+(?:\/(?:sendrecv|recvonly|sendonly|inactive))? [A-Za-z][A-Za-z0-9+.-]*:[\x21-\x7e]+(?: [\x20-\x7e]+)?$/.test(value)) {
        if (!current) reject('misplaced RTP extension');
        decimal(value.slice(7).split(/[ /]/)[0], 1, 255);
      } else if (/^rtpmap:([0-9]+) [A-Za-z0-9_.-]+\/[0-9]+(?:\/[0-9]+)?$/.test(value)) {
        if (!current) reject('misplaced RTP mapping');
        const match = /^rtpmap:([0-9]+) ([^/]+)\/([0-9]+)(?:\/([0-9]+))?$/.exec(value);
        if (!current.payloads.has(decimal(match[1], 0, 127))) reject('unknown RTP payload');
        decimal(match[3], 1, 192000); if (match[4]) decimal(match[4], 1, 8);
      } else if (/^(?:fmtp:[0-9]+ [\x20-\x7e]+|rtcp-fb:(?:[0-9]+|\*) [A-Za-z0-9 _-]+)$/.test(value)) {
        if (!current) reject('misplaced codec parameter');
        const payload = value.slice(value.indexOf(':') + 1).split(' ')[0];
        if (payload !== '*' && !current.payloads.has(decimal(payload, 0, 127))) reject('unknown codec payload');
      } else if (/^(?:ptime|maxptime):[0-9]+$/.test(value)) {
        if (!current) reject('misplaced packet time'); decimal(value.slice(value.indexOf(':') + 1), 1, 1000);
      } else if (/^(?:msid:[A-Za-z0-9_.-]{1,128} [A-Za-z0-9_.-]{1,128}|ssrc:[0-9]+ cname:[A-Za-z0-9+\/_=.-]{1,256}|ssrc-group:FID [0-9]+ [0-9]+)$/.test(value)) {
        if (!current || direction !== 'sendonly') reject('unexpected sending stream');
      } else reject('unsupported SDP attribute');
    } else if (line.startsWith('o=')) {
      if (current) reject('misplaced session origin');
      const match = /^o=[A-Za-z0-9_-]{1,64} [0-9]{1,20} [0-9]{1,20} IN (IP4|IP6) ([^ ]+)$/.exec(line);
      if (!match) reject('invalid session origin');
      connection(`c=IN ${match[1]} ${match[2]}`, allowed); once(session, 'origin', line);
    } else if (line.startsWith('s=')) {
      if (current || !/^s=[\x20-\x7e]{1,128}$/.test(line)) reject('invalid session name'); once(session, 'name', line);
    } else if (line === 't=0 0') {
      if (current) reject('misplaced session timing'); once(session, 'time', line);
    } else if (line === 'v=0') {
      if (transformed.length) reject('duplicate SDP version');
    } else reject('unsupported SDP line');
    transformed.push(line);
  }

  if (media.length !== 2 || new Set(media.map(item => item.kind)).size !== 2 || !session.has('origin') || !session.has('name') || !session.has('time')) reject('incomplete audio/video session');
  const mids = media.map(item => item.attributes.get('mid'));
  const bundle = session.get('bundle');
  if (mids.some(mid => !mid) || new Set(mids).size !== 2 || !bundle || bundle.length !== 2 || bundle.some(mid => !mids.includes(mid))) reject('invalid media bundle');
  const primary = media.find(item => item.attributes.get('mid') === bundle[0]);
  if (!primary?.candidates) reject('missing bundled ICE candidates');
  let credentials;
  for (const item of media) {
    const attrs = item.attributes;
    if (effective(attrs, session, 'direction') !== direction || !effective(attrs, session, 'setup') || !attrs.has('rtcp-mux') || !effective(attrs, session, 'connection')) reject('incomplete media transport');
    const ufrag = effective(attrs, session, 'ice-ufrag'); const pwd = effective(attrs, session, 'ice-pwd');
    if (!ufrag || !pwd || item.candidateUfrags.some(value => value !== ufrag)) reject('missing or mismatched ICE credential');
    const fingerprints = Object.keys(FINGERPRINT_BYTES).map(algorithm => [algorithm, effective(attrs, session, `fingerprint:${algorithm}`)]).filter(([, value]) => value);
    if (!fingerprints.length) reject('missing DTLS fingerprint');
    const currentCredentials = JSON.stringify({ufrag, pwd, fingerprints});
    if (credentials && currentCredentials !== credentials) reject('conflicting bundled transport credentials');
    credentials = currentCredentials;
  }
  // Chrome max-bundle places candidates only on the first bundled section.
  // After verifying identical ICE credentials/fingerprints above, copy ONLY the
  // already-validated primary candidates into a candidate-free secondary m-line
  // for the independently validating worker. No new destination is introduced.
  const primaryEnd = media[media.indexOf(primary) + 1]?.startIndex ?? transformed.length;
  const primaryCandidates = transformed.slice(primary.startIndex, primaryEnd).filter(line => line.startsWith('a=candidate:'));
  const finalCandidateCount = media.reduce((sum, item) => sum + (item.candidates || primaryCandidates.length), 0);
  if (finalCandidateCount > MAX_CANDIDATES) reject('candidate limit exceeded after BUNDLE completion');
  for (let index = media.length - 1; index >= 0; index--) {
    const item = media[index];
    if (!item.candidates) {
      const end = media[index + 1]?.startIndex ?? transformed.length;
      const endMarker = transformed.indexOf('a=end-of-candidates', item.startIndex);
      transformed.splice(endMarker !== -1 && endMarker < end ? endMarker : end, 0, ...primaryCandidates);
    }
  }
  const result = transformed.join('\r\n') + '\r\n';
  if (Buffer.byteLength(result) > MAX_SDP) reject('normalized SDP exceeds size limit');
  return result;
}

async function sanitizeOffer(sdp, options) { return sanitize(sdp, 'recvonly', options); }
async function sanitizeAnswer(sdp, options) { return sanitize(sdp, 'sendonly', options); }

module.exports = {localAddresses, sanitizeOffer, sanitizeAnswer};
