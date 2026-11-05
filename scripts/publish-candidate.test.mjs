import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCandidate, requiredPackages, sha256 } from './release-candidate.mjs';

async function mockGitHub() {
  const childProcess = await import('node:child_process');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { createHash } = await import('node:crypto');
  const { syncBuiltinESMExports } = await import('node:module');
  const calls = [];
  const files = new Map();
  let release = process.env.TEST_RELEASE_MODE === 'draft' ? initialRelease() : null;
  function initialRelease() {
    return { id: 42, tag_name: 'v1.2.3', draft: true, prerelease: false,
      created_at: '2026-11-05T00:00:00Z', html_url: 'https://example.invalid/release', assets: [] };
  }
  function fail(status) {
    throw Object.assign(new Error('GitHub API error'), { stderr: 'gh: API error (HTTP ' + status + ')' });
  }
  childProcess.default.execFileSync = (command, args) => {
    if (command !== 'gh') throw new Error('Unexpected command: ' + command);
    calls.push(args);
    if (args[0] === 'api') {
      if (process.env.TEST_RELEASE_MODE === 'api-error') fail(503);
      if (args[1].endsWith('/latest')) fail(404);
      if (args[1].includes('/tags/')) {
        if (!release || release.draft) fail(404);
        return JSON.stringify(release);
      }
      assertListRequest(args);
      return JSON.stringify([[], release ? [release] : []]);
    }
    if (args[0] !== 'release') throw new Error('Unexpected gh command');
    if (args[1] === 'create') {
      if (release) throw new Error('Duplicate draft creation');
      release = initialRelease();
      return '';
    }
    if (args[1] === 'upload') {
      const file = args[3];
      const name = path.basename(file);
      const bytes = fs.readFileSync(file);
      if (!release.draft || files.has(name)) throw new Error('Unsafe asset write');
      files.set(name, bytes);
      release.assets.push({ name, size: bytes.length,
        digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') });
      return '';
    }
    if (args[1] === 'edit') {
      if (!args.includes('--draft=false') || !args.includes('--latest')) throw new Error('Unexpected edit');
      release.draft = false;
      return '';
    }
    throw new Error('Unexpected gh action: ' + args[1]);
  };
  function assertListRequest(args) {
    if (!args[1].endsWith('/releases?per_page=100') ||
        !args.includes('--paginate') || !args.includes('--slurp')) throw new Error('Unbounded draft lookup');
  }
  syncBuiltinESMExports();
  globalThis.fetch = async url => {
    if (url !== 'https://download.shhield.ai/stable/latest.json') throw new Error('Unexpected URL');
    return new Response(files.get('latest.json'));
  };
  process.on('exit', () => fs.writeFileSync(process.env.TEST_RELEASE_RESULT, JSON.stringify({ calls, release })));
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'shhield-production-publish-'));
try {
  const directory = path.join(root, 'candidate');
  await fs.mkdir(directory);
  const identity = { version: '1.2.3', channel: 'production', source_sha: 'a'.repeat(40),
    workflow_sha: 'b'.repeat(40), run_id: '123', run_attempt: '1' };
  for (const name of [...requiredPackages(identity).map(([name]) => name), 'app.deb', 'app.rpm', 'app.flatpak']) {
    await fs.writeFile(path.join(directory, name), 'synthetic ' + name);
  }
  const candidate = await createCandidate(directory, identity);
  const preload = path.join(root, 'github.mjs');
  await fs.writeFile(preload, 'await (' + mockGitHub.toString() + ')();');
  const cli = fileURLToPath(new URL('./publish-candidate.mjs', import.meta.url));
  for (const mode of ['new', 'draft', 'api-error']) {
    const resultFile = path.join(root, mode + '.json');
    const result = spawnSync(process.execPath, ['--import', preload, cli, directory], {
      encoding: 'utf8', env: { ...process.env, GITHUB_REPOSITORY: 'gavin-k/shhield-ai-releases',
        VERSION: identity.version, SOURCE_SHA: identity.source_sha, GITHUB_SHA: identity.workflow_sha,
        GITHUB_RUN_ID: identity.run_id, CANDIDATE_SHA256: await sha256(path.join(directory, 'candidate.json')),
        TEST_RELEASE_MODE: mode, TEST_RELEASE_RESULT: resultFile },
    });
    const observed = JSON.parse(await fs.readFile(resultFile, 'utf8'));
    if (mode === 'api-error') {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /HTTP 503/);
      assert.equal(observed.calls.length, 1, 'non-404 errors must not fall back or mutate releases');
      continue;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.equal(observed.release.draft, false);
    assert.equal(observed.release.assets.length, candidate.files.length + 2);
    assert.equal(observed.calls.filter(args => args[0] === 'release' && args[1] === 'create').length,
      mode === 'new' ? 1 : 0, 'reuse an existing draft without creating a duplicate');
    assert.ok(observed.calls.some(args => args[0] === 'api' && args.includes('--paginate')));
  }
  console.log('PASS production publication discovers new/existing drafts across pages and preserves API errors');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
