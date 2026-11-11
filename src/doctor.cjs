'use strict';

const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const os = require('node:os');
const fs = require('node:fs/promises');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {inspectLinuxHost, accelerationDiagnostic} = require('./linux-host.cjs');
const run = promisify(execFile);

async function doctor(config, provisioner, {platform = os.platform(), architecture = os.arch(), execute = run, hostFileSystem = fs} = {}) {
  const linux = platform === 'linux' ? await inspectLinuxHost({architecture, headless: config.headless !== false, filesystem: hostFileSystem}) : undefined;
  const checks = await Promise.all([
    ['adb', config.adbPath, ['version']], ['emulator', config.emulatorPath, ['-version']],
    ['scrcpy', config.scrcpyPath, ['--version']], ['ffprobe', config.ffprobePath, ['-version']],
  ].map(async ([name, file, args]) => {
    try {
      const {stdout, stderr} = await execute(file, args, {timeout: 10000, maxBuffer: 65536, shell: false});
      return {name, ok: true, version: String(stdout || stderr).split(/\r?\n/).find(Boolean)?.slice(0, 160)};
    } catch (error) {
      return {name, ok: false, message: 'Missing or could not execute.',
        ...(platform === 'linux' ? {diagnostic: accelerationDiagnostic(error.stdout, error.stderr)} : {})};
    }
  }));
  let acceleration = {ok: false, message: 'Emulator unavailable.'};
  if (checks.find(c => c.name === 'emulator').ok) {
    try {
      const {stdout, stderr} = await execute(config.emulatorPath, ['-accel-check'], {timeout: 10000, maxBuffer: 65536, shell: false});
      acceleration = {ok: true, diagnostic: accelerationDiagnostic(stdout, stderr)};
    } catch (error) {
      acceleration = {ok: false, message: 'Hardware acceleration unavailable; inspect emulator -accel-check.',
        diagnostic: accelerationDiagnostic(error.stdout, error.stderr)};
      if (platform === 'linux') acceleration.remediation = 'Check /dev/kvm permissions and, inside a VM, host nested-virtualization support. Container access alone does not enable nested virtualization.';
    }
  }
  let templates = [];
  try { templates = await provisioner.listTemplates(); } catch { /* Report readiness below. */ }
  const webrtc = {enabled: config.webrtc?.enabled === true, mode: 'local-media-only', ready: false};
  if (webrtc.enabled) {
    try {
      const {stdout} = await execute(config.webrtc.pythonPath, ['-c', 'import json,aiortc,grpc,av;from importlib.metadata import version;print(json.dumps({"aiortc":aiortc.__version__,"aioice":version("aioice"),"grpc":grpc.__version__,"av":av.__version__}))'], {timeout: 10000, maxBuffer: 65536, shell: false});
      webrtc.versions = JSON.parse(stdout);
      if (webrtc.versions.aiortc !== '1.16.0' || webrtc.versions.aioice !== '0.13.0') throw new Error('Unreviewed ICE dependencies');
      const manifestPath = path.join(config.webrtc.protoDir, 'manifest.json');
      const manifestInfo = await fs.lstat(manifestPath);
      if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || manifestInfo.size > 16384) throw new Error('Invalid proto manifest');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      for (const name of ['emulator_controller_pb2.py', 'emulator_controller_pb2_grpc.py']) {
        const filename = path.join(config.webrtc.protoDir, name);
        const stat = await fs.lstat(filename);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4*1024*1024 || manifest.schema !== 1 || createHash('sha256').update(await fs.readFile(filename)).digest('hex') !== manifest.generated[name]) throw new Error('Invalid generated proto');
      }
      webrtc.ready = true;
    } catch { webrtc.message = 'WebRTC dependencies or SDK-generated proto are unavailable; run scripts/setup-webrtc.cjs.'; }
  }
  return {ready: checks.every(c => c.ok) && acceleration.ok && (!linux || linux.ok) && templates.some(t => t.available) && (!webrtc.enabled || webrtc.ready), platform, architecture, node: process.versions.node,
    ...(linux ? {linux} : {}),
    checks, acceleration, templates, webrtc, security: {privateDeviceData: true, hostNetworkIsolation: false, maliciousAPKIsolation: false, nativeRtcExposed: false},
    limitations: ['No host/LAN firewall is installed by this runtime.', 'Native Android only; Docker and iOS backends are not implemented.', 'Text input is printable ASCII; WebRTC currently accepts only this host’s IP addresses and no STUN/TURN.']};
}

module.exports = {doctor};
