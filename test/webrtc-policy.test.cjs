'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const {localAddresses, sanitizeOffer, sanitizeAnswer} = require('../src/webrtc-policy.cjs');

const ADDRESSES = ['127.0.0.1', '::1', '192.168.1.20', '2001:db8::20'];
const HOST = 'a:candidate:1234 1 udp 2122260223 192.168.1.20 50000 typ host generation 0 network-id 1 network-cost 10 ufrag abcd';
const FINGERPRINT = 'a=fingerprint:sha-256 ' + Array(32).fill('A1').join(':');
const MDNS = 'cd1bfdf1-18b5-471c-97ae-bc94159e202b.local';

function sdp({direction = 'recvonly', candidate = HOST, connection = '0.0.0.0', extras = [], answer = false} = {}) {
  const lines = ['v=0', 'o=- 123456789 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1', 'a=extmap-allow-mixed', 'a=msid-semantic: WMS'];
  for (const [index, kind, payload, codec] of [[0, 'audio', 111, 'opus/48000/2'], [1, 'video', 96, 'VP8/90000']]) {
    lines.push(`m=${kind} 9 UDP/TLS/RTP/SAVPF ${payload}`, `c=IN IP4 ${connection}`, 'a=rtcp:9 IN IP4 0.0.0.0', `a=mid:${index}`, `a=${direction}`, 'a=rtcp-mux', 'a=rtcp-rsize', 'a=ice-ufrag:abcd', 'a=ice-pwd:abcdefghijklmnopqrstuvwx', 'a=ice-options:trickle', FINGERPRINT, `a=setup:${answer ? 'active' : 'actpass'}`, `a=rtpmap:${payload} ${codec}`, `a=rtcp-fb:${payload} transport-cc`, 'a=extmap:1 urn:ietf:params:rtp-hdrext:sdes:mid', candidate.replace(/^a:/, 'a='), 'a=end-of-candidates', ...extras);
    if (kind === 'audio') lines.push('a=fmtp:111 minptime=10;useinbandfec=1');
  }
  return lines.join('\r\n') + '\r\n';
}

const policy = overrides => ({addresses: ADDRESSES, ...overrides});

test('accepts a complete local audio/video receive-only browser offer', async () => {
  const result = await sanitizeOffer(sdp(), policy());
  assert.ok(result.includes('a=candidate:1234 1 UDP 2122260223 192.168.1.20 50000 typ host'));
  assert.ok(result.endsWith('\r\n'));
  assert.equal(result.match(/^m=/gm).length, 2);
});

test('handles current Chrome codec counts and strips only known optional RTCP XR reporting', async () => {
  const payloads = Array.from({length: 64}, (_, index) => String(index + 64)).join(' ');
  const offer = sdp({extras: ['a=rtcp-xr:rcvr-rtt=all']}).replace('m=video 9 UDP/TLS/RTP/SAVPF 96', `m=video 9 UDP/TLS/RTP/SAVPF ${payloads}`);
  const result = await sanitizeOffer(offer, policy());
  assert.ok(!result.includes('rtcp-xr'));
  await assert.rejects(sanitizeOffer(offer.replace('SAVPF ' + payloads, 'SAVPF 63 ' + payloads), policy()), /payload list/);
  await assert.rejects(sanitizeOffer(sdp({extras: ['a=rtcp-xr:http://example.com']}), policy()), /unsupported SDP/);
});

test('normalizes candidate-free secondary BUNDLE media only after checking transport identity', async () => {
  const [head, video] = sdp().split('m=video');
  const missingSecondary = head + 'm=video' + video.replace(/^a=candidate:.*\r\n/m, '');
  const normalized = await sanitizeOffer(missingSecondary, policy());
  assert.equal(normalized.match(/^a=candidate:/gm).length, 2);
  await assert.rejects(sanitizeOffer(missingSecondary.replace(/(m=video[\s\S]*?)a=ice-ufrag:abcd/, '$1a=ice-ufrag:efgh'), policy()), /conflicting bundled/);
  await assert.rejects(sanitizeOffer(sdp().replace(/^a=candidate:.*\r\n/gm, ''), policy()), /missing bundled/);
});

test('accepts send-only worker answer including strong multiple fingerprints and sending stream ids', async () => {
  const answer = sdp({direction: 'sendonly', answer: true, extras: [
    'a=fingerprint:sha-384 ' + Array(48).fill('B2').join(':'),
    'a=fingerprint:sha-512 ' + Array(64).fill('C3').join(':'),
    'a=msid:stream-1 track-1', 'a=ssrc:1234 cname:worker-1',
  ]});
  assert.match(await sanitizeAnswer(answer, policy()), /a=sendonly/);
  await assert.rejects(sanitizeOffer(answer, policy()), /direction/);
  await assert.rejects(sanitizeAnswer(sdp(), policy()), /direction/);
});

test('expands opaque UUID.local markers to exact trusted host addresses without resolving them', async () => {
  const offer = sdp({candidate: HOST.replace('192.168.1.20', MDNS)});
  const result = await sanitizeOffer(offer, policy());
  assert.ok(!result.includes('.local'));
  const candidates = result.split('\r\n').filter(line => line.startsWith('a=candidate:'));
  assert.equal(candidates.length, ADDRESSES.length * 2);
  for (const line of candidates) {
    const parts = line.slice('a=candidate:'.length).split(' ');
    assert.ok(ADDRESSES.includes(parts[4]));
    assert.equal(parts[1], '1'); assert.equal(parts[2], 'UDP'); assert.equal(parts[5], '50000');
    assert.ok(line.endsWith('generation 0 network-id 1 network-cost 10 ufrag abcd'));
  }
  const foundations = candidates.slice(0, ADDRESSES.length).map(line => line.split(' ')[0]);
  assert.equal(new Set(foundations).size, ADDRESSES.length);
});

test('performs no DNS lookup or multicast socket operation for UUID.local candidates', async t => {
  const dns = require('node:dns'); const dgram = require('node:dgram');
  const unexpected = () => { throw new Error('Network resolution is forbidden'); };
  t.mock.method(dns, 'lookup', unexpected);
  t.mock.method(dns.promises, 'lookup', unexpected);
  t.mock.method(dgram, 'createSocket', unexpected);
  const result = await sanitizeOffer(sdp({candidate: HOST.replace('192.168.1.20', MDNS)}), policy());
  assert.ok(!result.includes('.local'));
  assert.equal(result.match(/^a=candidate:/gm).length, 8);
  await assert.rejects(sanitizeOffer(sdp(), policy({resolveHost: unexpected})), /unsupported host address policy option/);
});

test('worker answers remain numeric-only and cannot introduce UUID.local candidates', async () => {
  await assert.rejects(sanitizeAnswer(sdp({direction: 'sendonly', answer: true, candidate: HOST.replace('192.168.1.20', MDNS)}), policy()), /require numeric candidates/);
});

test('never resolves arbitrary hostnames, URLs, zone ids, or numeric lookalikes', async () => {
  for (const address of ['metadata.google.internal', 'localhost', 'attacker.local', 'http://127.0.0.1', '127.1', '2130706433', '0177.0.0.1', '127.000.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1%en0']) {
    await assert.rejects(sanitizeOffer(sdp({candidate: HOST.replace('192.168.1.20', address)}), policy()));
  }
});

test('deduplicates expanded destinations across repeated markers and explicit numeric candidates', async () => {
  const marker = HOST.replace('192.168.1.20', MDNS).replace(/^a:/, 'a=');
  const otherMarker = marker.replace(MDNS, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.local');
  const offer = sdp({candidate: marker + '\r\n' + marker + '\r\n' + otherMarker + '\r\n' + HOST.replace(/^a:/, 'a=')});
  const result = await sanitizeOffer(offer, policy());
  assert.equal(result.match(/^a=candidate:/gm).length, ADDRESSES.length * 2);
  const [audio, video] = result.split('m=video');
  for (const section of [audio, video]) {
    const targets = section.split('\r\n').filter(line => line.startsWith('a=candidate:')).map(line => line.split(' ').slice(1, 6).join(' '));
    assert.equal(new Set(targets).size, ADDRESSES.length);
  }
});

test('counts expansion and candidate-free BUNDLE completion against the final 32-candidate limit', async () => {
  const addresses = ['127.0.0.1', ...Array.from({length: 15}, (_, index) => `192.168.1.${index + 1}`)];
  const offer = sdp({candidate: HOST.replace('192.168.1.20', MDNS)});
  assert.equal((await sanitizeOffer(offer, {addresses})).match(/^a=candidate:/gm).length, 32);
  await assert.rejects(sanitizeOffer(offer, {addresses: [...addresses, '192.168.1.99']}), /candidate limit/);
  const [head, video] = offer.split('m=video');
  const maxBundle = head + 'm=video' + video.replace(/^a=candidate:.*\r\n/m, '');
  assert.equal((await sanitizeOffer(maxBundle, {addresses})).match(/^a=candidate:/gm).length, 32);
  await assert.rejects(sanitizeOffer(maxBundle, {addresses: [...addresses, '192.168.1.99']}), /BUNDLE completion/);
});

test('opaque marker expansion cannot introduce any external destination or weaken candidate checks', async () => {
  const base = HOST.replace('192.168.1.20', MDNS);
  for (const candidate of [base.replace('50000 typ', '22 typ'), base.replace(' udp ', ' tcp '), base + ' raddr 203.0.113.5 rport 40000', base.replace(' ufrag abcd', ' ufrag efgh')]) {
    await assert.rejects(sanitizeOffer(sdp({candidate}), policy()));
  }
  for (const addresses of [['127.0.0.1', '169.254.169.254'], ['::ffff:7f00:1'], ['::c000:201'], ['::2'], []]) {
    await assert.rejects(sanitizeOffer(sdp({candidate: base}), {addresses}), /address policy/);
  }
});

test('rejects embedded candidate destinations outside the exact trusted host set', async () => {
  for (const address of ['192.168.1.21', '10.0.2.2', '169.254.169.254', '203.0.113.5', '224.0.0.1', '::', '2001:db8::21']) {
    await assert.rejects(sanitizeOffer(sdp({candidate: HOST.replace('192.168.1.20', address)}), policy()));
  }
});

test('normalizes local IPv6 without allowing mapped or link-local interfaces', async () => {
  const candidate = HOST.replace('192.168.1.20', '2001:0db8:0:0:0:0:0:20');
  assert.ok((await sanitizeOffer(sdp({candidate}), policy())).includes('2001:db8::20 50000'));
  const local = localAddresses();
  assert.ok(local.includes('127.0.0.1'));
  assert.ok(local.includes('::1'));
  assert.equal(new Set(local).size, local.length);
  assert.ok(local.every(address => net.isIP(address) && !address.includes('%') && !address.startsWith('fe80:')));
});

test('rejects data channels, extra media, sends, inactive media, and ICE restart attributes', async () => {
  const variants = [
    sdp() + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n',
    sdp().replace('m=video', 'm=application'),
    sdp() + 'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n',
    sdp({direction: 'sendrecv'}), sdp({direction: 'sendonly'}), sdp({direction: 'inactive'}),
    sdp().replace('a=ice-options:trickle', 'a=ice-options:trickle renomination'),
    sdp().replace('generation 0', 'generation 1'),
    sdp().replace('a=ice-ufrag:abcd', 'a=ice-ufrag:abcd\r\na=ice-ufrag:efgh'),
    sdp().replace('a=end-of-candidates', 'a=remote-candidates:1 127.0.0.1 50000'),
  ];
  for (const offer of variants) await assert.rejects(sanitizeOffer(offer, policy()));
});

test('rejects TCP, component two, relay/srflx/prflx, related addresses and unknown ICE options', async () => {
  const variants = [
    HOST.replace(' 1 udp ', ' 2 udp '), HOST.replace(' udp ', ' tcp '),
    ...['relay', 'srflx', 'prflx'].map(kind => HOST.replace('typ host', `typ ${kind}`)),
    HOST + ' raddr 127.0.0.1 rport 22', HOST + ' tcptype active', HOST + ' transport udp',
    HOST + ' network-id 2', HOST.replace('50000 typ', '22 typ'), HOST.replace('50000 typ', '65536 typ'),
  ];
  for (const candidate of variants) await assert.rejects(sanitizeOffer(sdp({candidate}), policy()));
});

test('validates connection addresses, DTLS role, fingerprint, credentials and BUNDLE identity', async () => {
  const variants = [
    sdp({connection: '203.0.113.5'}), sdp({connection: '169.254.169.254'}),
    sdp().replace('a=rtcp:9 IN IP4 0.0.0.0', 'a=rtcp:22 IN IP4 127.0.0.1'),
    sdp().replace(FINGERPRINT, 'a=fingerprint:sha-1 ' + Array(20).fill('AA').join(':')),
    sdp().replace(FINGERPRINT, 'a=fingerprint:sha-256 AA:BB'),
    sdp().replace(FINGERPRINT, ''), sdp().replace('a=setup:actpass', 'a=setup:active'),
    sdp().replace('a=ice-pwd:abcdefghijklmnopqrstuvwx', 'a=ice-pwd:short'),
    sdp().replace('a=ice-ufrag:abcd', 'a=ice-ufrag:efgh'),
    sdp().replace('a=mid:1', 'a=mid:0'), sdp().replace('a=group:BUNDLE 0 1', 'a=group:BUNDLE 0 2'),
    sdp().replace('a=recvonly\r\n', ''), sdp().replace('a=rtcp-mux\r\n', ''),
  ];
  for (const offer of variants) await assert.rejects(sanitizeOffer(offer, policy()));
});

test('bounds SDP, line length and candidates and rejects control or unknown routing lines', async () => {
  const variants = [
    sdp() + 'a=x:' + 'x'.repeat(48 * 1024), sdp() + 'a=x:' + 'x'.repeat(2048) + '\r\n',
    sdp().replace('s=-', 's=-\0'), sdp().replace('s=-', 's=-\t'), sdp().replace('s=-', 's=-\rbroken'),
    sdp().replace('t=0 0', 't=0 0\r\nu=https://attacker.invalid'),
    sdp().replace('a=end-of-candidates', Array.from({length: 32}, (_, index) => HOST.replace('a:', 'a=').replace('50000 typ', `${50001 + index} typ`)).join('\r\n')),
  ];
  for (const offer of variants) await assert.rejects(sanitizeOffer(offer, policy()));
});

test('rejects malformed numeric fields and duplicate negotiation fields', async () => {
  for (const offer of [
    sdp().replace('m=audio 9', 'm=audio 09'),
    sdp().replace('2122260223', '999999999999999999999999'),
    sdp().replace('a=mid:0', 'a=mid:0\r\na=mid:0'),
    sdp().replace(FINGERPRINT, FINGERPRINT + '\r\n' + FINGERPRINT),
    sdp().replace('s=-', 's=-\r\ns=-'),
    sdp().replace('a=rtpmap:111 opus/48000/2', 'a=rtpmap:112 opus/48000/2'),
  ]) await assert.rejects(sanitizeOffer(offer, policy()));
});
