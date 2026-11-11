'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {WebRTCManager} = require('../src/webrtc.cjs');

function sdp(direction = 'recvonly') {
  const lines = ['v=0', 'o=- 123456789 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'a=group:BUNDLE 0 1'];
  for (const [index, kind, payload, codec] of [[0, 'audio', 111, 'opus/48000/2'], [1, 'video', 96, 'VP8/90000']]) {
    lines.push(`m=${kind} 9 UDP/TLS/RTP/SAVPF ${payload}`, 'c=IN IP4 0.0.0.0', `a=mid:${index}`, `a=${direction}`, 'a=rtcp-mux',
      'a=ice-ufrag:abcd', 'a=ice-pwd:abcdefghijklmnopqrstuvwx', 'a=fingerprint:sha-256 ' + Array(32).fill('A1').join(':'),
      `a=setup:${direction === 'recvonly' ? 'actpass' : 'active'}`, `a=rtpmap:${payload} ${codec}`,
      'a=candidate:1234 1 UDP 2122260223 127.0.0.1 50000 typ host generation 0', 'a=end-of-candidates');
  }
  return lines.join('\r\n') + '\r\n';
}

class FakeChild extends EventEmitter {
  constructor(behavior = {}) {
    super();
    this.behavior = behavior;
    this.stdin = new PassThrough(); this.stdout = new PassThrough();
    this.signals = []; this.closed = false; this.startMessages = [];
    let buffer = '';
    this.stdin.on('data', chunk => {
      buffer += chunk.toString();
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        this.startMessages.push(JSON.parse(line));
        if (behavior.noAnswer) continue;
        process.nextTick(() => {
          if (behavior.invalidJSON) this.stdout.write('not JSON\n');
          else if (behavior.overflow) this.stdout.write(Buffer.alloc(128 * 1024 + 1, 'x'));
          else {
            const answer = {type: 'answer', sdp: behavior.answer || sdp('sendonly')};
            this.stdout.write(JSON.stringify(answer) + '\n' + (behavior.duplicateAnswer ? JSON.stringify(answer) + '\n' : ''));
          }
        });
      }
    });
  }
  exit() {
    if (this.closed) return;
    this.closed = true;
    this.emit('exit', 0, null); this.emit('close', 0, null);
  }
  kill(signal) {
    this.signals.push(signal);
    if (this.behavior.ignoreKills || this.behavior.manualExit || (this.behavior.ignoreTerm && signal === 'SIGTERM')) return true;
    process.nextTick(() => this.exit());
    return true;
  }
}

function fixture(t, overrides = {}) {
  const config = {
    dataDir: '/private/tmp/mobile-webrtc-tests', maxDevices: 2,
    webrtc: {
      enabled: true, pythonPath: '/usr/bin/python3', protoDir: '/opt/emulator/lib',
      maxWidth: 720, maxHeight: 1280, fps: 15,
      leaseSeconds: 10, maxLifetimeSeconds: 30, negotiationTimeoutMs: 200, shutdownTimeoutMs: 20,
      ...overrides.webrtc,
    },
  };
  const state = {now: 1000000, owners: new Set(['owner-a', 'owner-b']), children: [], spawns: [], accesses: [], behaviors: [], resolveCalls: 0};
  const resolveAccess = async device => {
    state.resolveCalls++;
    if (state.onResolve) return state.onResolve(device);
    const access = {
      address: '127.0.0.1:8554', device, methods: [], closeCount: 0,
      async headers(method) { this.methods.push(method); return {authorization: 'Bearer private-method-credential'}; },
      async close() { this.closeCount++; },
    };
    state.accesses.push(access);
    return access;
  };
  const manager = new WebRTCManager({config, resolveAccess, addresses: () => ['127.0.0.1'], now: () => state.now,
    spawnProcess(file, args, options) {
      const behavior = state.behaviors.shift() || {};
      const child = new FakeChild(behavior);
      state.spawns.push({file, args, options}); state.children.push(child);
      process.nextTick(() => {
        if (behavior.spawnError) { child.emit('error', new Error('unsafe host command details')); child.exit(); }
        else child.emit('spawn');
      });
      return child;
    },
  });
  manager.setOwnerValidator(owner => state.owners.has(owner));
  t.after(async () => {
    for (const child of state.children) child.exit();
    await manager.shutdown().catch(() => {});
  });
  const session = id => ({id, device: {id, avdName: id, serial: 'emulator-5554'}});
  return {...state, state, manager, config, session};
}

test('binds every lease to exact operator identity and runtime session', async t => {
  const f = fixture(t);
  await assert.rejects(f.manager.open(f.session('phone-a'), 'unknown', sdp()), {code: 'unauthorized'});
  assert.equal(f.state.resolveCalls, 0);
  const peer = await f.manager.open(f.session('phone-a'), 'owner-a', sdp());
  assert.equal(peer.sessionId, 'phone-a'); assert.equal(peer.mode, 'local-media-only');
  assert.equal(peer.answer.type, 'answer');
  await assert.rejects(f.manager.renew('phone-b', peer.id, 'owner-a'), {code: 'live_unavailable'});
  await assert.rejects(f.manager.renew('phone-a', peer.id, 'owner-b'), {code: 'live_unavailable'});
  await assert.rejects(f.manager.close('phone-a', peer.id, 'owner-b'), {code: 'live_unavailable'});
  assert.equal(f.state.children[0].closed, false);
  await f.manager.close('phone-a', peer.id, 'owner-a');
  assert.equal(f.state.children[0].closed, true);
});

test('rejects malicious SDP before resolving emulator credentials or spawning a worker', async t => {
  const f = fixture(t);
  for (const offer of [
    sdp() + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=sctp-port:5000\r\n',
    sdp().replaceAll('a=recvonly', 'a=sendrecv'),
    sdp().replaceAll('127.0.0.1 50000 typ host', '169.254.169.254 50000 typ host'),
    JSON.stringify({method: 'adb', path: '/private/secret'}),
  ]) await assert.rejects(f.manager.open(f.session('phone-a'), 'owner-a', offer));
  assert.equal(f.state.resolveCalls, 0); assert.equal(f.state.spawns.length, 0); assert.equal(f.manager.peers.size, 0);
});

test('passes only the media RPC credentials through private stdin and scrubs the worker environment', async t => {
  const f = fixture(t);
  const previous = process.env.AGENT_MOBILE_TEST_SECRET;
  process.env.AGENT_MOBILE_TEST_SECRET = 'host-secret-sentinel';
  t.after(() => { if (previous === undefined) delete process.env.AGENT_MOBILE_TEST_SECRET; else process.env.AGENT_MOBILE_TEST_SECRET = previous; });
  await f.manager.open(f.session('phone-a'), 'owner-a', sdp());
  const spawn = f.state.spawns[0]; const start = f.state.children[0].startMessages[0];
  assert.equal(spawn.file, '/usr/bin/python3'); assert.equal(spawn.options.shell, false);
  assert.equal(spawn.options.env.AGENT_MOBILE_TEST_SECRET, undefined);
  assert.equal(spawn.options.env.PYTHONNOUSERSITE, '1');
  assert.ok(!JSON.stringify(spawn.args).includes('private-method-credential'));
  assert.ok(!JSON.stringify(spawn.options.env).includes('private-method-credential'));
  assert.deepEqual(f.state.accesses[0].methods, [
    '/android.emulation.control.EmulatorController/streamScreenshot',
    '/android.emulation.control.EmulatorController/streamAudio',
  ]);
  assert.deepEqual(Object.keys(start.authorization), ['streamScreenshot', 'streamAudio']);
  assert.ok(start.offer.includes('a=recvonly'));
  assert.ok(!start.offer.includes('m=application'));
  assert.deepEqual(Object.keys(start).sort(), ['authorization', 'offer', 'type']);
});

test('enforces one peer per device and a bounded total with immediate reservation', async t => {
  const f = fixture(t);
  const first = await f.manager.open(f.session('phone-a'), 'owner-a', sdp());
  await assert.rejects(f.manager.open(f.session('phone-a'), 'owner-b', sdp()), {code: 'live_busy'});
  await f.manager.open(f.session('phone-b'), 'owner-b', sdp());
  await assert.rejects(f.manager.open(f.session('phone-c'), 'owner-a', sdp()), {code: 'live_busy'});
  await f.manager.close('phone-a', first.id, 'owner-a');
  await f.manager.open(f.session('phone-c'), 'owner-a', sdp());
  assert.equal(f.manager.peers.size, 2);
});

test('expires idle leases by terminating their media process', async t => {
  const f = fixture(t);
  const peer = await f.manager.open(f.session('phone-a'), 'owner-a', sdp());
  f.state.now += 10000;
  await assert.rejects(f.manager.renew('phone-a', peer.id, 'owner-a'), {code: 'live_unavailable'});
  await f.manager.sweep();
  assert.equal(f.state.children[0].closed, true);
  assert.equal(f.manager.peers.size, 0);
  assert.equal(f.state.accesses[0].closeCount, 1);
});

test('renewal cannot extend the hard maximum lifetime', async t => {
  const f = fixture(t);
  const peer = await f.manager.open(f.session('phone-a'), 'owner-a', sdp());
  let renewed;
  for (let step = 0; step < 3; step++) {
    f.state.now += 9000; renewed = await f.manager.renew('phone-a', peer.id, 'owner-a');
  }
  assert.equal(renewed.expiresAt, renewed.hardExpiresAt);
  f.state.now += 3000;
  await f.manager.sweep();
  assert.equal(f.state.children[0].closed, true);
});

test('owner revocation and device teardown close only the matching peers', async t => {
  const f = fixture(t);
  await f.manager.open(f.session('phone-a'), 'owner-a', sdp());
  await f.manager.open(f.session('phone-b'), 'owner-b', sdp());
  f.state.owners.delete('owner-a');
  await f.manager.sweep();
  assert.equal(f.state.children[0].closed, true);
  assert.equal(f.state.children[1].closed, false);
  await f.manager.closeDevice('phone-b');
  assert.equal(f.state.children[1].closed, true);
});

test('closeOwner revokes all of that viewer session without affecting another viewer', async t => {
  const f = fixture(t);
  await f.manager.open(f.session('phone-a'), 'owner-a', sdp());
  await f.manager.open(f.session('phone-b'), 'owner-b', sdp());
  await f.manager.closeOwner('owner-a');
  assert.equal(f.state.children[0].closed, true);
  assert.equal(f.state.children[1].closed, false);
});

test('close waits for actual process exit and escalates from SIGTERM to SIGKILL', async t => {
  const f = fixture(t);
  f.state.behaviors.push({ignoreTerm: true});
  const peer = await f.manager.open(f.session('phone-a'), 'owner-a', sdp());
  await f.manager.close('phone-a', peer.id, 'owner-a');
  assert.deepEqual(f.state.children[0].signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(f.state.children[0].closed, true);
  assert.equal(f.manager.peers.size, 0);
});

test('does not return success or release device reservation when process exit is unconfirmed', async t => {
  const f = fixture(t);
  f.state.behaviors.push({ignoreKills: true});
  const peer = await f.manager.open(f.session('phone-a'), 'owner-a', sdp());
  await assert.rejects(f.manager.close('phone-a', peer.id, 'owner-a'), {code: 'live_revoke_failed'});
  assert.equal(f.state.children[0].closed, false);
  assert.equal(f.manager.peers.size, 1);
  await assert.rejects(f.manager.open(f.session('phone-a'), 'owner-a', sdp()), {code: 'live_busy'});
});

test('rejects invalid, oversized, duplicate or unsafe worker answers and cleans resources', async t => {
  const f = fixture(t);
  for (const behavior of [
    {invalidJSON: true}, {overflow: true}, {duplicateAnswer: true},
    {answer: sdp('sendonly') + 'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n'},
    {answer: sdp('recvonly')},
    {answer: sdp('sendonly').replaceAll('127.0.0.1 50000 typ host', '203.0.113.1 50000 typ host')},
  ]) {
    f.state.behaviors.push(behavior);
    await assert.rejects(f.manager.open(f.session('phone-a'), 'owner-a', sdp()));
    assert.equal(f.state.children.at(-1).closed, true);
    assert.equal(f.manager.peers.size, 0);
  }
});

test('spawn failures and negotiation timeouts never leave a usable peer', async t => {
  const f = fixture(t, {webrtc: {negotiationTimeoutMs: 40}});
  f.state.behaviors.push({spawnError: true});
  await assert.rejects(f.manager.open(f.session('phone-a'), 'owner-a', sdp()));
  assert.equal(f.manager.peers.size, 0);
  f.state.behaviors.push({noAnswer: true});
  const timeout = f.manager.open(f.session('phone-a'), 'owner-a', sdp());
  // The production listener keeps the event loop alive; this test retains a
  // bounded ordinary timer because the manager's negotiation timer is unref'd.
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(timeout, {code: 'live_timeout'}); }
  finally { clearTimeout(keepAlive); }
  assert.equal(f.manager.peers.size, 0);
});

test('revocation during credential discovery prevents any later worker spawn', async t => {
  const f = fixture(t);
  let finishResolve, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let closed = 0;
  f.state.onResolve = () => new Promise(resolve => { finishResolve = () => resolve({address: '127.0.0.1:8554', headers: async () => ({authorization: 'Bearer secret'}), close: async () => { closed++; }}); entered(); });
  const opening = f.manager.open(f.session('phone-a'), 'owner-a', sdp());
  const rejected = assert.rejects(opening);
  await waiting;
  await f.manager.closeOwner('owner-a');
  finishResolve();
  await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, 1); assert.equal(f.state.spawns.length, 0); assert.equal(f.manager.peers.size, 0);
});

test('a stuck first worker does not prevent revoking other expired peers', async t => {
  const f = fixture(t);
  f.state.behaviors.push({ignoreKills: true});
  await f.manager.open(f.session('phone-a'), 'owner-a', sdp());
  await f.manager.open(f.session('phone-b'), 'owner-a', sdp());
  f.state.now += 10000;
  await f.manager.sweep().catch(() => {});
  assert.equal(f.state.children[1].closed, true, 'Revocation must be attempted for every expired peer');
});

test('negotiation deadline also cancels stalled discovery and closes its late credential handle', async t => {
  const f = fixture(t, {webrtc: {negotiationTimeoutMs: 30}});
  let finishResolve, entered, closeCount = 0;
  const waiting = new Promise(resolve => { entered = resolve; });
  f.state.onResolve = () => new Promise(resolve => {
    finishResolve = () => resolve({address: '127.0.0.1:8554', headers: async () => ({authorization: 'Bearer secret'}), close: async () => { closeCount++; }});
    entered();
  });
  const opening = f.manager.open(f.session('phone-a'), 'owner-a', sdp());
  let settled = false;
  const result = opening.then(() => { settled = true; }, () => { settled = true; });
  await waiting;
  await new Promise(resolve => setTimeout(resolve, 70));
  const cancelledOnTime = settled;
  finishResolve();
  await result;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelledOnTime, true, 'Discovery must not outlive the negotiation deadline');
  assert.equal(closeCount, 1); assert.equal(f.state.spawns.length, 0);
});

test('disabled and shutting-down media services do not resolve device access', async t => {
  const f = fixture(t, {webrtc: {enabled: false}});
  await assert.rejects(f.manager.open(f.session('phone-a'), 'owner-a', sdp()), {code: 'live_disabled'});
  f.config.webrtc.enabled = true;
  await f.manager.shutdown();
  await assert.rejects(f.manager.open(f.session('phone-a'), 'owner-a', sdp()), {code: 'closing'});
  assert.equal(f.state.resolveCalls, 0);
});
