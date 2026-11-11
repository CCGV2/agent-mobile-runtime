#!/usr/bin/env node
'use strict';

// Explicit, private installation only. Serving never invokes this installer.
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const {spawn} = require('node:child_process');
const {createHash, randomUUID} = require('node:crypto');
const {pipeline} = require('node:stream/promises');
const {Transform} = require('node:stream');
const {inspectLinuxHost} = require('../src/linux-host.cjs');
const {Provisioner} = require('../src/provision.cjs');
const MANIFEST = require('./linux-sdk-manifest.json');
const ALLOWED_HOSTS = new Set(['dl.google.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const MAX_ARCHIVE = 512 * 1024 * 1024;

function parse(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (!['--root', '--python', '--java', '--plan', '--accept-sdk-licenses', '--with-webrtc'].includes(key) || Object.hasOwn(result, key)) throw new Error('Invalid or duplicate setup option.');
    if (['--plan', '--accept-sdk-licenses', '--with-webrtc'].includes(key)) result[key] = true;
    else {
      if (!argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Missing setup option value.');
      result[key] = argv[++index];
    }
  }
  if (typeof result['--root'] !== 'string' || !path.isAbsolute(result['--root']) || /[\x00-\x1f\x7f]/.test(result['--root']) || path.parse(result['--root']).root === result['--root']) throw new Error('--root must name an absolute private installation directory.');
  for (const key of ['--java', '--python']) if (result[key] && (!path.isAbsolute(result[key]) || /[\x00-\x1f\x7f]/.test(result[key]))) throw new Error(`${key} must be an absolute executable path.`);
  return result;
}

function validateDownloadURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Invalid setup download URL.'); }
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.has(url.hostname) || url.username || url.password || url.port && url.port !== '443' || url.hash) throw new Error('Setup download destination denied.');
  return url;
}

async function download(spec, filename, redirects = 0) {
  const url = validateDownloadURL(spec.url);
  if (redirects > 5) throw new Error('Too many setup download redirects.');
  await new Promise((resolve, reject) => {
    const agent = new https.Agent({keepAlive: false});
    const req = https.get(url, {agent, rejectUnauthorized: true, signal: AbortSignal.timeout(600000)}, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const location = response.headers.location; response.resume();
        try {
          const next = validateDownloadURL(new URL(location, url).href);
          download({...spec, url: next.href}, filename, redirects + 1).then(resolve, reject);
        } catch (error) { reject(error); }
        return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error('Setup download failed.')); return; }
      let size = 0;
      const bound = new Transform({transform(chunk, _encoding, callback) {
        size += chunk.length;
        callback(size > (spec.maxBytes || MAX_ARCHIVE) ? new Error('Setup download exceeds size limit.') : null, chunk);
      }});
      pipeline(response, bound, fsSync.createWriteStream(filename, {flags: 'wx', mode: 0o600})).then(resolve, reject);
    });
    req.on('error', () => reject(new Error('Setup download failed.')));
    req.once('close', () => agent.destroy());
  });
}

async function digest(filename, maxBytes = MAX_ARCHIVE) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Invalid setup archive.');
  const hash = createHash('sha256');
  for await (const chunk of fsSync.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}

async function execute(file, args, {env, input, timeoutMs = 600000} = {}) {
  return new Promise((resolve, reject) => {
    const previousMask = process.umask(0o077);
    let child;
    try { child = spawn(file, args, {env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']}); }
    finally { process.umask(previousMask); }
    let stdout = ''; let stderr = ''; let bytes = 0; let failed;
    const timer = setTimeout(() => { failed = new Error('Setup command timed out.'); child.kill('SIGKILL'); }, timeoutMs);
    const collect = name => chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) { failed = new Error('Setup command output exceeds limit.'); child.kill('SIGKILL'); return; }
      if (name === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
    child.stdin.on('error', () => {});
    child.once('error', () => { failed = new Error('Setup dependency could not start.'); });
    child.once('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) {
        const error = failed || new Error(`Setup command failed: ${path.basename(file)}.`);
        error.diagnostics = {tool: path.basename(file), code, stdout, stderr}; reject(error);
      } else resolve({stdout, stderr});
    });
    child.stdin.end(input || '');
  });
}

const EXTRACT = String.raw`
import os,sys,stat,zipfile,tarfile,pathlib,shutil
archive, destination = sys.argv[1:]
base=pathlib.Path(destination)
base.mkdir(mode=0o700)
entries=[]
total=0
seen=set()
def safe(name,size,mode,directory):
 global total
 if not isinstance(name,str) or not name or '\\' in name or any(ord(c)<32 for c in name): raise ValueError('unsafe name')
 if chr(92) in name: raise ValueError('backslash denied')
 parts=pathlib.PurePosixPath(name).parts
 if name.startswith('/') or any(p in ('..','') or ':' in p for p in parts): raise ValueError('unsafe path')
 key='/'.join(parts)
 if key in seen: raise ValueError('duplicate path')
 seen.add(key)
 total+=size
 if total>2*1024**3 or len(seen)>20000: raise ValueError('archive limit')
 if stat.S_ISLNK(mode) or not directory and stat.S_IFMT(mode) not in (0,stat.S_IFREG): raise ValueError('links and special files denied')
 return base.joinpath(*parts)
def write(target,source,mode):
 target.parent.mkdir(mode=0o700,parents=True,exist_ok=True)
 with open(target,'xb') as output: shutil.copyfileobj(source,output)
 os.chmod(target,0o700 if mode&0o111 else 0o600)
if zipfile.is_zipfile(archive):
 with zipfile.ZipFile(archive) as data:
  for item in data.infolist():
   mode=item.external_attr>>16
   target=safe(item.filename,item.file_size,mode,item.is_dir())
   if item.is_dir(): target.mkdir(mode=0o700,parents=True,exist_ok=True)
   else:
    with data.open(item) as source: write(target,source,mode)
else:
 with tarfile.open(archive,'r:gz') as data:
  for item in data:
   mode=(stat.S_IFDIR if item.isdir() else stat.S_IFREG if item.isfile() else stat.S_IFLNK)|item.mode
   target=safe(item.name,item.size,mode,item.isdir())
   if item.isdir(): target.mkdir(mode=0o700,parents=True,exist_ok=True)
   else:
    with data.extractfile(item) as source: write(target,source,mode)
`;

const METADATA = String.raw`
import sys,json,xml.etree.ElementTree as E,urllib.parse
result=[]
for item in json.loads(sys.argv[1]):
 root=E.parse(item['file']).getroot()
 for package in root.findall('.//remotePackage'):
  if package.get('path') not in json.loads(sys.argv[2]): continue
  channel=package.find('channelRef')
  if channel is not None and channel.get('ref')!='channel-0': continue
  revision=package.find('revision')
  version='.'.join(revision.findtext(part) or '0' for part in ('major','minor','micro'))
  for archive in package.findall('archives/archive'):
   host=archive.findtext('host-os')
   if archive.findtext('host-arch') not in (None,'x86_64','x64'): continue
   if host not in (None,'linux'): continue
   complete=archive.find('complete')
   if complete is None: continue
   checksum=complete.find('checksum')
   result.append({'path':package.get('path'),'revision':version,'url':urllib.parse.urljoin(item['url'],complete.findtext('url')),'checksum':checksum.text,'checksumType':checksum.get('type') or ('sha1' if len(checksum.text)==40 else 'sha256')})
print(json.dumps(result))
`;

async function resolveExecutable(value, names) {
  const candidates = value ? [value] : (process.env.PATH || '/usr/bin:/bin').split(path.delimiter).filter(path.isAbsolute).flatMap(directory => names.map(name => path.join(directory, name)));
  for (const candidate of candidates) {
    try { await fs.access(candidate, fsSync.constants.X_OK); const real = await fs.realpath(candidate); if ((await fs.stat(real)).isFile()) return real; } catch {}
  }
  throw new Error(`Missing required local executable: ${names[0]}.`);
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, {mode: 0o700});
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Setup directory must be private and not a symlink.');
  await fs.chmod(directory, 0o700);
}

async function claimRoot(directory, kind = 'agent-mobile-linux-setup') {
  let ancestor = path.parse(directory).root;
  for (const component of path.relative(ancestor, path.dirname(directory)).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, component);
    try { await fs.mkdir(ancestor, {mode: 0o700}); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const info = await fs.lstat(ancestor);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o022 && !(info.mode & 0o1000)) throw new Error('Setup parent directories must not be symlinks or writable by other users.');
  }
  let created = false;
  try { await fs.mkdir(directory, {mode: 0o700}); created = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid && stat.uid !== process.getuid()) throw new Error('Setup root must be an owned directory, not a symlink.');
  const entries = await fs.readdir(directory);
  if (!created && entries.length) {
    // Do not infer authority over a partially installed SDK or existing service.
    throw new Error('Refusing to modify a nonempty setup root; use a fresh private directory.');
  }
  await fs.chmod(directory, 0o700);
  await fs.writeFile(path.join(directory, 'setup-owner.json'), JSON.stringify({schema: 1, kind})+'\n', {flag: 'wx', mode: 0o600});
  return fs.realpath(directory);
}

async function protectTree(directory, policy, budget = {entries: 0}) {
  for (const name of await fs.readdir(directory)) {
    if (++budget.entries > 100000) throw new Error('Installed tree exceeds setup limits.');
    const filename = path.join(directory, name);
    const stat = await fs.lstat(filename);
    if (stat.isSymbolicLink()) {
      const venv = path.join(policy.root, 'webrtc', 'venv');
      if (!policy.withWebRTC || !filename.startsWith(venv + path.sep)) throw new Error('Installed tree contains an unsupported link.');
      // A standard POSIX venv links lib64 internally and its Python launchers
      // to the chosen interpreter. Validate those links without chmod/following
      // a host executable or accepting arbitrary global site-packages.
      const target = await fs.realpath(filename);
      const internal = target.startsWith(venv + path.sep);
      const launcher = path.dirname(filename) === path.join(venv, 'bin') && /^(?:python|python3|python3\.[0-9]+)$/.test(path.basename(filename)) && target === policy.python;
      if (!internal && !launcher) throw new Error('Virtual environment link escapes its managed boundary.');
      continue;
    }
    if (!stat.isDirectory() && !stat.isFile()) throw new Error('Installed tree contains an unsupported special file.');
    await fs.chmod(filename, stat.isDirectory() || stat.mode & 0o111 ? 0o700 : 0o600);
    if (stat.isDirectory()) await protectTree(filename, policy, budget);
  }
}

function environment(root, java, python) {
  const javaHome = path.join(root, 'home').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return {
    PATH: [...new Set([path.dirname(java), path.dirname(python), path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'])].join(path.delimiter),
    HOME: path.join(root, 'home'), TMPDIR: path.join(root, 'tmp'), LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    JAVA_HOME: path.dirname(path.dirname(java)), PYTHONNOUSERSITE: '1', PYTHONUNBUFFERED: '1',
    JAVA_TOOL_OPTIONS: `-Duser.home="${javaHome}"`,
    XDG_CONFIG_HOME: path.join(root, 'config-home'), XDG_DATA_HOME: path.join(root, 'user-data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_RUNTIME_DIR: path.join(root, 'runtime'),
    ANDROID_HOME: path.join(root, 'sdk'), ANDROID_SDK_ROOT: path.join(root, 'sdk'),
    ANDROID_USER_HOME: path.join(root, 'android-home'), ANDROID_AVD_HOME: path.join(root, 'templates'), ANDROID_EMULATOR_HOME: path.join(root, 'emulator-home'),
  };
}

function normalizeAVDConfig(original) {
  // SDK command-line tools 22 emit these hardware-schema placeholders for a
  // fresh AVD. Leaving <temp> creates a nonexistent writable-data reference.
  // Drop only the exact observed generator values, so the emulator creates its
  // default data inside each managed clone and derives identity from its AVD
  // registry. Unknown path values remain subject to Provisioner validation.
  const placeholders = new Map([
    ['disk.dataPartition.path', '<temp>'], ['avd.id', '<build>'], ['avd.name', '<build>'],
  ]);
  const settings = { 'hw.lcd.width': '720', 'hw.lcd.height': '1280', 'hw.lcd.density': '320', 'hw.ramSize': '2048', 'hw.cpu.ncore': '2', 'hw.gpu.enabled': 'yes', 'hw.gpu.mode': 'software', 'hw.camera.back': 'none', 'hw.camera.front': 'none', 'hw.audioInput': 'no', 'hw.audioOutput': 'yes', 'showDeviceFrame': 'no', 'fastboot.forceColdBoot': 'yes' };
  const content = original.split(/\r?\n/).filter(line => {
    const split = line.indexOf('=');
    const key = (split === -1 ? line : line.slice(0, split)).trim();
    const value = split === -1 ? undefined : line.slice(split + 1).trim();
    return !Object.hasOwn(settings, key) && !(placeholders.has(key) && placeholders.get(key) === value);
  }).filter(Boolean);
  content.push(...Object.entries(settings).map(([key, value]) => `${key}=${value}`));
  return content.join('\n')+'\n';
}

function plan(options) {
  const root = path.resolve(options['--root']);
  return {schema: 1, mode: 'plan', target: 'linux-x64', root,
    sdkPackages: MANIFEST.sdkPackages, downloads: [MANIFEST.commandLineTools, MANIFEST.scrcpy],
    sdkLicensesRequired: true, requiresNonRoot: true, requiresKVMForAcceptance: true,
    withWebRTC: options['--with-webrtc'] === true, webRTCEnabled: false,
    configPath: path.join(root, 'config.json'), startsService: false, startsEmulator: false,
    prerequisites: ['Node 22+', 'JDK 17+', 'Python 3.11+', 'FFmpeg/ffprobe for recording', 'read/write /dev/kvm and emulator -accel-check for acceptance']};
}

async function main(argv = process.argv.slice(2), hooks = {}) {
  const options = parse(argv);
  if (options['--plan']) return plan(options);
  if ((hooks.platform || process.platform) !== 'linux' || (hooks.architecture || process.arch) !== 'x64') throw new Error('Apply supports only native Linux x86_64. Use --plan on another platform.');
  if ((hooks.uid ?? process.getuid?.()) === 0) throw new Error('Run setup as a dedicated non-root user.');
  if (!options['--accept-sdk-licenses']) throw new Error('Apply requires explicit --accept-sdk-licenses; SDK licenses are not accepted automatically.');
  // Hooks are trusted in-process test collaborators, never CLI or config input.
  const manifest = hooks.manifest || MANIFEST;
  for (const spec of [manifest.commandLineTools, manifest.scrcpy]) {
    validateDownloadURL(spec.url);
    if (!/^[a-f0-9]{64}$/.test(spec.sha256 || '')) throw new Error('Invalid pinned setup digest.');
  }
  if (JSON.stringify(manifest.sdkPackages) !== JSON.stringify(MANIFEST.sdkPackages) || JSON.stringify(manifest.repositories) !== JSON.stringify(MANIFEST.repositories)) throw new Error('SDK package or repository selection is fixed.');
  const run = hooks.execute || execute;
  const get = hooks.download || download;
  const java = await resolveExecutable(options['--java'], ['java']);
  const python = await resolveExecutable(options['--python'], ['python3.12', 'python3']);
  const rootPath = path.resolve(options['--root']);
  const preliminary = environment(rootPath, java, python);
  const version = await run(java, ['-version'], {env: preliminary, timeoutMs: 10000});
  const match = /(?:^|\r?\n)(?:java|openjdk)\s+(?:version\s+)?"?(\d+)(?:\.(\d+))?/.exec(version.stderr || version.stdout || '');
  if (!match || Number(match[1]) < 17) throw new Error('JDK 17 or newer is required.');
  const pyVersion = await run(python, ['-c', 'import sys,json;print(json.dumps(list(sys.version_info[:2])))'], {env: preliminary, timeoutMs: 10000});
  const py = JSON.parse(pyVersion.stdout);
  if (py[0] !== 3 || py[1] < 11 || py[1] > 14) throw new Error('Python 3.11-3.14 is required; Python 3.12 is recommended.');
  const root = await claimRoot(rootPath);
  const env = environment(root, java, python);
  let step = 'directories';
  try {
    for (const directory of ['sdk', 'tools', 'downloads', 'staging', 'home', 'tmp', 'android-home', 'templates', 'emulator-home', 'data', 'runtime', 'cache', 'config-home', 'user-data']) await privateDirectory(path.join(root, directory));
    const statusFile = path.join(root, 'setup-status.json');
    await fs.writeFile(statusFile, JSON.stringify({schema: 1, state: 'installing', startsService: false})+'\n', {flag: 'wx', mode: 0o600});
    const provenance = {schema: 1, target: 'linux-x64', installedAt: new Date().toISOString(), downloads: [], sdkPackages: []};
    const unpack = async (spec, filename, destination) => {
      step = `download-${filename}`;
      const archive = path.join(root, 'downloads', filename);
      await get(spec, archive);
      const actual = await digest(archive);
      if (actual !== spec.sha256) throw new Error('Setup archive SHA-256 mismatch.');
      provenance.downloads.push({url: spec.url, sha256: actual, version: spec.version});
      step = `extract-${filename}`;
      if (hooks.extract) await hooks.extract(archive, destination);
      else await run(python, ['-c', EXTRACT, archive, destination], {env});
    };
    const toolsStage = path.join(root, 'staging', `cmdline-${randomUUID()}`);
    await unpack(manifest.commandLineTools, 'command-line-tools-22.zip', toolsStage);
    await privateDirectory(path.join(root, 'sdk', 'cmdline-tools'));
    const commandRoot = path.join(root, 'sdk', 'cmdline-tools', '22.0');
    await fs.rename(path.join(toolsStage, 'cmdline-tools'), commandRoot);
    const sdkmanager = path.join(commandRoot, 'bin', 'sdkmanager');
    const avdmanager = path.join(commandRoot, 'bin', 'avdmanager');
    for (const filename of [sdkmanager, avdmanager]) {
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid SDK command-line tools archive layout.');
      await fs.chmod(filename, 0o700);
    }
    step = 'sdk-licenses';
    await run(sdkmanager, [`--sdk_root=${env.ANDROID_SDK_ROOT}`, '--licenses'], {env, input: 'y\n'.repeat(100)});
    step = 'sdk-packages';
    await run(sdkmanager, [`--sdk_root=${env.ANDROID_SDK_ROOT}`, '--channel=0', '--install', ...manifest.sdkPackages], {env, input: 'y\n'.repeat(100), timeoutMs: 1800000});
    const metadata = [];
    for (const [index, url] of manifest.repositories.entries()) {
      const filename = path.join(root, 'downloads', `repository-${index}.xml`);
      await get({url, maxBytes: 16 * 1024 * 1024}, filename);
      metadata.push({file: filename, url});
      provenance.downloads.push({url, sha256: await digest(filename, 16 * 1024 * 1024), dynamicRepositoryMetadata: true});
    }
    const info = await run(python, ['-c', METADATA, JSON.stringify(metadata), JSON.stringify(manifest.sdkPackages)], {env, timeoutMs: 30000});
    const archives = JSON.parse(info.stdout);
    if (!Array.isArray(archives)) throw new Error('Invalid SDK repository metadata.');
    for (const name of manifest.sdkPackages) {
      const installed = path.join(root, 'sdk', ...name.split(';'), 'source.properties');
      const stat = await fs.lstat(installed);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid installed SDK properties.');
      const properties = await fs.readFile(installed, 'utf8');
      const revision = /^Pkg\.Revision\s*=\s*(.+)$/m.exec(properties)?.[1]?.trim();
      const archive = archives.find(item => item.path === name && item.revision.split('.').map(Number).join('.') === (revision || '').split('.').map(Number).concat([0, 0]).slice(0, 3).join('.'));
      if (!revision || !archive || !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(archive.checksum)) throw new Error('Installed SDK revision could not be matched to official repository metadata.');
      validateDownloadURL(archive.url);
      if (new URL(archive.url).hostname !== 'dl.google.com') throw new Error('SDK package source denied.');
      provenance.sdkPackages.push({...archive, installedRevision: revision, sourcePropertiesSha256: createHash('sha256').update(properties).digest('hex')});
    }
    const scrcpyStage = path.join(root, 'staging', `scrcpy-${randomUUID()}`);
    await unpack(manifest.scrcpy, 'scrcpy-linux-x86_64-5.0.1.tar.gz', scrcpyStage);
    const scrcpyRoot = path.join(root, 'tools', 'scrcpy');
    await fs.rename(path.join(scrcpyStage, 'scrcpy-linux-x86_64-v5.0.1'), scrcpyRoot);
    const scrcpy = path.join(scrcpyRoot, 'scrcpy');
    if (!(await fs.lstat(scrcpy)).isFile()) throw new Error('Invalid scrcpy archive layout.');
    await fs.chmod(scrcpy, 0o700);
    step = 'clean-template';
    const avd = path.join(root, 'templates', 'clean35.avd');
    await run(avdmanager, ['create', 'avd', '--name', 'agent-mobile-clean35', '--package', 'system-images;android-35;default;x86_64', '--path', avd], {env, input: 'no\n'});
    const avdConfig = path.join(avd, 'config.ini');
    const avdStat = await fs.lstat(avdConfig);
    if (!avdStat.isFile() || avdStat.isSymbolicLink() || avdStat.size > 65536) throw new Error('Invalid fresh AVD configuration.');
    const original = await fs.readFile(avdConfig, 'utf8');
    await fs.writeFile(avdConfig, normalizeAVDConfig(original), {mode: 0o600}); await fs.chmod(avdConfig, 0o600);
    const dependencies = {};
    for (const name of ['ffmpeg', 'ffprobe']) {
      try { dependencies[name] = await resolveExecutable(undefined, [name]); } catch { dependencies[name] = null; }
    }
    const config = {dataDir: path.join(root, 'data'), sdkRoot: path.join(root, 'sdk'), scrcpyPath: scrcpy,
      ffmpegPath: dependencies.ffmpeg || 'ffmpeg', ffprobePath: dependencies.ffprobe || 'ffprobe', headless: true,
      maxDevices: 1, controlPort: 7341, adbServerPort: 5038, emulatorPortStart: 5554,
      bootTimeoutMs: 600000, stopTimeoutMs: 60000, templates: {clean35: {avdDir: avd}}, webrtc: {enabled: false}};
    step = 'validate-template';
    await new Provisioner({config}).validateTemplate('clean35');
    const configPath = path.join(root, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2)+'\n', {flag: 'wx', mode: 0o600});
    if (options['--with-webrtc']) {
      try { await fs.lstat(path.join(root, 'data', 'service.lock')); throw new Error('A runtime service started during setup; stop it before changing its configuration.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      step = 'webrtc-dependencies';
      await run(process.execPath, [path.join(__dirname, 'setup-webrtc.cjs'), '--config', configPath, '--sdk', config.sdkRoot, '--python', python, '--output', path.join(root, 'webrtc')], {env, timeoutMs: 1800000});
      try { await fs.lstat(path.join(root, 'data', 'service.lock')); throw new Error('A runtime service started during setup; configuration was not replaced.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      // Preparing dependencies never turns on media access implicitly.
      config.webrtc = {enabled: false, pythonPath: path.join(root, 'webrtc', 'venv', 'bin', 'python'), protoDir: path.join(root, 'webrtc', 'proto')};
      await fs.writeFile(configPath, JSON.stringify(config, null, 2)+'\n', {mode: 0o600});
    }
    step = 'host-checks';
    try { await fs.lstat(path.join(root, 'data', 'service.lock')); throw new Error('A runtime service started during setup; finish acceptance separately.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const host = await (hooks.inspectLinuxHost || inspectLinuxHost)({architecture: 'x64', headless: true});
    const kvm = hooks.kvmAvailable ? await hooks.kvmAvailable() : host.ok;
    let acceleration = false;
    try { await run(path.join(root, 'sdk', 'emulator', 'emulator'), ['-accel-check'], {env, timeoutMs: 15000}); acceleration = true; } catch {}
    const checks = {};
    for (const [name, filename, args] of [['emulator', path.join(root, 'sdk', 'emulator', 'emulator'), ['-version']], ['adb', path.join(root, 'sdk', 'platform-tools', 'adb'), ['version']], ['scrcpy', scrcpy, ['--version']], ['ffmpeg', dependencies.ffmpeg, ['-version']], ['ffprobe', dependencies.ffprobe, ['-version']]]) {
      if (!filename) { checks[name] = {ok: false}; continue; }
      try { const output = await run(filename, args, {env, timeoutMs: 15000}); checks[name] = {ok: true, version: (output.stdout || output.stderr || '').split(/\r?\n/).find(Boolean)?.slice(0, 160)}; }
      catch { checks[name] = {ok: false}; }
    }
    const result = {schema: 1, state: 'prepared', ready: false, prerequisitesReady: !!(kvm && acceleration && Object.values(checks).every(check => check.ok)),
      configPath, sdkRoot: config.sdkRoot, template: 'clean35', kvm, host, acceleration, dependencies, checks, webRTCPrepared: options['--with-webrtc'] === true, webRTCEnabled: false,
      startsService: false, startsEmulator: false, realEmulatorAcceptance: 'not-run',
      next: 'Run doctor, then the disposable lifecycle and real audio/WebRTC acceptance on this Linux host before claiming deployment readiness.'};
    await protectTree(root, {root, python, withWebRTC: options['--with-webrtc'] === true});
    await fs.writeFile(path.join(root, 'install-manifest.json'), JSON.stringify(provenance, null, 2)+'\n', {flag: 'wx', mode: 0o600});
    await fs.writeFile(statusFile, JSON.stringify(result, null, 2)+'\n', {mode: 0o600});
    return result;
  } catch (error) {
    await fs.writeFile(path.join(root, 'setup-status.json'), JSON.stringify({schema: 1, state: 'failed', step, ready: false, message: error.message, diagnostics: error.diagnostics}, null, 2)+'\n', {mode: 0o600}).catch(() => {});
    throw error;
  }
}

if (require.main === module) main().then(result => process.stdout.write(JSON.stringify(result, null, 2)+'\n')).catch(error => {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
});

module.exports = {main, parse, plan, validateDownloadURL, download, digest, environment, normalizeAVDConfig, EXTRACT, MANIFEST,
  execute, resolveExecutable, claimRoot, privateDirectory, protectTree};
