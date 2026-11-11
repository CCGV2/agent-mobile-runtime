'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function configPath() {
  return process.env.AGENT_MOBILE_CONFIG || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'agent-mobile-runtime', 'config.json');
}

async function loadConfig(filename = configPath(), overrides = {}) {
  let input = {};
  try { input = JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid runtime configuration.'); }
  if (!input || Array.isArray(input) || typeof input !== 'object') throw new Error('Configuration must be an object.');
  const sdk = input.sdkRoot || process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : path.join(os.homedir(), 'Android', 'Sdk'));
  const data = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'agent-mobile-runtime');
  const config = {
    dataDir: data,
    sdkRoot: sdk,
    adbPath: path.join(sdk, 'platform-tools', 'adb'),
    emulatorPath: path.join(sdk, 'emulator', 'emulator'),
    scrcpyPath: 'scrcpy', ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe',
    controlPort: 7341, adbServerPort: 5038, emulatorPortStart: 5554,
    maxDevices: 2, headless: true,
    bootTimeoutMs: 180000, stopTimeoutMs: 15000,
    mediaMaxDurationSec: 300, mediaMaxBytes: 256 * 1024 * 1024,
    mediaStopTimeoutMs: 5000, artifactMaxBytes: 256 * 1024 * 1024,
    templates: {},
    ...input, ...overrides,
  };
  config.webrtc = {
    enabled: false, pythonPath: null, protoDir: null,
    leaseSeconds: 30, maxLifetimeSeconds: 600,
    maxWidth: 720, maxHeight: 1280, fps: 15,
    negotiationTimeoutMs: 15000, shutdownTimeoutMs: 3000,
    ...(input.webrtc || {}), ...(overrides.webrtc || {}),
  };
  const allowedRTC = new Set(['enabled', 'pythonPath', 'protoDir', 'leaseSeconds', 'maxLifetimeSeconds', 'maxWidth', 'maxHeight', 'fps', 'negotiationTimeoutMs', 'shutdownTimeoutMs']);
  for (const key of Object.keys(config.webrtc)) if (!allowedRTC.has(key)) throw new Error('Unknown WebRTC configuration field.');
  if (typeof config.webrtc.enabled !== 'boolean') throw new Error('Invalid WebRTC enabled setting.');
  for (const key of ['pythonPath', 'protoDir']) {
    const value = config.webrtc[key];
    if ((config.webrtc.enabled || value !== null) && (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))) throw new Error(`WebRTC ${key} must be an absolute path.`);
  }
  for (const [key, min, max] of [
    ['leaseSeconds', 10, 60], ['maxLifetimeSeconds', 30, 600], ['maxWidth', 64, 1280],
    ['maxHeight', 64, 1920], ['fps', 1, 30], ['negotiationTimeoutMs', 1000, 30000], ['shutdownTimeoutMs', 100, 10000],
  ]) {
    const value = config.webrtc[key];
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid WebRTC ${key}.`);
  }
  if (config.webrtc.maxLifetimeSeconds < config.webrtc.leaseSeconds) throw new Error('WebRTC lifetime must cover a lease.');
  Object.freeze(config.webrtc);
  for (const key of ['dataDir', 'sdkRoot', 'adbPath', 'emulatorPath']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key]) || config[key].includes('\0')) throw new Error(`${key} must be an absolute path.`);
  }
  for (const key of ['scrcpyPath', 'ffmpegPath', 'ffprobePath']) {
    if (typeof config[key] !== 'string' || !config[key] || config[key].includes('\0')) throw new Error(`Invalid ${key}.`);
  }
  for (const [key, min, max] of [
    ['controlPort', 1024, 65535], ['adbServerPort', 1024, 65535], ['emulatorPortStart', 5554, 5680],
    ['maxDevices', 1, 8], ['bootTimeoutMs', 100, 600000], ['stopTimeoutMs', 100, 60000],
    ['mediaMaxDurationSec', 1, 3600], ['mediaMaxBytes', 1024, 1024 ** 3],
    ['mediaStopTimeoutMs', 10, 60000], ['artifactMaxBytes', 1024, 1024 ** 3],
  ]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}.`);
  }
  if (config.emulatorPortStart % 2 || config.emulatorPortStart + 2 * (config.maxDevices - 1) > 5682) throw new Error('Invalid emulator port range.');
  const ports = [config.controlPort, config.adbServerPort];
  for (let i = 0; i < config.maxDevices; i++) ports.push(config.emulatorPortStart + 2*i, config.emulatorPortStart + 2*i + 1);
  if (new Set(ports).size !== ports.length) throw new Error('Runtime ports must not overlap.');
  if (typeof config.headless !== 'boolean' || !config.templates || Array.isArray(config.templates) || typeof config.templates !== 'object') throw new Error('Invalid templates or headless setting.');
  for (const [name, template] of Object.entries(config.templates)) {
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(name) || !template || !path.isAbsolute(template.avdDir || '')) throw new Error('Invalid template.');
  }
  return Object.freeze(config);
}

module.exports = {loadConfig, configPath};
