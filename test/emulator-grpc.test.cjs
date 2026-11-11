'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {randomUUID, createPublicKey, verify} = require('node:crypto');
const {resolveEmulatorGrpc, grpcAllowlistPath, GRPC_ALLOWLIST, GRPC_ISSUER, GRPC_METHODS} = require('../src/emulator-grpc.cjs');

async function fixture(t, platform = 'darwin') {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'mobile-grpc-')));
  const config = {dataDir: path.join(temp, 'data')};
  const id = 'm-' + randomUUID();
  const deviceDir = path.join(config.dataDir, 'devices', id);
  const device = {id, deviceDir, avdName: id, avdHome: path.join(deviceDir, 'avd'),
    avdDir: path.join(deviceDir, 'avd', `${id}.avd`), pid: process.pid, port: 5554, serial: 'emulator-5554'};
  const env = {
    HOME: path.join(config.dataDir, 'home'),
    ANDROID_AVD_HOME: device.avdHome,
    ANDROID_EMULATOR_HOME: path.join(deviceDir, 'emulator-home'),
    XDG_RUNTIME_DIR: path.join(config.dataDir, 'runtime'),
  };
  const discoveryDir = platform === 'darwin' ? path.join(env.HOME, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running') : path.join(env.XDG_RUNTIME_DIR, 'avd', 'running');
  const jwks = path.join(discoveryDir, String(device.pid), 'jwks', randomUUID());
  await fs.mkdir(device.avdDir, {recursive: true, mode: 0o700});
  await fs.mkdir(jwks, {recursive: true, mode: 0o700});
  const allowlistFile = grpcAllowlistPath(config);
  await fs.writeFile(allowlistFile, JSON.stringify(GRPC_ALLOWLIST), {mode: 0o600});
  const discoveryFile = path.join(discoveryDir, `pid_${device.pid}.ini`);
  const activeFile = path.join(jwks, 'active.jwk');
  const properties = {
    'port.serial': String(device.port), 'port.adb': String(device.port + 1),
    'avd.id': id, 'avd.name': id, 'avd.dir': device.avdDir,
    cmdline: `/sdk/emulator -avd ${id} -port ${device.port} -grpc ${device.port + 3000} -grpc-use-jwt -grpc-allowlist ${allowlistFile}`,
    'grpc.port': '8554', 'grpc.jwks': jwks, 'grpc.jwk_active': activeFile,
    'grpc.allowlist': allowlistFile, 'grpc.token': 'private-discovery-secret-sentinel',
  };
  async function write(overrides = {}, suffix = '') {
    await fs.writeFile(discoveryFile, Object.entries({...properties, ...overrides}).map(([key, value]) => `${key}=${value}\n`).join('') + suffix, {mode: 0o600});
  }
  await write();
  t.after(() => fs.rm(temp, {recursive: true, force: true}));
  return {temp, config, device, env, platform, discoveryDir, discoveryFile, activeFile, jwks, allowlistFile, properties, write, selectAddress: async port => `[::1]:${port}`};
}

async function registered(f, overrides = {}) {
  let writing = false;
  const timer = setInterval(async () => {
    if (writing) return;
    writing = true;
    try {
      const filename = (await fs.readdir(f.jwks)).find(name => /^agent-mobile-.*\.jwk$/.test(name));
      if (filename) {
        const content = await fs.readFile(path.join(f.jwks, filename), 'utf8');
        await fs.writeFile(f.activeFile, content, {mode: 0o600});
      }
    } catch { /* Poll only this fixture's public-key directory. */ }
    finally { writing = false; }
  }, 2);
  try { return await resolveEmulatorGrpc({...f, keyLoadTimeoutMs: 1000, pollIntervalMs: 2, ...overrides}); }
  finally { clearInterval(timer); }
}

async function ownKeys(f) {
  return (await fs.readdir(f.jwks)).filter(name => /^agent-mobile-.*\.jwk$/.test(name));
}

function decode(headers) {
  assert.match(headers.authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  const [header, payload, signature] = headers.authorization.slice(7).split('.');
  return {header: JSON.parse(Buffer.from(header, 'base64url')), payload: JSON.parse(Buffer.from(payload, 'base64url')),
    input: `${header}.${payload}`, signature: Buffer.from(signature, 'base64url')};
}

test('discovers only the managed macOS emulator and signs short method-scoped ES256 credentials', async t => {
  const f = await fixture(t);
  const clock = 1900000000000;
  const access = await registered(f, {now: () => clock});
  t.after(() => access.close());
  assert.equal(access.address, '[::1]:8554');
  assert.deepEqual(Object.keys(access).sort(), ['address', 'close', 'headers']);
  assert.ok(!JSON.stringify(access).includes('private-discovery-secret-sentinel'));
  const names = await ownKeys(f);
  assert.equal(names.length, 1);
  const publicFile = path.join(f.jwks, names[0]);
  const keySet = JSON.parse(await fs.readFile(publicFile, 'utf8'));
  const publicJwk = keySet.keys[0];
  assert.equal(publicJwk.d, undefined, 'The private signing key must never be written to disk');
  assert.equal((await fs.stat(publicFile)).mode & 0o777, 0o600);
  const audio = decode(await access.headers(GRPC_METHODS[1]));
  assert.equal(audio.header.alg, 'ES256'); assert.equal(audio.header.kid, publicJwk.kid);
  assert.equal(audio.header.typ, undefined, 'The SDK Tink validator rejects a typ header without a configured expected type');
  assert.equal(audio.payload.iss, GRPC_ISSUER);
  assert.deepEqual(audio.payload.aud, [GRPC_METHODS[1]]);
  assert.equal(audio.payload.iat, clock / 1000 - 1); assert.equal(audio.payload.exp, clock / 1000 + 60);
  assert.equal(audio.signature.length, 64);
  assert.ok(verify('sha256', Buffer.from(audio.input), {key: createPublicKey({key: publicJwk, format: 'jwk'}), dsaEncoding: 'ieee-p1363'}, audio.signature));
  const screen = decode(await access.headers(GRPC_METHODS[0]));
  assert.deepEqual(screen.payload.aud, [GRPC_METHODS[0]]);
  assert.notEqual(screen.payload.jti, audio.payload.jti);
  await assert.rejects(access.headers('/android.emulation.control.EmulatorController/sendTouch'), /not permitted/);
  await assert.rejects(access.headers('/android.emulation.control.v2.Rtc/RequestRtcStream'), /not permitted/);
  await access.close();
  assert.deepEqual(await ownKeys(f), []);
  await assert.rejects(access.headers(GRPC_METHODS[0]), /closed/);
  await access.close();
});

test('Linux discovery requires the private XDG runtime directory instead of scanning /run/user or host home', async t => {
  const f = await fixture(t, 'linux');
  const access = await registered(f);
  await access.close();
  for (const env of [{...f.env, XDG_RUNTIME_DIR: undefined}, {...f.env, XDG_RUNTIME_DIR: '/run/user/1000'}, {...f.env, HOME: os.homedir()}]) {
    await assert.rejects(resolveEmulatorGrpc({...f, env}), {code: 'emulator_grpc_unavailable'});
  }
});

test('rejects wrong live identity, ports and unauthenticated or externally bound configurations', async t => {
  const f = await fixture(t);
  for (const overrides of [
    {'avd.id': 'another-avd'}, {'avd.name': 'another-avd'}, {'avd.dir': '/host/private/avd'},
    {'port.serial': '5556'}, {'port.adb': '5557'}, {'grpc.port': '7000'}, {'grpc.port': '99999999'},
    {'grpc.address': '0.0.0.0'}, {'grpc.server_cert': '/host/cert'},
    {cmdline: f.properties.cmdline + ' -grpc 8554'},
    {cmdline: f.properties.cmdline.replace('-grpc-use-jwt', '')},
    {cmdline: f.properties.cmdline + ' -ports 5554,5555'},
    {'grpc.allowlist': '/host/emulator_access.json'},
    {'grpc.jwks': path.join(f.temp, 'foreign-jwks')},
    {'grpc.jwk_active': '/host/active.jwk'},
  ]) {
    await f.write(overrides);
    await assert.rejects(resolveEmulatorGrpc({...f, keyLoadTimeoutMs: 10}), {code: 'emulator_grpc_unavailable'}, Object.keys(overrides).join(','));
    assert.deepEqual(await ownKeys(f), []);
  }
  await f.write();
  await assert.rejects(resolveEmulatorGrpc({...f, isAlive: () => false}), /not alive/);
  assert.deepEqual(await ownKeys(f), []);
});

test('refuses broadened policies and ambiguous discovery without reading unrelated PID files', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.allowlistFile, JSON.stringify({unprotected: ['.*'], allowlist: []}));
  await assert.rejects(resolveEmulatorGrpc(f), /only screen and audio/);
  await fs.writeFile(f.allowlistFile, JSON.stringify(GRPC_ALLOWLIST));
  await f.write({}, 'grpc.port=8554\n');
  await assert.rejects(resolveEmulatorGrpc(f), /Ambiguous/);
  await f.write();
  const legacy = path.join(f.discoveryDir, `pid_${f.device.pid}_info.ini`);
  await fs.copyFile(f.discoveryFile, legacy); await fs.chmod(legacy, 0o600);
  await assert.rejects(resolveEmulatorGrpc(f), /absent or ambiguous/);
  await fs.unlink(legacy);
  await fs.rename(f.discoveryFile, path.join(f.discoveryDir, 'pid_99999999.ini'));
  await assert.rejects(resolveEmulatorGrpc(f), /absent or ambiguous/);
  assert.deepEqual(await ownKeys(f), []);
});

test('discovery, JWT directories and policy files reject symlinks and insecure permissions', async t => {
  const f = await fixture(t);
  await fs.chmod(f.discoveryFile, 0o644);
  await assert.rejects(resolveEmulatorGrpc(f), /private regular file/);
  await fs.chmod(f.discoveryFile, 0o600);
  await fs.chmod(f.jwks, 0o755);
  await assert.rejects(resolveEmulatorGrpc(f), /directory must be private/);
  await fs.chmod(f.jwks, 0o700);
  const discoveryCopy = path.join(f.discoveryDir, 'backup.ini');
  await fs.rename(f.discoveryFile, discoveryCopy); await fs.symlink(discoveryCopy, f.discoveryFile);
  await assert.rejects(resolveEmulatorGrpc(f), {code: 'emulator_grpc_unavailable'});
  await fs.unlink(f.discoveryFile); await fs.rename(discoveryCopy, f.discoveryFile);
  const policyCopy = f.allowlistFile + '.backup';
  await fs.rename(f.allowlistFile, policyCopy); await fs.symlink(policyCopy, f.allowlistFile);
  await assert.rejects(resolveEmulatorGrpc(f), {code: 'emulator_grpc_unavailable'});
  await fs.unlink(f.allowlistFile); await fs.rename(policyCopy, f.allowlistFile);
  const actual = f.jwks + '.actual';
  await fs.rename(f.jwks, actual); await fs.symlink(actual, f.jwks);
  await assert.rejects(resolveEmulatorGrpc(f), {code: 'emulator_grpc_unavailable'});
  assert.deepEqual((await fs.readdir(actual)).filter(name => name.startsWith('agent-mobile-')), []);
});

test('public key acknowledgement is required and timeout removes only this handle key', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.jwks, 'unrelated.jwk'), '{"keys":[]}', {mode: 0o600});
  await assert.rejects(resolveEmulatorGrpc({...f, keyLoadTimeoutMs: 20, pollIntervalMs: 2}), /did not acknowledge/);
  assert.deepEqual(await ownKeys(f), []);
  assert.equal(await fs.readFile(path.join(f.jwks, 'unrelated.jwk'), 'utf8'), '{"keys":[]}');
});

test('dead emulator or changed discovery revokes in-memory signing and removes its public key', async t => {
  const f = await fixture(t);
  let alive = true;
  const access = await registered(f, {isAlive: () => alive});
  alive = false;
  await assert.rejects(access.headers(GRPC_METHODS[0]), /not alive/);
  assert.deepEqual(await ownKeys(f), []);
  await assert.rejects(access.headers(GRPC_METHODS[0]), /closed/);
  alive = true;
  const next = await registered(f, {isAlive: () => alive});
  await f.write({cmdline: f.properties.cmdline + ' -no-window'});
  await assert.rejects(next.headers(GRPC_METHODS[1]), /discovery changed/);
  assert.deepEqual(await ownKeys(f), []);
});

test('accepts either fixed loopback family while rejecting endpoint changes', async t => {
  const f = await fixture(t);
  await f.write({'grpc.address': '127.0.0.1', cmdline: f.properties.cmdline.split(' ').map(value => '"' + value + '"').join(' ')});
  const access = await registered(f, {selectAddress: async port => {
    assert.equal(port, f.device.port + 3000);
    return `127.0.0.1:${port}`;
  }});
  assert.equal(access.address, '127.0.0.1:8554'); await access.close();
  for (const address of ['10.0.2.2:8554', '0.0.0.0:8554', '127.0.0.1:8555', 'localhost:8554']) {
    await assert.rejects(registered(f, {selectAddress: async () => address}), /must be loopback/);
  }
});

test('rejects arbitrary device paths and oversized metadata without exposing token or host paths in errors', async t => {
  const f = await fixture(t);
  for (const device of [
    {...f.device, serial: 'real-phone'}, {...f.device, pid: -1},
    {...f.device, deviceDir: '/host/private'}, {...f.device, avdHome: '/host/private'},
  ]) {
    await assert.rejects(resolveEmulatorGrpc({...f, device}), {code: 'emulator_grpc_unavailable'});
  }
  await fs.writeFile(f.discoveryFile, 'grpc.token=' + 'x'.repeat(65536));
  await assert.rejects(resolveEmulatorGrpc(f), error => {
    assert.equal(error.code, 'emulator_grpc_unavailable');
    assert.ok(!error.message.includes(f.temp));
    assert.ok(!error.message.includes('private-discovery-secret-sentinel'));
    return true;
  });
});
