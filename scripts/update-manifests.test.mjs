import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCandidate, verifyCandidate } from './release-candidate.mjs';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shhield-update-feeds-'));
const cli = fileURLToPath(new URL('./generate-update-manifests.mjs', import.meta.url));
const sha = 'a'.repeat(40);
try {
  for (const channel of ['staging', 'production']) {
    const directory = path.join(root, channel);
    await fs.mkdir(directory);
    const label = channel === 'staging' ? 'Shhield-AI-Staging' : 'Shhield-AI';
    const files = [`${label}-1.2.3-windows-x64.msi`, `${label}-1.2.3-windows-x64-portable.zip`, 'Shhield.zip', 'Shhield_intel_mac.zip'];
    for (const name of files) await fs.writeFile(path.join(directory, name), `synthetic ${name}`);
    if (channel === 'production') for (const name of ['app.deb', 'app.rpm', 'app.flatpak']) await fs.writeFile(path.join(directory, name), name);
    const args = [cli, directory, '1.2.3', channel, sha, '123', '1'];
    execFileSync(process.execPath, args);
    const feed = JSON.parse(await fs.readFile(path.join(directory, 'update.json'), 'utf8'));
    assert.equal(feed.channel, channel === 'production' ? 'stable' : 'staging');
    assert.equal(feed.source_sha, sha);
    assert.deepEqual(feed.artifacts.map(file => file.id).sort(), ['macos-arm64', 'macos-x64', 'windows-msi', 'windows-portable']);
    const portable = feed.artifacts.find(file => file.id === 'windows-portable');
    assert.equal(portable.name, `${label}-1.2.3-windows-x64-portable.zip`);
    assert.equal(portable.format, 'zip');
    assert.equal(portable.platform, 'windows');
    assert.equal(portable.arch, 'x64');
    const prefix = channel === 'production' ? 'https://download.shhield.ai/releases/1.2.3/'
      : `https://download.shhield.ai/staging/releases/1.2.3/${sha}/123-1/`;
    for (const file of feed.artifacts) {
      assert.equal(file.url, prefix + file.name);
      assert.equal(file.sha256, createHash('sha256').update(`synthetic ${file.name}`).digest('hex'));
    }
    const mac = JSON.parse(await fs.readFile(path.join(directory, 'latest-mac.yml'), 'utf8')); // JSON is valid YAML.
    assert.equal(mac.version, '1.2.3');
    assert.deepEqual(mac.files.map(file => file.url), [prefix + 'Shhield-darwin-arm64.zip', prefix + 'Shhield-darwin-x64.zip']);
    assert.equal(mac.files[0].sha512, createHash('sha512').update('synthetic Shhield.zip').digest('base64'));
    assert.deepEqual(await fs.readFile(path.join(directory, 'Shhield-darwin-arm64.zip')), await fs.readFile(path.join(directory, 'Shhield.zip')));
    assert.notEqual(spawnSync(process.execPath, args).status, 0, 'must not overwrite frozen metadata');
    const identity = { version: '1.2.3', channel, source_sha: sha, workflow_sha: 'b'.repeat(40), run_id: '123', run_attempt: '1' };
    const originalFeed = await fs.readFile(path.join(directory, 'update.json'), 'utf8');
    await fs.writeFile(path.join(directory, 'update.json'), JSON.stringify({ ...feed, channel: channel === 'production' ? 'staging' : 'stable' }));
    await assert.rejects(createCandidate(directory, identity), /update channel/);
    await fs.writeFile(path.join(directory, 'update.json'), originalFeed);
    const badHash = structuredClone(feed);
    badHash.artifacts[0].sha256 = '0'.repeat(64);
    await fs.writeFile(path.join(directory, 'update.json'), JSON.stringify(badHash));
    await assert.rejects(createCandidate(directory, identity), /update artifact/);
    await fs.writeFile(path.join(directory, 'update.json'), originalFeed);
    const candidate = await createCandidate(directory, identity);
    assert.ok(candidate.files.some(file => file.name === 'update.json'));
    await verifyCandidate(directory, identity);
    await fs.appendFile(path.join(directory, 'latest-mac.yml'), ' ');
    await assert.rejects(verifyCandidate(directory, identity), /Wrong size|Wrong SHA-256/);
  }
  // Windows certificate pending: unsigned staging MSI without Portable, and production without Windows.
  for (const [channel, env, files, ids] of [
    ['staging', { WINDOWS_SIGNING: 'unsigned' }, ['Shhield-AI-Staging-1.2.3-windows-x64-unsigned.msi'], ['macos-arm64', 'macos-x64', 'windows-msi']],
    ['production', { RELEASE_PLATFORMS: 'linux,macos' }, ['app.deb', 'app.rpm', 'app.flatpak'], ['macos-arm64', 'macos-x64']],
  ]) {
    const directory = path.join(root, `scoped-${channel}`);
    await fs.mkdir(directory);
    for (const name of [...files, 'Shhield.zip', 'Shhield_intel_mac.zip']) await fs.writeFile(path.join(directory, name), `synthetic ${name}`);
    execFileSync(process.execPath, [cli, directory, '1.2.3', channel, sha, '123', '1'], { env: { ...process.env, ...env } });
    const feed = JSON.parse(await fs.readFile(path.join(directory, 'update.json'), 'utf8'));
    assert.deepEqual(feed.artifacts.map(file => file.id).sort(), ids);
    const identity = { version: '1.2.3', channel, source_sha: sha, workflow_sha: 'b'.repeat(40), run_id: '123', run_attempt: '1',
      ...(env.WINDOWS_SIGNING ? { windows_signing: env.WINDOWS_SIGNING } : {}), ...(env.RELEASE_PLATFORMS ? { platforms: env.RELEASE_PLATFORMS } : {}) };
    await createCandidate(directory, identity);
    await verifyCandidate(directory, identity);
  }
  const missing = path.join(root, 'missing');
  await fs.mkdir(missing);
  assert.notEqual(spawnSync(process.execPath, [cli, missing, '1.2.3', 'preview', sha, '123', '1']).status, 0);
  assert.deepEqual(await fs.readdir(missing), [], 'invalid identity must not generate metadata');
  console.log('PASS channel-pinned immutable feeds, package hashes, original-byte aliases and frozen metadata integrity');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
