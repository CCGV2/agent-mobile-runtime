#!/usr/bin/env node
'use strict';

// Test-only APK builder. Uses an already-installed Android SDK/JDK. It does not
// download packages, accept SDK licenses, or use a production signing key.
const fs = require('node:fs/promises');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const run = promisify(execFile);

async function main() {
  const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (!sdk || !path.isAbsolute(sdk)) throw new Error('Set ANDROID_SDK_ROOT to an installed SDK.');
  const latest = async (directory, pattern) => (await fs.readdir(directory)).filter(name => pattern.test(name)).sort((a, b) => a.localeCompare(b, 'en', {numeric: true})).at(-1);
  const version = await latest(path.join(sdk, 'build-tools'), /^\d+\.\d+\.\d+$/);
  const platform = await latest(path.join(sdk, 'platforms'), /^android-\d+$/);
  if (!version || !platform || Number(platform.slice(8)) < 34) throw new Error('Install Android platform 34+ and stable SDK Build Tools.');
  const tools = path.join(sdk, 'build-tools', version);
  const jar = path.join(sdk, 'platforms', platform, 'android.jar');
  const out = path.join(__dirname, 'build');
  await fs.mkdir(path.join(out, 'classes'), {recursive: true});
  const java = name => process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', name) : name;
  const exec = (file, args) => run(file, args, {cwd: out, timeout: 60000, maxBuffer: 1024*1024, shell: false});
  await exec(java('javac'), ['-source', '8', '-target', '8', '-classpath', jar, '-d', path.join(out, 'classes'), path.join(__dirname, 'ToneActivity.java')]);
  await exec(path.join(tools, 'd8'), ['--lib', jar, '--min-api', '26', '--output', out, path.join(out, 'classes/dev/agentmobile/tone/ToneActivity.class')]);
  await exec(path.join(tools, 'aapt2'), ['link', '-I', jar, '--manifest', path.join(__dirname, 'AndroidManifest.xml'), '--min-sdk-version', '26', '--target-sdk-version', '34', '-o', 'unsigned.apk']);
  await exec('zip', ['-j', 'unsigned.apk', 'classes.dex']);
  await exec(path.join(tools, 'zipalign'), ['-f', '4', 'unsigned.apk', 'aligned.apk']);
  const keystore = path.join(out, 'fixture.jks');
  try { await fs.stat(keystore); }
  catch {
    await exec(java('keytool'), ['-genkeypair', '-alias', 'fixture', '-keyalg', 'RSA', '-keystore', keystore, '-storepass', 'android', '-keypass', 'android', '-dname', 'CN=Disposable Test Fixture', '-validity', '3650']);
  }
  await exec(path.join(tools, 'apksigner'), ['sign', '--ks', keystore, '--ks-key-alias', 'fixture', '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', 'tone.apk', 'aligned.apk']);
  process.stdout.write(path.join(out, 'tone.apk') + '\n');
}

main().catch(() => { process.stderr.write('Fixture build failed. Verify SDK platform 34+, stable Build Tools, JDK, and zip.\n'); process.exitCode = 1; });
