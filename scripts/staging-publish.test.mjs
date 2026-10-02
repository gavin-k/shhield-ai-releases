import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCandidate, sha256 } from './release-candidate.mjs';
import { selectCandidate, verifyProvenance } from './staging-release-run.mjs';

const repository = 'gavin-k/shhield-ai-releases';
const origin = `https://github.com/${repository}`;
const identity = { version: '1.2.3', channel: 'staging', windows_signing: 'signed', source_sha: 'a'.repeat(40),
  workflow_sha: 'b'.repeat(40), run_id: '123', run_attempt: '1' };
const run = { id: 123, run_attempt: 2, repository: { full_name: repository }, head_branch: 'main', event: 'workflow_dispatch',
  path: '.github/workflows/release.yml', head_sha: identity.workflow_sha, display_title: `Release v1.2.3 from ${identity.source_sha}` };
const artifact = { id: 456, name: 'candidate-staging-123-1', expired: false };
assert.equal(selectCandidate(run, [artifact]).artifact_id, '456', 'A waiting release may publish its completed candidate');
for (const field of ['head_branch', 'event', 'path', 'head_sha', 'display_title']) {
  assert.throws(() => selectCandidate({ ...run, [field]: 'untrusted' }, [artifact]));
}
assert.throws(() => selectCandidate(run, []));
assert.throws(() => selectCandidate(run, [{ ...artifact, expired: true }]));
assert.throws(() => selectCandidate(run, [artifact, artifact]));

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shhield-staging-ssh-'));
const scripts = path.dirname(fileURLToPath(import.meta.url));
try {
  const directory = path.join(root, 'candidate');
  const bin = path.join(root, 'bin');
  await fs.mkdir(directory);
  await fs.mkdir(bin);
  for (const name of ['Shhield-AI-Staging-1.2.3-windows-x64.msi', 'Shhield.zip', 'Shhield_intel_mac.zip']) {
    await fs.writeFile(path.join(directory, name), `synthetic ${name}`);
  }
  execFileSync(process.execPath, [path.join(scripts, 'generate-update-manifests.mjs'), directory, identity.version, 'staging', identity.source_sha, '123', '1']);
  await createCandidate(directory, identity);
  const digest = await sha256(path.join(directory, 'candidate.json'));
  const statement = { predicateType: 'https://slsa.dev/provenance/v1', subject: [{ name: 'candidate.json', digest: { sha256: digest } }],
    predicate: { buildDefinition: { externalParameters: { workflow: { repository: origin, ref: 'refs/heads/main', path: '.github/workflows/release.yml' } },
      resolvedDependencies: [{ uri: `git+${origin}@refs/heads/main`, digest: { gitCommit: identity.workflow_sha } }] },
    runDetails: { builder: { id: `${origin}/.github/workflows/prepare-candidate.yml@refs/heads/main` },
      metadata: { invocationId: `${origin}/actions/runs/123/attempts/1` } } } };
  const verified = [{ verificationResult: { statement } }];
  verifyProvenance(verified, identity, digest);
  assert.throws(() => verifyProvenance(verified, { ...identity, run_id: '124' }, digest));
  assert.throws(() => verifyProvenance(verified, { ...identity, workflow_sha: 'c'.repeat(40) }, digest));
  assert.throws(() => verifyProvenance(verified, identity, '0'.repeat(64)));
  assert.throws(() => verifyProvenance([{ attestation: { statement } }], identity, digest), 'Only cryptographically verified statements count');

  await fs.writeFile(path.join(bin, 'ssh'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const key = args[args.indexOf('-i') + 1];
fs.writeFileSync(process.env.SSH_RECORD, JSON.stringify({ args, keyMode: fs.statSync(key).mode & 0o777 }));
fs.writeFileSync(process.env.SSH_BUNDLE, fs.readFileSync(0));
process.exit(Number(process.env.SSH_EXIT || 0));
`, { mode: 0o755 });
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH, GITHUB_REPOSITORY: repository, GITHUB_REF: 'refs/heads/main',
    VERSION: identity.version, SOURCE_SHA: identity.source_sha, GITHUB_SHA: identity.workflow_sha, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2',
    CANDIDATE_SHA256: digest, STAGING_SSH_TARGET: 'shhield-staging-publisher@192.0.2.1', STAGING_SSH_KEY: 'synthetic-private-key',
    STAGING_SSH_KNOWN_HOSTS: '192.0.2.1 ssh-ed25519 synthetic-host-key', SSH_RECORD: path.join(root, 'ssh.json'), SSH_BUNDLE: path.join(root, 'bundle.tar') };
  const send = overrides => spawnSync('bash', [path.join(scripts, 'publish-staging-ssh.sh'), directory], { env: { ...env, ...overrides }, encoding: 'utf8' });
  const sent = send({});
  assert.equal(sent.status, 0, sent.stderr);
  const record = JSON.parse(await fs.readFile(env.SSH_RECORD, 'utf8'));
  assert.equal(record.keyMode, 0o600);
  assert.equal(record.args.at(-1), env.STAGING_SSH_TARGET, 'No remote command may follow the forced-command target');
  for (const flag of ['StrictHostKeyChecking=yes', 'IdentitiesOnly=yes', 'ForwardAgent=no', 'ClearAllForwardings=yes', '-T']) assert.ok(record.args.includes(flag));
  const unpacked = path.join(root, 'unpacked');
  await fs.mkdir(unpacked);
  execFileSync('tar', ['-xf', env.SSH_BUNDLE, '-C', unpacked]);
  assert.deepEqual((await fs.readdir(unpacked)).sort(), ['candidate', 'publish.env', 'scripts'], 'SSH credentials must never enter the archive');
  assert.equal(await sha256(path.join(unpacked, 'candidate/candidate.json')), digest);
  const publishedIdentity = await fs.readFile(path.join(unpacked, 'publish.env'), 'utf8');
  assert.match(publishedIdentity, /^GITHUB_RUN_ATTEMPT=1$/m, 'A retry preserves the frozen attempt');
  assert.equal(publishedIdentity.trim().split('\n').length, 6);
  assert.notEqual(send({ SSH_EXIT: '23' }).status, 0, 'SSH failures propagate');
  for (const overrides of [{ CANDIDATE_SHA256: '0'.repeat(64) }, { GITHUB_REF: 'refs/heads/topic' }, { STAGING_SSH_TARGET: 'host;exit' }]) {
    await fs.rm(env.SSH_RECORD);
    assert.notEqual(send(overrides).status, 0);
    await assert.rejects(fs.stat(env.SSH_RECORD), { code: 'ENOENT' }, 'Reject before opening SSH');
    await fs.writeFile(env.SSH_RECORD, '');
  }
  const metadata = JSON.parse(await fs.readFile(path.join(directory, 'candidate.json'), 'utf8'));
  await fs.writeFile(path.join(directory, 'candidate.json'), JSON.stringify({ ...metadata, windows_signing: 'unsigned' }));
  const unsigned = send({ CANDIDATE_SHA256: await sha256(path.join(directory, 'candidate.json')) });
  assert.notEqual(unsigned.status, 0);
  assert.match(unsigned.stderr, /Wrong windows_signing/);
  console.log('PASS original-run provenance, signed-only staging, pinned SSH transport, original bytes and safe retries');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
