import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fsSync from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { createCandidate, verifyCandidate, websiteManifest, validateIdentity, checkApprovalGates, checkBackend, offeredPlatforms } from './release-candidate.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shhield-candidate-'));
const identity = { version: '1.2.3', channel: 'production', source_sha: 'a'.repeat(40),
  workflow_sha: 'b'.repeat(40), run_id: '123', run_attempt: '1' };
try {
  assert.throws(() => validateIdentity({ ...identity, version: '../1' }));
  assert.throws(() => validateIdentity({ ...identity, channel: 'preview' }));
  const names = ['Shhield-AI-1.2.3-windows-x64.msi', 'Shhield-AI-1.2.3-windows-x64-portable.zip', 'Shhield.zip', 'Shhield_intel_mac.zip', 'app.deb', 'app.rpm', 'app.flatpak'];
  for (const name of names) await fs.writeFile(path.join(directory, name), `package ${name}`);
  const portable = 'Shhield-AI-1.2.3-windows-x64-portable.zip';
  await fs.unlink(path.join(directory, portable));
  await assert.rejects(createCandidate(directory, identity), /Missing.*portable/);
  await fs.writeFile(path.join(directory, portable), `package ${portable}`);
  for (const name of ['Shhield-AI-1.2.3-windows-x64-portable-unsigned.zip', 'Shhield-AI-Staging-1.2.3-windows-x64-portable.zip', 'Shhield-AI-1.2.4-windows-x64-portable.zip']) {
    await fs.writeFile(path.join(directory, name), 'unexpected portable');
    await assert.rejects(createCandidate(directory, identity), /Non-release|Unexpected Portable/);
    await fs.unlink(path.join(directory, name));
  }
  const candidate = await createCandidate(directory, identity);
  await verifyCandidate(directory, identity);
  assert.deepEqual(websiteManifest(candidate).artifacts.map(file => file.id), ['windows-msi', 'windows-portable', 'macos-arm64', 'macos-x64']);
  assert.throws(() => websiteManifest({ ...candidate, channel: 'staging' }));
  const originalExec = childProcess.execFileSync;
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  const originalArgv = [...process.argv];
  try {
    process.env.GITHUB_REPOSITORY = 'gavin-k/shhield-ai-releases';
    let reviewers = [{ type: 'User', reviewer: { id: 1 } }];
    globalThis.fetch = async url => ({ status: 200, json: async () => url.endsWith('deployment-branch-policies')
      ? { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] }
      : { protection_rules: [{ type: 'required_reviewers', reviewers }], deployment_branch_policy: { custom_branch_policies: true } } });
    await checkApprovalGates();
    reviewers = [];
    await assert.rejects(checkApprovalGates(), /requires human reviewers/);
    globalThis.fetch = async () => ({ status: 200, json: async () => ({ staging: true, checkoutEnabled: true }) });
    await checkBackend('staging');
    await assert.rejects(checkBackend('production'), /environment mismatch/);
    globalThis.fetch = async () => ({ status: 200, json: async () => ({ staging: true, checkoutEnabled: false }) });
    await assert.rejects(checkBackend('staging'), /checkout is disabled/);

    Object.assign(process.env, { VERSION: identity.version, SOURCE_SHA: identity.source_sha,
      GITHUB_SHA: identity.workflow_sha, GITHUB_RUN_ID: identity.run_id,
      CANDIDATE_SHA256: createHash('sha256').update(await fs.readFile(path.join(directory, 'candidate.json'))).digest('hex') });
    process.argv[2] = directory;
    const assets = new Map();
    let current = null;
    let edits = 0;
    let uploads = 0;
    let failUpload = true;
    const snapshot = () => ({ ...current, assets: [...assets].map(([name, data]) => ({ name, size: data.length,
      digest: `sha256:${createHash('sha256').update(data).digest('hex')}` })) });
    childProcess.execFileSync = (command, args) => {
      assert.equal(command, 'gh');
      const [kind, operation] = args;
      if (kind === 'api') {
        if (!current || (operation.endsWith('/latest') && current.draft)) {
          throw Object.assign(new Error('not found'), { stderr: '(HTTP 404)' });
        }
        return JSON.stringify(snapshot());
      }
      assert.equal(kind, 'release');
      if (operation === 'create') current = { tag_name: 'v1.2.3', created_at: '2026-09-28T00:00:00Z', draft: true, prerelease: false,
        html_url: 'https://example.invalid/mock-release' };
      else if (operation === 'upload') {
        if (failUpload && uploads === 2) throw new Error('simulated interrupted upload');
        assets.set(path.basename(args[3]), fsSync.readFileSync(args[3]));
        uploads++;
      } else if (operation === 'download') {
        const name = args[args.indexOf('--pattern') + 1];
        fsSync.writeFileSync(path.join(args[args.indexOf('--dir') + 1], name), assets.get(name));
      } else if (operation === 'edit') { current.draft = false; edits++; }
      else assert.fail(`Unexpected gh command: ${args.join(' ')}`);
      return '';
    };
    syncBuiltinESMExports();
    globalThis.fetch = async () => ({ status: 200, json: async () => JSON.parse(assets.get('latest.json')) });
    await assert.rejects(import('./publish-candidate.mjs?interrupted'), /simulated interrupted upload/);
    assert.equal(current.draft, true);
    assert.equal(edits, 0);
    failUpload = false;
    await import('./publish-candidate.mjs?resume');
    assert.equal(edits, 1);
    assert.equal(uploads, candidate.files.length + 2);
    for (const file of candidate.files) assert.deepEqual(assets.get(file.name), await fs.readFile(path.join(directory, file.name)));
    await import('./publish-candidate.mjs?retry');
    assert.equal(uploads, candidate.files.length + 2, 'Retry must not replace/re-upload assets');
    assets.set('Shhield.zip', Buffer.from('tampered published file'));
    await assert.rejects(import('./publish-candidate.mjs?conflict'), /Refusing to replace/);
    assert.equal(edits, 2);
    current.tag_name = 'v1.2.4';
    await assert.rejects(import('./publish-candidate.mjs?older'), /older candidate/);
  } finally {
    childProcess.execFileSync = originalExec;
    syncBuiltinESMExports();
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    process.argv = originalArgv;
  }
  await assert.rejects(verifyCandidate(directory, { ...identity, source_sha: 'c'.repeat(40) }));
  await fs.writeFile(path.join(directory, 'Shhield.zip'), 'package Shhield.ziq');
  await assert.rejects(verifyCandidate(directory, identity), /Wrong SHA-256/);
  await fs.writeFile(path.join(directory, 'Shhield.zip'), 'package Shhield.zip');
  await fs.writeFile(path.join(directory, 'unexpected.zip'), 'extra');
  await assert.rejects(verifyCandidate(directory, identity));
  const stageDirectory = path.join(directory, 'staging');
  await fs.mkdir(stageDirectory);
  for (const name of ['Shhield-AI-Staging-1.2.3-windows-x64.msi', 'Shhield-AI-Staging-1.2.3-windows-x64-portable.zip', 'Shhield.zip', 'Shhield_intel_mac.zip']) {
    await fs.writeFile(path.join(stageDirectory, name), name);
  }
  const stageIdentity = { ...identity, channel: 'staging' };
  await createCandidate(stageDirectory, stageIdentity);
  await verifyCandidate(stageDirectory, stageIdentity);
  await assert.rejects(verifyCandidate(stageDirectory, identity), /Wrong channel/);

  // While the Windows certificate is pending, only staging testers get an unsigned MSI.
  assert.throws(() => validateIdentity({ ...identity, windows_signing: 'unsigned' }), /must be signed/);
  assert.throws(() => validateIdentity({ ...stageIdentity, windows_signing: 'maybe' }), /signing mode/);
  assert.throws(() => validateIdentity({ ...stageIdentity, platforms: 'macos', windows_signing: 'unsigned' }), /requires a Windows/);
  assert.throws(() => validateIdentity({ ...identity, platforms: 'linux,windows' }), /ships macOS/);
  assert.throws(() => validateIdentity({ ...identity, platforms: 'macos,linux' }), /sorted, unique/);
  assert.throws(() => validateIdentity({ ...stageIdentity, platforms: 'linux,macos' }), /production only/);
  const unsignedDirectory = path.join(directory, 'unsigned-staging');
  await fs.mkdir(unsignedDirectory);
  const unsignedMsi = 'Shhield-AI-Staging-1.2.3-windows-x64-unsigned.msi';
  for (const name of [unsignedMsi, `${unsignedMsi}.sha256`, 'Shhield.zip', 'Shhield_intel_mac.zip']) {
    await fs.writeFile(path.join(unsignedDirectory, name), name);
  }
  const unsignedIdentity = { ...stageIdentity, windows_signing: 'unsigned' };
  await assert.rejects(createCandidate(unsignedDirectory, stageIdentity), /Missing Shhield-AI-Staging-1\.2\.3-windows-x64\.msi/);
  const unsignedPortable = 'Shhield-AI-Staging-1.2.3-windows-x64-portable.zip';
  await fs.writeFile(path.join(unsignedDirectory, unsignedPortable), 'unexpected portable');
  await assert.rejects(createCandidate(unsignedDirectory, unsignedIdentity), /Unexpected Portable/);
  await fs.unlink(path.join(unsignedDirectory, unsignedPortable));
  await createCandidate(unsignedDirectory, unsignedIdentity);
  await verifyCandidate(unsignedDirectory, unsignedIdentity);
  await assert.rejects(verifyCandidate(unsignedDirectory, { ...unsignedIdentity, windows_signing: 'signed' }), /Wrong windows_signing/);

  // Production can ship without Windows, but never with a stray Windows file.
  const withoutWindows = path.join(directory, 'production-without-windows');
  await fs.mkdir(withoutWindows);
  for (const name of ['Shhield.zip', 'Shhield_intel_mac.zip', 'app.deb', 'app.rpm', 'app.flatpak']) {
    await fs.writeFile(path.join(withoutWindows, name), name);
  }
  const withoutWindowsIdentity = { ...identity, platforms: 'linux,macos' };
  await fs.writeFile(path.join(withoutWindows, 'Shhield-AI-1.2.3-windows-x64.msi'), 'stray msi');
  await assert.rejects(createCandidate(withoutWindows, withoutWindowsIdentity), /Out-of-scope Windows/);
  await fs.unlink(path.join(withoutWindows, 'Shhield-AI-1.2.3-windows-x64.msi'));
  const macCandidate = await createCandidate(withoutWindows, withoutWindowsIdentity);
  assert.deepEqual(websiteManifest(macCandidate).artifacts.map(file => file.id), ['macos-arm64', 'macos-x64']);
  assert.deepEqual(offeredPlatforms(macCandidate.files.map(file => file.name)), ['linux', 'macos']);
  assert.deepEqual(offeredPlatforms(candidate.files.map(file => file.name)), ['linux', 'macos', 'windows']);
  const savedExec = childProcess.execFileSync;
  const savedEnv = { ...process.env };
  const savedArgv = [...process.argv];
  try {
    Object.assign(process.env, { GITHUB_REPOSITORY: 'gavin-k/shhield-ai-releases', VERSION: identity.version,
      SOURCE_SHA: identity.source_sha, GITHUB_SHA: identity.workflow_sha, GITHUB_RUN_ID: identity.run_id,
      CANDIDATE_SHA256: createHash('sha256').update(await fs.readFile(path.join(withoutWindows, 'candidate.json'))).digest('hex') });
    process.argv[2] = withoutWindows;
    childProcess.execFileSync = () => JSON.stringify({ tag_name: 'v1.2.2', draft: false, prerelease: false,
      assets: candidate.files.map(file => ({ name: file.name.replace('1.2.3', '1.2.2') })) });
    syncBuiltinESMExports();
    await assert.rejects(import('./publish-candidate.mjs?drop-windows'), /remove platforms/);
  } finally {
    childProcess.execFileSync = savedExec;
    syncBuiltinESMExports();
    process.env = savedEnv;
    process.argv = savedArgv;
  }
  console.log('Candidate integrity, approval gates, backend identity, original-byte publication, safe retries, website contract and Windows scope checks passed');
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
