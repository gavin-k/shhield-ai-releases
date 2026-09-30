import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { offeredPlatforms, sha256, verifyCandidate, websiteManifest } from './release-candidate.mjs';

const repository = process.env.GITHUB_REPOSITORY;
assert.equal(repository, 'gavin-k/shhield-ai-releases');
const directory = path.resolve(process.argv[2]);
const candidate = await verifyCandidate(directory, {
  channel: 'production', version: process.env.VERSION, source_sha: process.env.SOURCE_SHA,
  workflow_sha: process.env.GITHUB_SHA, run_id: process.env.GITHUB_RUN_ID,
});
assert.equal(await sha256(path.join(directory, 'candidate.json')), process.env.CANDIDATE_SHA256);

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
function release(ref) {
  try { return JSON.parse(gh('api', `repos/${repository}/releases/${ref}`)); }
  catch (error) {
    if (String(error.stderr).includes('(HTTP 404)')) return null;
    throw error;
  }
}
function compareVersions(a, b) {
  const left = a.replace(/^v/, '').split('.').map(Number);
  const right = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}

const tag = `v${candidate.version}`;
const latest = release('latest');
if (latest && /^v\d+\.\d+\.\d+$/.test(latest.tag_name)) {
  assert.ok(compareVersions(tag, latest.tag_name) >= 0, 'An older candidate cannot replace the latest release');
}
if (latest) {
  const offered = offeredPlatforms(candidate.files.map(file => file.name));
  const dropped = offeredPlatforms(latest.assets.map(asset => asset.name)).filter(platform => !offered.includes(platform));
  assert.deepEqual(dropped, [], 'The candidate would remove platforms the latest release already offers');
}
let current = release(`tags/${tag}`);
if (!current) {
  gh('release', 'create', tag, '--repo', repository, '--draft', '--target', candidate.workflow_sha,
    '--title', `Shhield AI ${tag}`, '--notes', `Shhield AI ${tag}`);
  current = release(`tags/${tag}`);
}
assert.ok(current && !current.prerelease, 'Unexpected prerelease at final version tag');
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'shhield-publish-'));
try {
  const publishedAt = current.created_at;
  const manifestFile = path.join(temporary, 'latest.json');
  await fs.writeFile(manifestFile, JSON.stringify(websiteManifest(candidate, publishedAt), null, 2) + '\n');
  const files = [...candidate.files.map(file => path.join(directory, file.name)), path.join(directory, 'candidate.json'), manifestFile];
  const expectedNames = files.map(file => path.basename(file));
  assert.ok(current.assets.every(asset => expectedNames.includes(asset.name)), 'Release contains unexpected assets');

  for (const file of files) {
    const name = path.basename(file);
    const expectedHash = await sha256(file);
    const existing = current.assets.find(asset => asset.name === name);
    if (existing) {
      // Downloading also supports assets uploaded before GitHub exposed their digest.
      const checkDirectory = await fs.mkdtemp(path.join(temporary, 'asset-'));
      gh('release', 'download', tag, '--repo', repository, '--pattern', name, '--dir', checkDirectory);
      assert.equal(await sha256(path.join(checkDirectory, name)), expectedHash, `Refusing to replace ${name}`);
    } else {
      assert.ok(current.draft, 'Cannot add missing files to an already published version');
      gh('release', 'upload', tag, file, '--repo', repository);
    }
  }

  const uploaded = release(`tags/${tag}`);
  assert.deepEqual(uploaded.assets.map(asset => asset.name).sort(), expectedNames.sort());
  for (const file of files) {
    const asset = uploaded.assets.find(item => item.name === path.basename(file));
    assert.equal(asset.size, (await fs.stat(file)).size);
    if (asset.digest) assert.equal(asset.digest, `sha256:${await sha256(file)}`);
    else {
      const checkDirectory = await fs.mkdtemp(path.join(temporary, 'uploaded-'));
      gh('release', 'download', tag, '--repo', repository, '--pattern', asset.name, '--dir', checkDirectory);
      assert.equal(await sha256(path.join(checkDirectory, asset.name)), await sha256(file));
    }
  }
  // The download domain follows GitHub's latest pointer; switch it only after all assets pass.
  gh('release', 'edit', tag, '--repo', repository, '--draft=false', '--latest');
  const response = await fetch('https://download.shhield.ai/stable/latest.json', { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, 'Release published but download manifest is unavailable; retry this publish job');
  assert.deepEqual(await response.json(), websiteManifest(candidate, publishedAt), 'Website release does not match the approved candidate');
  console.log(`Published original candidate: ${uploaded.html_url}`);
} finally {
  await fs.rm(temporary, { recursive: true, force: true });
}
