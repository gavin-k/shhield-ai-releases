import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCandidate, sha256 } from './release-candidate.mjs';
import { commitPointer, mirrorMode, mirrorTag, nextPointer, probeCnbOrigins, publishMirrors, verifyAdvance } from './mirror-distribution.mjs';
import worker from '../download/worker.mjs';

const candidate = { channel: 'staging', version: '1.0.20', source_sha: 'a'.repeat(40), run_id: '123', run_attempt: '2',
  files: [{ name: 'Shhield-AI-Staging-1.0.20-macos-arm64.zip' }, { name: 'Shhield-AI-Staging-1.0.20-windows-x64.msi' }] };
const next = nextPointer(candidate, 'b'.repeat(64));
const previousValue = nextPointer({ ...candidate, version: '1.0.19' }, 'c'.repeat(64));
assert.equal(mirrorTag(candidate), `staging-v1.0.20-${candidate.source_sha}-123-2`);
assert.equal(mirrorTag({ ...candidate, channel: 'production' }), 'v1.0.20');
assert.equal(mirrorMode({}), false);
assert.equal(mirrorMode({ UPDATE_DISTRIBUTION_MODE: 'mirrors' }), true);
assert.throws(() => mirrorMode({ UPDATE_DISTRIBUTION_MODE: 'typo' }));
assert.throws(() => verifyAdvance(next, previousValue), /newer version/);
assert.throws(() => verifyAdvance(next, { ...next, candidate_sha256: 'd'.repeat(64) }), /newer version/);
assert.throws(() => verifyAdvance(previousValue, { ...next, platforms: ['macos'] }), /drops/);

let current = { etag: 'old', value: previousValue };
let writes = 0;
const read = async () => current;
await commitPointer({ previous: current, next, read, put: async (value, etag) => {
  assert.equal(etag, 'old');
  writes++;
  current = { etag: 'new', value };
  throw new Error('response lost after commit');
} });
assert.equal(current.value.candidate_sha256, next.candidate_sha256);
await commitPointer({ previous: current, next, read, put: async () => { writes++; } });
assert.equal(writes, 1, 'idempotent retries must not write another pointer');
await assert.rejects(commitPointer({ previous: { etag: 'old', value: previousValue }, next, read: async () => ({ value: previousValue }), put: async () => { throw new Error('conflict'); } }), /not committed|changed concurrently/);
await assert.rejects(commitPointer({ previous: current, next, read: async () => ({ value: previousValue }), put: async () => assert.fail() }), /changed during/);

const objects = new Map([
  ['_channels/staging.json', JSON.stringify(next)],
  [next.prefix + 'update.json', '{"version":"1.0.20"}'],
  [next.prefix + 'latest-mac.yml', '{"version":"1.0.20"}'],
  [next.prefix + candidate.files[0].name, 'signed-package'],
]);
const reads = [];
function object(key) {
  reads.push(key);
  if (!objects.has(key)) return null;
  const bytes = objects.get(key);
  return { size: Buffer.byteLength(bytes), httpEtag: '"etag"', json: async () => JSON.parse(bytes),
    body: new Response(bytes).body, writeHttpMetadata: headers => headers.set('Content-Type', 'application/octet-stream') };
}
const env = { RELEASES: { get: async key => object(key), head: async key => object(key) } };
const get = (pathname, init) => worker.fetch(new Request('https://download.shhield.ai' + pathname, init), env);
for (const name of ['update.json', 'latest.json', 'latest-mac.yml']) {
  const response = await get('/staging/' + name);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  assert.equal(response.headers.get('x-shhield-distribution'), 'r2');
}
const pack = await get('/' + next.prefix + candidate.files[0].name);
assert.equal(await pack.text(), 'signed-package');
const head = await get('/' + next.prefix + candidate.files[0].name, { method: 'HEAD' });
assert.equal(head.headers.get('content-length'), '14');
assert.equal(await head.text(), '');
objects.set('_channels/staging.json', JSON.stringify(previousValue));
assert.equal((await get('/staging/update.json')).status, 503, 'missing replacement must not fall back to old metadata');
objects.set('_channels/staging.json', JSON.stringify({ ...next, prefix: '_secrets/' }));
assert.equal((await get('/staging/update.json')).status, 503);
assert.ok(!reads.includes('_secrets/update.json'));
objects.delete('_channels/staging.json');
assert.equal((await get('/staging/update.json')).status, 503, 'missing pointer cannot authorize installation');
for (const pathname of ['/_channels/staging.json', '/' + next.prefix + 'candidate.json', '/staging/update.json?stale=1', '/stable/unknown.json']) assert.equal((await get(pathname)).status, 404);
assert.equal((await get('/staging/update.json', { method: 'POST' })).status, 405);
for (const method of ['GET', 'HEAD', 'POST']) {
  const response = await get('/staging/healthz', { method });
  assert.equal(response.status, method === 'POST' ? 405 : 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('x-robots-tag'), /noindex/);
  if (method === 'GET') assert.deepEqual(await response.json(), { status: 'ok', channel: 'staging' });
  if (method === 'HEAD') assert.equal(await response.text(), '');
}
const stable = nextPointer({ ...candidate, channel: 'production' }, 'f'.repeat(64));
objects.set('_channels/stable.json', JSON.stringify(stable));
for (const name of ['update.json', 'latest.json', 'latest-mac.yml']) {
  objects.set(stable.prefix + name, name);
  const response = await get('/stable/' + name);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), name, 'stable aliases must preserve each frozen manifest');
}

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mirror-gate-'));
try {
  const identity = { channel: 'staging', version: '1.0.20', source_sha: 'a'.repeat(40), workflow_sha: 'd'.repeat(40), run_id: '123', run_attempt: '2', platforms: 'macos', windows_signing: 'signed' };
  for (const arch of ['arm64', 'x64']) await fs.writeFile(path.join(directory, `Shhield-AI-Staging-1.0.20-macos-${arch}.zip`), `synthetic-${arch}`);
  execFileSync(process.execPath, [fileURLToPath(new URL('./generate-update-manifests.mjs', import.meta.url)), directory,
    identity.version, identity.channel, identity.source_sha, identity.run_id, identity.run_attempt],
  { env: { ...process.env, RELEASE_PLATFORMS: 'macos', WINDOWS_SIGNING: 'signed' }, stdio: 'pipe' });
  const policy = { repository: 'example/releases', redirectOrigins: ['https://objects.example.invalid'] };
  await fs.writeFile(path.join(directory, 'mirror-policy.json'), JSON.stringify(policy));
  const frozen = await createCandidate(directory, identity);
  const digest = await sha256(path.join(directory, 'candidate.json'));
  const pointerKey = '_channels/staging.json';
  const old = nextPointer({ ...frozen, version: '1.0.19' }, 'e'.repeat(64));
  const stored = new Map([[pointerKey, Buffer.from(JSON.stringify(old))]]);
  const attachments = new Map();
  const publishingEnv = {
    R2_ACCOUNT_ID: '1'.repeat(32), R2_RELEASE_BUCKET: 'synthetic-bucket', R2_ACCESS_KEY_ID: 'synthetic', R2_SECRET_ACCESS_KEY: 'synthetic',
    CNB_TOKEN: 'synthetic', CNB_RELEASE_REPOSITORY: policy.repository, CNB_DOWNLOAD_ORIGINS: JSON.stringify(policy.redirectOrigins),
    CNB_UPLOAD_ORIGINS: JSON.stringify(policy.redirectOrigins), GLOBAL_MIRROR_PROBE_ORIGIN: 'https://global.example.invalid', CANDIDATE_SHA256: digest,
  };
  for (const [stderr, expected] of [
    ['An error occurred (AccessDenied) when calling GetObject: synthetic-private-signature', 'AccessDenied'],
    ['An error occurred (synthetic-private-signature) when calling GetObject', 'CLI_ERROR'],
  ]) {
    await fs.writeFile(path.join(directory, 'aws'), `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(stderr)}); process.exit(1);\n`, { mode: 0o700 });
    await assert.rejects(publishMirrors(directory, frozen, undefined, { bootstrap: true, env: { ...publishingEnv, PATH: directory } }), error => {
      assert.equal(error.message, `R2 get-object failed (${expected})`);
      assert.ok(!error.stack.includes('synthetic-private-signature'), 'raw AWS diagnostics must not reach workflow logs');
      return true;
    });
  }
  await fs.unlink(path.join(directory, 'aws'));
  let pointerWrites = 0;
  let corrupt = 'cnb';
  let loseResponse = true;
  const r2 = async (command, args) => {
    const key = args[args.indexOf('--key') + 1];
    if (command === 'head-object') return stored.has(key) ? { ContentLength: stored.get(key).length } : null;
    if (command === 'get-object') {
      if (!stored.has(key)) return null;
      await fs.writeFile(args.at(-1), stored.get(key));
      return { ETag: '"current-etag"' };
    }
    assert.equal(command, 'put-object');
    if (key === pointerKey) {
      assert.equal(args[args.indexOf('--if-match') + 1], '"current-etag"');
      pointerWrites++;
    } else {
      assert.equal(args[args.indexOf('--if-none-match') + 1], '*');
      assert.ok(!stored.has(key), 'immutable files must never be overwritten');
    }
    stored.set(key, await fs.readFile(args[args.indexOf('--body') + 1]));
    if (key === pointerKey && loseResponse) { loseResponse = false; throw new Error('response lost'); }
    return {};
  };
  const request = async (input, options = {}) => {
    const url = new URL(input);
    if (url.origin === 'https://api.cnb.cool') {
      assert.equal(options.headers.Authorization, 'Bearer synthetic');
      if (url.pathname.includes('/tags/')) return Response.json({ id: 'release-id', tag_name: mirrorTag(frozen), assets: [...attachments.keys()].map(name => ({ name })) });
      if (url.pathname.endsWith('/asset-upload-url')) {
        const data = JSON.parse(options.body);
        assert.equal(data.overwrite, false);
        return Response.json({ upload_url: `${policy.redirectOrigins[0]}/upload/${data.asset_name}`,
          verify_url: `https://api.cnb.cool/${policy.repository}/-/releases/release-id/verify` });
      }
      assert.ok(url.pathname.endsWith('/verify'));
      return new Response(null);
    }
    assert.ok(!options.headers?.Authorization, 'publishing tokens must not reach package hosts');
    if (options.method === 'PUT') {
      const bytes = [];
      for await (const chunk of options.body) bytes.push(chunk);
      attachments.set(url.pathname.split('/').at(-1), Buffer.concat(bytes));
      return new Response(null);
    }
    if (url.origin === 'https://download.shhield.ai' && url.pathname === '/staging/update.json') {
      const active = JSON.parse(stored.get(pointerKey));
      return Response.json({ schema_version: 1, channel: active.channel, version: active.version, source_sha: active.source_sha }, { headers: { 'X-Shhield-Distribution': 'r2', 'Cache-Control': 'no-store' } });
    }
    if (url.origin === publishingEnv.GLOBAL_MIRROR_PROBE_ORIGIN || url.origin === 'https://download.shhield.ai') return corrupt === 'global' ? new Response(null, { status: 503 }) : new Response(stored.get(url.pathname.slice(1)));
    const name = url.pathname.split('/').at(-1);
    if (url.origin === 'https://cnb.cool') return new Response(null, { status: 302, headers: { Location: `${policy.redirectOrigins[0]}/download/${name}` } });
    assert.equal(url.origin, policy.redirectOrigins[0]);
    return new Response(corrupt === 'cnb' ? 'corrupt' : attachments.get(name));
  };
  const publish = env => publishMirrors(directory, frozen, undefined, { env: env ?? publishingEnv, request, r2 });
  const publicFeed = await fs.readFile(path.join(directory, 'update.json'));
  const probeRequest = (input, options) => input === 'https://download.shhield.ai/staging/update.json'
    ? Promise.resolve(new Response(publicFeed)) : request(input, options);
  await assert.rejects(probeCnbOrigins(directory, frozen, { env: publishingEnv, request }), /Mirror (size|hash)|exceeds frozen size/);
  assert.equal(attachments.size, 0, 'an unpublished candidate must be rejected before CNB upload');
  await assert.rejects(probeCnbOrigins(directory, frozen, { env: publishingEnv, request: probeRequest }), /Mirror (size|hash)|exceeds frozen size/);
  corrupt = '';
  assert.deepEqual(await probeCnbOrigins(directory, frozen, { env: { ...publishingEnv, CNB_UPLOAD_ORIGINS: '' }, request: probeRequest }), {
    repository: policy.repository, uploadOrigins: policy.redirectOrigins, downloadOrigins: policy.redirectOrigins,
  });
  await assert.rejects(probeCnbOrigins(directory, frozen, { env: publishingEnv, request: (input, options) =>
    new URL(input).origin === 'https://cnb.cool'
      ? Promise.resolve(new Response(null, { status: 302, headers: { Location: 'http://untrusted.invalid/file' } }))
      : probeRequest(input, options) }), /Invalid discovered CNB redirect/);
  assert.equal(pointerWrites, 0, 'origin discovery must not authorize installation');
  corrupt = 'cnb';
  for (const [override, expected] of [
    [{ GITHUB_REF: 'refs/heads/topic' }, /Staging publication requires main/],
    [{ GITHUB_RUN_ATTEMPT: '3' }, /Wrong run_attempt/],
  ]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./publish-mirrors.mjs', import.meta.url)), 'staging', directory], {
      env: { ...process.env, ...publishingEnv, GITHUB_REPOSITORY: 'gavin-k/shhield-ai-releases', GITHUB_REF: 'refs/heads/main',
        VERSION: identity.version, SOURCE_SHA: identity.source_sha, GITHUB_SHA: identity.workflow_sha,
        GITHUB_RUN_ID: identity.run_id, GITHUB_RUN_ATTEMPT: identity.run_attempt, ...override }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
  await assert.rejects(publishMirrors(directory, frozen, undefined, { bootstrap: true, env: publishingEnv, request, r2 }), /Bootstrap cannot replace/);
  await assert.rejects(publish(), /Mirror (size|hash)|exceeds frozen size/);
  assert.equal(pointerWrites, 0, 'a corrupt mainland copy must not announce a release');
  corrupt = 'global';
  await assert.rejects(publish(), /Mirror HTTP 503/);
  assert.equal(pointerWrites, 0, 'an unavailable global copy must not announce a release');
  corrupt = '';
  await publish();
  assert.equal(pointerWrites, 1, 'all sources verified before committing, including lost-response recovery');
  await publish();
  assert.equal(pointerWrites, 1, 'retry the original files without rewriting the pointer');
  await assert.rejects(publish({ ...publishingEnv, CNB_RELEASE_REPOSITORY: 'another/repository' }), /policies differ/);
  await assert.rejects(publish({ ...publishingEnv, CNB_DOWNLOAD_ORIGINS: '["https://cnb.cool"]' }), /Invalid CNB download origins/);
} finally { await fs.rm(directory, { recursive: true, force: true }); }
console.log('PASS conditional publication, response-loss recovery, channel pointers and streamed Worker responses');
