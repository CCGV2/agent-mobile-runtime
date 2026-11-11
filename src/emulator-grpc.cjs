'use strict';

const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const {generateKeyPairSync, randomUUID, sign, createHash} = require('node:crypto');
const {isDeepStrictEqual} = require('node:util');

// AOSP references: android/emu/files/src/android/emulation/ConfigDirs.cpp,
// android-qemu2-glue/qemu-setup.cpp, and android/android-grpc/security/src/
// android/emulation/control/secure/{JwtTokenAuth.cpp,emulator_access.json}.
// Explicit -port suppresses automatic gRPC startup. A fixed -grpc port is safe
// only together with JWT: the SDK then forces loopback + local credentials.
// Never launch bare -grpc or accept a client-provided endpoint or auth mode.
const GRPC_ISSUER = 'agent-mobile-runtime';
const GRPC_METHODS = Object.freeze([
  '/android.emulation.control.EmulatorController/streamScreenshot',
  '/android.emulation.control.EmulatorController/streamAudio',
]);
const GRPC_ALLOWLIST = Object.freeze({
  unprotected: Object.freeze([]),
  allowlist: Object.freeze([Object.freeze({iss: GRPC_ISSUER, protected: GRPC_METHODS})]),
});
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

function grpcError(message = 'Secure emulator gRPC discovery unavailable') {
  const error = new Error(message);
  error.code = 'emulator_grpc_unavailable';
  return error;
}

function grpcAllowlistPath(config) {
  if (!config || typeof config.dataDir !== 'string' || !path.isAbsolute(config.dataDir) || config.dataDir.includes('\0')) throw grpcError();
  return path.join(config.dataDir, 'grpc-allowlist.json');
}

function inside(root, location) {
  const relative = path.relative(root, location);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function sameOwner(stat) {
  return typeof process.getuid !== 'function' || stat.uid === process.getuid();
}

async function secureDirectory(root, directory) {
  if (directory !== root && !inside(root, directory)) throw grpcError('Emulator gRPC discovery escaped private runtime storage');
  if (await fs.realpath(root) !== root) throw grpcError('Emulator gRPC storage must not contain symlinks');
  const relative = path.relative(root, directory);
  let current = root;
  for (const component of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (component) current = path.join(current, component);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !sameOwner(stat) || (stat.mode & 0o077)) {
      throw grpcError('Emulator gRPC directory must be private and owned by this user');
    }
  }
}

async function secureRead(root, filename, maximum = 65536, publicFile = false) {
  await secureDirectory(root, path.dirname(filename));
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !sameOwner(stat) || (stat.mode & (publicFile ? 0o022 : 0o077)) || stat.size > maximum || stat.nlink !== 1) {
      throw grpcError('Emulator gRPC discovery file is not a private regular file');
    }
    const content = await handle.readFile('utf8');
    if (Buffer.byteLength(content) > maximum || content.includes('\0')) throw grpcError('Emulator gRPC discovery file exceeds its limit');
    return {content, stat};
  } finally { await handle.close(); }
}

function parseDiscovery(content) {
  const properties = Object.create(null);
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const split = line.indexOf('=');
    if (split < 1) throw grpcError('Invalid emulator gRPC discovery');
    const key = line.slice(0, split).trim();
    if (!/^[A-Za-z0-9_.-]+$/.test(key) || Object.hasOwn(properties, key)) throw grpcError('Ambiguous emulator gRPC discovery');
    properties[key] = line.slice(split + 1).trim();
  }
  return properties;
}

function commandArguments(command) {
  if (typeof command !== 'string' || command.length > 32768 || /[\r\n\0]/.test(command)) throw grpcError('Invalid emulator command metadata');
  const result = [];
  const tokens = /(?:"([^"\\]*)"|([^\s"\\]+))(?:\s+|$)/gy;
  let offset = 0;
  while (offset < command.length) {
    tokens.lastIndex = offset;
    const match = tokens.exec(command);
    if (!match || result.length >= 128) throw grpcError('Invalid emulator command metadata');
    result.push(match[1] ?? match[2]); offset = tokens.lastIndex;
  }
  return result;
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function discoveryDirectory({config, device, env, platform}) {
  const root = path.resolve(config.dataDir);
  const base = path.join(root, 'devices', device?.id || '');
  if (!device || !/^[a-z][a-z0-9-]{0,47}$/.test(device.id || '') || device.avdName !== device.id ||
      device.deviceDir !== base || device.avdHome !== path.join(base, 'avd') ||
      device.avdDir !== path.join(base, 'avd', `${device.id}.avd`) ||
      !Number.isSafeInteger(device.pid) || device.pid < 2 ||
      !Number.isSafeInteger(device.port) || device.port < 5554 || device.port > 5682 || device.port % 2 ||
      device.serial !== `emulator-${device.port}`) throw grpcError('Invalid managed emulator identity');
  if (!env || env.HOME !== path.join(root, 'home') ||
      env.ANDROID_AVD_HOME !== device.avdHome ||
      env.ANDROID_EMULATOR_HOME !== path.join(base, 'emulator-home')) throw grpcError('Invalid private emulator environment');
  if (platform === 'darwin') return path.join(env.HOME, 'Library', 'Caches', 'TemporaryItems', 'avd', 'running');
  if (platform === 'linux') {
    if (env.XDG_RUNTIME_DIR !== path.join(root, 'runtime')) throw grpcError('Linux emulator discovery requires a private XDG_RUNTIME_DIR');
    return path.join(env.XDG_RUNTIME_DIR, 'avd', 'running');
  }
  throw grpcError('Secure emulator gRPC discovery currently supports macOS and Linux');
}

async function readDiscovery({config, device, root, directory, isAlive}) {
  if (!isAlive(device.pid)) throw grpcError('Managed emulator process is not alive');
  await secureDirectory(root, device.avdDir);
  await secureDirectory(root, directory);
  const files = [];
  // Exact PID filenames only; never scan discovery files for unrelated devices.
  for (const name of [`pid_${device.pid}.ini`, `pid_${device.pid}_info.ini`]) {
    const filename = path.join(directory, name);
    try { files.push({filename, ...await secureRead(root, filename)}); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (files.length !== 1) throw grpcError('Managed emulator gRPC discovery is absent or ambiguous');
  const {filename, content, stat} = files[0];
  const props = parseDiscovery(content);
  const expectedDir = await fs.realpath(device.avdDir);
  if (props['avd.id'] !== device.avdName || props['avd.name'] !== device.avdName || props['avd.dir'] !== expectedDir ||
      props['port.serial'] !== String(device.port) || props['port.adb'] !== String(device.port + 1)) {
    throw grpcError('Managed emulator gRPC discovery identity mismatch');
  }
  const port = Number(props['grpc.port']);
  if (!/^\d+$/.test(props['grpc.port'] || '') || !Number.isSafeInteger(port) || port !== device.port + 3000) {
    throw grpcError('Managed emulator gRPC port is not the fixed media port');
  }
  const command = commandArguments(props.cmdline || '');
  const flag = name => command.flatMap((value, index) => value === name ? [index] : []);
  const grpcFlags = flag('-grpc');
  if (flag('-grpc-use-jwt').length !== 1 || grpcFlags.length !== 1 || command[grpcFlags[0] + 1] !== String(port) ||
      command.some(value => value === '-ports' || value.startsWith('-ports=') || value.startsWith('-grpc=') || value === '-grpc-use-token' || value.startsWith('-grpc-tls-')) ||
      props['grpc.server_cert'] || props['grpc.ca_root'] ||
      (props['grpc.address'] && !['127.0.0.1', '::1', '[::1]'].includes(props['grpc.address']))) {
    throw grpcError('Emulator must use the authenticated loopback gRPC service');
  }
  const policyPath = grpcAllowlistPath(config);
  const policyFlags = flag('-grpc-allowlist');
  if (policyFlags.length !== 1 || command[policyFlags[0] + 1] !== policyPath) throw grpcError('Emulator gRPC launch policy is not managed by this runtime');
  if (props['grpc.allowlist'] !== policyPath) throw grpcError('Emulator gRPC policy is not managed by this runtime');
  const policy = JSON.parse((await secureRead(root, policyPath)).content);
  if (!isDeepStrictEqual(policy, GRPC_ALLOWLIST)) throw grpcError('Emulator gRPC policy must allow only screen and audio observation');
  const jwks = props['grpc.jwks'];
  if (typeof jwks !== 'string' || path.dirname(jwks) !== path.join(directory, String(device.pid), 'jwks') ||
      !UUID.test(path.basename(jwks)) || props['grpc.jwk_active'] !== path.join(jwks, 'active.jwk')) {
    throw grpcError('Emulator JWT discovery directory does not belong to the managed process');
  }
  await secureDirectory(root, jwks);
  const fingerprint = createHash('sha256').update(JSON.stringify({
    filename, ino: stat.ino, dev: stat.dev, ctimeMs: stat.ctimeMs,
    id: props['avd.id'], directory: props['avd.dir'], port, jwks, policyPath,
  })).digest('hex');
  return {port, jwks, activeFile: props['grpc.jwk_active'], fingerprint};
}

async function selectLoopback(port) {
  // SDK builds differ in their IPv4 preference. Probe only these two fixed
  // loopback endpoints; no DNS or caller-selected destination is involved.
  for (const host of ['127.0.0.1', '::1']) {
    const connected = await new Promise(resolve => {
      const socket = net.createConnection({host, port});
      const finish = result => { socket.destroy(); resolve(result); };
      socket.setTimeout(500, () => finish(false));
      socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    });
    if (connected) return host === '::1' ? `[::1]:${port}` : `${host}:${port}`;
  }
  throw grpcError('Managed emulator loopback media listener is unavailable');
}

async function installPublicKey(root, directory, publicKey) {
  await secureDirectory(root, directory);
  const filename = path.join(directory, `agent-mobile-${randomUUID()}.jwk`);
  const temporary = filename + '.tmp';
  try {
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(JSON.stringify({keys: [publicKey]}) + '\n'); }
    finally { await handle.close(); }
    // Publish a complete file without replacing an existing entry. The watcher
    // sees only *.jwk, so it cannot observe a partially written public key set.
    await fs.link(temporary, filename);
  } finally { await fs.unlink(temporary).catch(() => {}); }
  const stat = await fs.lstat(filename);
  return {filename, ino: stat.ino, dev: stat.dev};
}

async function removePublicKey(root, installed) {
  if (!installed) return;
  try {
    await secureDirectory(root, path.dirname(installed.filename));
    const stat = await fs.lstat(installed.filename);
    if (stat.isSymbolicLink() || stat.ino !== installed.ino || stat.dev !== installed.dev) throw grpcError('Emulator JWT public key entry changed');
    await fs.unlink(installed.filename);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

/** Internal service API. Never expose env, endpoint, token, policy or filesystem
 * arguments through HTTP/MCP. Call only for a runtime-owned live ChildProcess.
 * The returned handle must be closed when its media worker/peer is terminated.
 */
async function resolveEmulatorGrpc({config, device, env, platform = process.platform,
  isAlive = processAlive, now = Date.now, keyLoadTimeoutMs = 5000, pollIntervalMs = 25, selectAddress = selectLoopback} = {}) {
  grpcAllowlistPath(config);
  if (!Number.isSafeInteger(keyLoadTimeoutMs) || keyLoadTimeoutMs < 1 || keyLoadTimeoutMs > 30000 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1000) throw grpcError();
  const root = path.resolve(config.dataDir);
  const directory = discoveryDirectory({config, device, env, platform});
  let installed, privateKey, closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    privateKey = undefined;
    await removePublicKey(root, installed);
  };
  try {
    const discovery = await readDiscovery({config, device, root, directory, isAlive});
    const address = await selectAddress(discovery.port);
    if (![`127.0.0.1:${discovery.port}`, `[::1]:${discovery.port}`].includes(address)) throw grpcError('Managed emulator media address must be loopback');
    const keys = generateKeyPairSync('ec', {namedCurve: 'prime256v1'});
    privateKey = keys.privateKey;
    const publicJwk = {...keys.publicKey.export({format: 'jwk'}), kid: randomUUID(), alg: 'ES256', use: 'sig'};
    installed = await installPublicKey(root, discovery.jwks, publicJwk);
    const deadline = Date.now() + keyLoadTimeoutMs;
    let loaded = false;
    while (Date.now() < deadline) {
      if (!isAlive(device.pid)) throw grpcError('Managed emulator exited during JWT registration');
      try {
        const active = JSON.parse((await secureRead(root, discovery.activeFile, 256 * 1024, true)).content);
        loaded = Array.isArray(active.keys) && active.keys.some(key => key.kid === publicJwk.kid && key.kty === 'EC' && key.crv === 'P-256' && key.x === publicJwk.x && key.y === publicJwk.y);
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
      }
      if (loaded) break;
      await new Promise(resolve => setTimeout(resolve, Math.min(pollIntervalMs, Math.max(1, deadline - Date.now()))));
    }
    if (!loaded) throw grpcError('Emulator did not acknowledge the media public key');
    return Object.freeze({
      address,
      async headers(method) {
        if (closed || !privateKey) throw grpcError('Emulator media credentials are closed');
        if (!GRPC_METHODS.includes(method)) throw grpcError('Emulator media RPC is not permitted');
        try {
          const current = await readDiscovery({config, device, root, directory, isAlive});
          if (current.fingerprint !== discovery.fingerprint) throw grpcError('Managed emulator gRPC discovery changed');
          const time = Math.floor(now() / 1000);
          if (!Number.isSafeInteger(time) || time < 1) throw grpcError();
          // The SDK's Tink validator does not configure an expected type and
          // rejects a JWT that supplies typ. Keep only its supported fields.
          const header = Buffer.from(JSON.stringify({alg: 'ES256', kid: publicJwk.kid})).toString('base64url');
          const payload = Buffer.from(JSON.stringify({iss: GRPC_ISSUER, aud: [method], iat: time - 1, exp: time + 60, jti: randomUUID()})).toString('base64url');
          const input = `${header}.${payload}`;
          const signature = sign('sha256', Buffer.from(input), {key: privateKey, dsaEncoding: 'ieee-p1363'}).toString('base64url');
          return {authorization: `Bearer ${input}.${signature}`};
        } catch (error) {
          await close().catch(() => {});
          if (error.code === 'emulator_grpc_unavailable') throw error;
          throw grpcError();
        }
      },
      close,
    });
  } catch (error) {
    await close().catch(() => {});
    if (error.code === 'emulator_grpc_unavailable') throw error;
    throw grpcError();
  }
}

module.exports = {resolveEmulatorGrpc, grpcAllowlistPath, GRPC_ISSUER, GRPC_METHODS, GRPC_ALLOWLIST};
