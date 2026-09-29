import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sha256, verifyCandidate } from './release-candidate.mjs';

assert.equal(process.argv.length, 4, 'Usage: node publish-staging.mjs CANDIDATE_DIRECTORY STAGING_STORAGE_ROOT');
const directory = await fs.realpath(process.argv[2]);
const root = await fs.realpath(process.argv[3]);
assert.notEqual(root, path.parse(root).root, 'Refusing filesystem root');
assert.ok(!directory.startsWith(root + path.sep) && directory !== root, 'Candidate must be outside serving storage');
const expected = { channel: 'staging', version: process.env.VERSION, source_sha: process.env.SOURCE_SHA,
  workflow_sha: process.env.GITHUB_SHA, run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT };
const digest = process.env.CANDIDATE_SHA256;
assert.match(digest, /^[a-f0-9]{64}$/, 'Missing frozen candidate digest');
async function verify(location, hash, identity) {
  assert.ok((await fs.lstat(path.join(location, 'candidate.json'))).isFile(), 'Candidate metadata must be a regular file');
  assert.equal(await sha256(path.join(location, 'candidate.json')), hash, 'Candidate digest mismatch');
  const candidate = await verifyCandidate(location, identity);
  assert.equal(await sha256(path.join(location, 'candidate.json')), hash, 'Candidate changed during verification');
  assert.ok(candidate.files.some(file => file.name === 'update.json'), 'Frozen update metadata required');
  return candidate;
}
const candidate = await verify(directory, digest, expected);
assert.match(candidate.run_id, /^[1-9]\d*$/);
assert.match(candidate.run_attempt, /^[1-9]\d*$/);
const relative = `releases/${candidate.version}/${candidate.source_sha}/${candidate.run_id}-${candidate.run_attempt}`;
const destination = path.join(root, relative);
const lock = path.join(root, '.publish-lock');
// ponytail: one writer per staging volume; fail closed on a stale lock, never steal a live publisher's lock.
await fs.mkdir(lock, { mode: 0o700 });
let incoming;
try {
  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ host: os.hostname(), pid: process.pid, started_at: new Date().toISOString() }));
  let current;
  try { current = await fs.readlink(path.join(root, 'current')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (current) {
    assert.match(current, /^releases\/\d+\.\d+\.\d+\/[a-f0-9]{40}\/[1-9]\d*-[1-9]\d*$/, 'Invalid current pointer');
    const currentDirectory = path.join(root, current);
    assert.equal(await fs.realpath(currentDirectory), currentDirectory, 'Symlink in current release path');
    const currentHash = await sha256(path.join(currentDirectory, 'candidate.json'));
    const previous = await verify(currentDirectory, currentHash, { channel: 'staging' });
    if (currentHash !== digest) {
      const old = previous.version.split('.').map(Number);
      const order = candidate.version.split('.').map((part, index) => Number(part) - old[index]).find(part => part !== 0) ?? 0;
      assert.ok(order > 0, 'A different candidate must have a newer version');
    }
  }
  // Check each component instead of recursive mkdir, which would follow an unexpected symlink.
  let parent = root;
  for (const part of relative.split('/').slice(0, -1)) {
    parent = path.join(parent, part);
    try { await fs.mkdir(parent, { mode: 0o755 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    assert.ok((await fs.lstat(parent)).isDirectory(), 'Release parent must be a real directory');
    await fs.chmod(parent, 0o755); // mkdir modes alone are narrowed by the publisher's umask.
  }
  let existing;
  try { existing = await fs.lstat(destination); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    assert.ok(existing.isDirectory(), 'Release destination must be a real directory');
    await verify(destination, digest, expected);
  } else {
    const disk = await fs.statfs(root, { bigint: true });
    const size = candidate.files.reduce((sum, file) => sum + BigInt(file.size), BigInt((await fs.stat(path.join(directory, 'candidate.json'))).size));
    assert.ok(disk.bavail * disk.bsize >= size + 256n * 1024n * 1024n, 'Insufficient disk space (256 MiB reserve required)');
    incoming = await fs.mkdtemp(path.join(root, '.incoming-'));
    for (const name of [...candidate.files.map(file => file.name), 'candidate.json']) {
      await fs.copyFile(path.join(directory, name), path.join(incoming, name), constants.COPYFILE_EXCL);
      await fs.chmod(path.join(incoming, name), 0o644);
    }
    await verify(incoming, digest, expected);
    await fs.chmod(incoming, 0o755);
    await fs.rename(incoming, destination);
    incoming = undefined;
  }
  await fs.symlink(relative, path.join(lock, 'next'));
  await fs.rename(path.join(lock, 'next'), path.join(root, 'current'));
  console.log(`Published staging ${candidate.version}: ${digest}`);
} finally {
  if (incoming) await fs.rm(incoming, { recursive: true, force: true });
  await fs.rm(lock, { recursive: true, force: true });
}
