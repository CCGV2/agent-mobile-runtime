'use strict';

const fs = require('node:fs/promises');
const {constants} = require('node:fs');

// These are host requirements, not destinations or paths chosen by an API caller.
const KVM_DEVICE = '/dev/kvm';
const CPU_INFO = '/proc/cpuinfo';

async function inspectLinuxHost({architecture = process.arch, headless = true, filesystem = fs} = {}) {
  const result = {
    ok: false,
    architecture,
    headless,
    kvm: {path: KVM_DEVICE, present: false, characterDevice: false, readable: false, writable: false},
    virtualization: {cpuFlagsAvailable: false, hardwareFlags: null, hypervisor: null, nestedMayBeRequired: null},
    remediation: [],
  };
  if (architecture !== 'x64') result.remediation.push('This Linux backend currently supports x86_64 only. Use an x86_64 host and image; Linux ARM64 is not validated.');
  if (!headless) result.remediation.push('Linux desktop windows are not supported. Set headless=true and use the authenticated viewer; a dedicated Xvfb backend is not configured.');

  try {
    const text = await filesystem.readFile(CPU_INFO, 'utf8');
    if (typeof text === 'string' && Buffer.byteLength(text) <= 1024 * 1024) {
      const line = /^flags\s*:\s*(.*)$/m.exec(text);
      if (line) {
        const flags = new Set(line[1].split(/\s+/));
        result.virtualization = {
          cpuFlagsAvailable: true,
          hardwareFlags: flags.has('vmx') || flags.has('svm'),
          hypervisor: flags.has('hypervisor'),
          nestedMayBeRequired: flags.has('hypervisor'),
        };
      }
    }
  } catch { /* CPU flags are advisory; actual SDK acceleration remains authoritative. */ }

  try {
    const stat = await filesystem.lstat(KVM_DEVICE);
    result.kvm.present = true;
    result.kvm.characterDevice = !stat.isSymbolicLink() && stat.isCharacterDevice();
    if (result.kvm.characterDevice) {
      try { await filesystem.access(KVM_DEVICE, constants.R_OK); result.kvm.readable = true; } catch {}
      try { await filesystem.access(KVM_DEVICE, constants.W_OK); result.kvm.writable = true; } catch {}
    }
  } catch { /* Report an absent or inaccessible fixed device without exposing OS errors. */ }

  if (!result.kvm.characterDevice) result.remediation.push('Provide the real /dev/kvm character device. A VM needs nested virtualization; a Linux container needs the host device passed through. Software CPU emulation is not used as a fallback.');
  else if (!result.kvm.readable || !result.kvm.writable) result.remediation.push('Grant this user read/write access through the host kvm device group and start a new login, or map that numeric group into the container. Do not make /dev/kvm world writable.');
  result.ok = architecture === 'x64' && headless && result.kvm.characterDevice && result.kvm.readable && result.kvm.writable;
  return result;
}

function accelerationDiagnostic(...streams) {
  const text = streams.filter(value => typeof value === 'string' || Buffer.isBuffer(value)).map(String).join('\n')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/\r\n?/g, '\n').trim();
  return Buffer.from(text, 'utf8').subarray(0, 512).toString('utf8');
}

module.exports = {inspectLinuxHost, accelerationDiagnostic};
