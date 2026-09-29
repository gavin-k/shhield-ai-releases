import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCandidate, sha256 } from './release-candidate.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shhield-staging-publish-'));
const cli = fileURLToPath(new URL('./publish-staging.mjs', import.meta.url));
const generator = fileURLToPath(new URL('./generate-update-manifests.mjs', import.meta.url));
const store = path.join(root, 'store');
const identity = { version: '1.2.3', channel: 'staging', source_sha: 'a'.repeat(40), workflow_sha: 'b'.repeat(40), run_id: '123', run_attempt: '1' };
async function prepare(id) {
  const directory = await fs.mkdtemp(path.join(root, 'candidate-'));
  const label = id.channel === 'staging' ? 'Shhield-AI-Staging' : 'Shhield-AI';
  for (const name of [`${label}-${id.version}-windows-x64.msi`, 'Shhield.zip', 'Shhield_intel_mac.zip']) {
    await fs.writeFile(path.join(directory, name), `synthetic ${name}`);
  }
  if (id.channel === 'production') for (const name of ['app.deb', 'app.rpm', 'app.flatpak']) await fs.writeFile(path.join(directory, name), name);
  execFileSync(process.execPath, [generator, directory, id.version, id.channel, id.source_sha, id.run_id, id.run_attempt]);
  await createCandidate(directory, id);
  return { directory, env: { ...process.env, VERSION: id.version, SOURCE_SHA: id.source_sha, GITHUB_SHA: id.workflow_sha,
    GITHUB_RUN_ID: id.run_id, GITHUB_RUN_ATTEMPT: id.run_attempt, CANDIDATE_SHA256: await sha256(path.join(directory, 'candidate.json')) } };
}
const publish = (batch, destination = store) => spawnSync(process.execPath, [cli, batch.directory, destination], { env: batch.env, encoding: 'utf8' });
try {
  await fs.mkdir(store);
  const first = await prepare(identity);
  const result = publish(first);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(await fs.readFile(path.join(store, 'current/update.json'), 'utf8')).channel, 'staging');
  assert.equal(await sha256(path.join(store, 'current/candidate.json')), first.env.CANDIDATE_SHA256);
  assert.equal(await fs.readFile(path.join(store, 'current/Shhield.zip'), 'utf8'), 'synthetic Shhield.zip');
  assert.equal(publish(first).status, 0, 'identical retry is idempotent');
  const stillFirst = async () => assert.equal(await sha256(path.join(store, 'current/candidate.json')), first.env.CANDIDATE_SHA256);
  const next = await prepare({ ...identity, version: '1.2.4', run_id: '124' });
  const rejected = publish({ ...next, env: { ...next.env, CANDIDATE_SHA256: '0'.repeat(64) } });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /Candidate digest mismatch/);
  await stillFirst();
  const wrongChannel = publish(await prepare({ ...identity, channel: 'production', version: '1.2.4' }));
  assert.notEqual(wrongChannel.status, 0);
  assert.match(wrongChannel.stderr, /Wrong channel/);
  await stillFirst();
  const sameVersion = publish(await prepare({ ...identity, source_sha: 'c'.repeat(40), run_id: '124' }));
  assert.notEqual(sameVersion.status, 0);
  assert.match(sameVersion.stderr, /newer version/);
  await stillFirst();
  await fs.appendFile(path.join(next.directory, 'Shhield.zip'), 'tampered');
  assert.notEqual(publish(next).status, 0, 'package tampering must not change the current feed');
  await stillFirst();
  await fs.writeFile(path.join(next.directory, 'Shhield.zip'), 'synthetic Shhield.zip');
  const diskFull = `import fs from 'node:fs/promises'; fs.copyFile = async () => { throw Object.assign(new Error('simulated disk full'), { code: 'ENOSPC' }); };`;
  const failedCopy = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(diskFull)}`, cli, next.directory, store], { env: next.env, encoding: 'utf8' });
  assert.notEqual(failedCopy.status, 0);
  assert.match(failedCopy.stderr, /simulated disk full/);
  await stillFirst();
  // Kill at the external filesystem boundary immediately before the atomic pointer switch.
  const stop = `import fs from 'node:fs/promises'; const rename = fs.rename; fs.rename = async (a, b) => { if (b.endsWith('/current')) process.exit(75); return rename(a, b); };`;
  const interrupted = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(stop)}`, cli, next.directory, store], { env: next.env });
  assert.equal(interrupted.status, 75);
  await stillFirst();
  assert.notEqual(publish(next).status, 0, 'stale or live writer lock must fail closed');
  // Operator recovery only after the previous process is known to have exited.
  await fs.rm(path.join(store, '.publish-lock'), { recursive: true });
  assert.equal(publish(next).status, 0, 'reuse fully verified immutable files after an interrupted switch');
  assert.equal(await sha256(path.join(store, 'current/candidate.json')), next.env.CANDIDATE_SHA256);
  assert.notEqual(publish(first).status, 0, 'an older version cannot replace a newer one');
  assert.equal(await sha256(path.join(store, 'current/candidate.json')), next.env.CANDIDATE_SHA256);
  const unsafe = path.join(root, 'unsafe');
  const outside = path.join(root, 'outside');
  await fs.mkdir(unsafe);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(unsafe, 'releases'));
  assert.notEqual(publish(first, unsafe).status, 0, 'do not follow symlinks outside serving storage');
  assert.deepEqual(await fs.readdir(outside), []);
  const occupied = path.join(root, 'occupied');
  const occupiedRelease = path.join(occupied, `releases/1.2.3/${identity.source_sha}/123-1`);
  await fs.mkdir(occupiedRelease, { recursive: true });
  await fs.writeFile(path.join(occupiedRelease, 'candidate.json'), 'do not replace');
  assert.notEqual(publish(first, occupied).status, 0, 'never overwrite a conflicting immutable release');
  assert.equal(await fs.readFile(path.join(occupiedRelease, 'candidate.json'), 'utf8'), 'do not replace');
  await assert.rejects(fs.lstat(path.join(occupied, 'current')), { code: 'ENOENT' });
  console.log('PASS staged publication, digest/channel/hash rejection, interrupted switch recovery, anti-rollback and path containment');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
