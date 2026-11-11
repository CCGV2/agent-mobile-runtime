'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');

async function privateDir(dir) {
  await fs.mkdir(dir, {recursive: true, mode: 0o700});
  // Reject symlink components, including an existing symlink to a directory.
  let current = path.resolve(dir);
  for (;;) {
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Runtime directory must not contain symbolic links.');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  await fs.chmod(dir, 0o700);
}

async function readPrivate(file) {
  const handle = await fs.open(file, require('node:fs').constants.O_RDONLY | require('node:fs').constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 1024 * 1024) throw new Error('Invalid private runtime file.');
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

async function atomicJSON(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
    await fs.rename(temp, file);
  } finally { await fs.rm(temp, {force: true}); }
}

async function writePrivate(file, value) {
  await fs.writeFile(file, value, {mode: 0o600, flag: 'wx'});
}

module.exports = {privateDir, readPrivate, atomicJSON, writePrivate};
