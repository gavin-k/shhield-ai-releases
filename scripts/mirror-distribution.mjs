import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { offeredPlatforms, sha256, updatePrefix, verifyCandidate } from './release-candidate.mjs';
import { validatePointer } from '../download/worker.mjs';

const execute = promisify(execFile);
const apiOrigin = 'https://api.cnb.cool';
const publicOrigin = 'https://download.shhield.ai';

export function mirrorMode(env = process.env) {
  assert.ok(!env.UPDATE_DISTRIBUTION_MODE || ['legacy', 'mirrors'].includes(env.UPDATE_DISTRIBUTION_MODE), 'Unknown update distribution mode');
  return env.UPDATE_DISTRIBUTION_MODE === 'mirrors';
}

export function mirrorTag(candidate) {
  return candidate.channel === 'production' ? `v${candidate.version}`
    : `staging-v${candidate.version}-${candidate.source_sha}-${candidate.run_id}-${candidate.run_attempt}`;
}

function origins(value, label) {
  const values = JSON.parse(value || '[]');
  assert.ok(Array.isArray(values) && values.length > 0, `Missing verified ${label}`);
  for (const origin of values) {
    const url = new URL(origin);
    assert.ok(url.origin === origin && url.protocol === 'https:' && !url.port && !url.username && !url.password && url.hostname !== 'cnb.cool', `Invalid ${label}`);
  }
  return values;
}

function configuration(env) {
  assert.match(env.R2_ACCOUNT_ID || '', /^[a-f0-9]{32}$/, 'Missing R2 account');
  assert.match(env.R2_RELEASE_BUCKET || '', /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Invalid release bucket');
  assert.ok(env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.CNB_TOKEN, 'Missing publishing credentials');
  assert.match(env.CNB_RELEASE_REPOSITORY || '', /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)+$/, 'Missing CNB release repository');
  const probe = new URL(env.GLOBAL_MIRROR_PROBE_ORIGIN || '');
  assert.ok(probe.origin === env.GLOBAL_MIRROR_PROBE_ORIGIN && probe.protocol === 'https:' && !probe.port && !probe.username && !probe.password, 'Invalid global mirror probe origin');
  return { repository: env.CNB_RELEASE_REPOSITORY, probe: probe.origin,
    downloadOrigins: origins(env.CNB_DOWNLOAD_ORIGINS, 'CNB download origins'),
    uploadOrigins: origins(env.CNB_UPLOAD_ORIGINS, 'CNB upload origins') };
}

async function anonymousFile(url, file, allowedOrigins, request = fetch) {
  let next = new URL(url);
  const signal = AbortSignal.timeout(15 * 60 * 1000);
  for (let count = 0; count <= 5; count++) {
    const response = await request(next.href, { redirect: 'manual', credentials: 'omit', cache: 'no-store', signal });
    if (response.status === 200) {
      assert.ok(response.body, `Empty mirror file: ${file.name}`);
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > file.size) { await response.body.cancel().catch(() => {}); throw new Error(`Mirror exceeds frozen size: ${file.name}`); }
        hash.update(chunk);
      }
      assert.equal(size, file.size, `Mirror size mismatch: ${file.name}`);
      assert.equal(hash.digest('hex'), file.sha256, `Mirror hash mismatch: ${file.name}`);
      return;
    }
    await response.body?.cancel();
    assert.ok([301, 302, 303, 307, 308].includes(response.status), `Mirror HTTP ${response.status}: ${file.name}`);
    const location = response.headers.get('location');
    assert.ok(location, 'Missing mirror redirect');
    next = new URL(location, next);
    assert.ok(allowedOrigins.includes(next.origin) && next.protocol === 'https:' && !next.port && !next.username && !next.password && !next.hash, 'Untrusted mirror redirect');
  }
  throw new Error('Too many mirror redirects');
}

function r2Client(env) {
  return async (command, args, allowMissing = false) => {
    try {
      const { stdout } = await execute('aws', ['--endpoint-url', `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`, '--region', 'auto', '--no-cli-pager', '--output', 'json',
        's3api', command, '--bucket', env.R2_RELEASE_BUCKET, ...args], {
        timeout: 15 * 60 * 1000, maxBuffer: 1024 * 1024,
        env: { ...env, AWS_ACCESS_KEY_ID: env.R2_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.R2_SECRET_ACCESS_KEY,
          AWS_SESSION_TOKEN: '', AWS_EC2_METADATA_DISABLED: 'true', AWS_REQUEST_CHECKSUM_CALCULATION: 'when_required', AWS_RESPONSE_CHECKSUM_VALIDATION: 'when_required' },
      });
      return stdout.trim() ? JSON.parse(stdout) : {};
    } catch (error) {
      if (allowMissing && /\((NoSuchKey|404|NotFound)\)/.test(error.stderr || '')) return null;
      // AWS errors may include signed requests; never put them into public workflow logs.
      const failure = new Error(`R2 ${command} failed`);
      failure.precondition = /\(PreconditionFailed\)|\(412\)/.test(error.stderr || '');
      throw failure;
    }
  };
}

async function cnbRequest(config, env, method, route, body, allowMissing = false, request = fetch) {
  const response = await request(`${apiOrigin}/${config.repository}/-/releases${route}`, {
    method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${env.CNB_TOKEN}`, Accept: 'application/vnd.cnb.api+json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (allowMissing && response.status === 404) { await response.body?.cancel(); return null; }
  assert.ok(response.ok, `CNB ${method} failed: HTTP ${response.status}`);
  const text = await response.text();
  assert.ok(text.length <= 1024 * 1024, 'CNB response too large');
  return text.trim() ? JSON.parse(text) : null;
}

async function ensureCnbRelease(config, env, candidate, request) {
  const tag = mirrorTag(candidate);
  let release = await cnbRequest(config, env, 'GET', `/tags/${encodeURIComponent(tag)}`, undefined, true, request);
  if (!release) release = await cnbRequest(config, env, 'POST', '', {
    tag_name: tag, name: `Shhield AI ${tag}`, target_commitish: 'main',
    body: `Shhield AI ${candidate.version}\nSource: ${candidate.source_sha}`, prerelease: candidate.channel === 'staging', make_latest: 'false',
  }, false, request);
  assert.ok(release && (typeof release.id === 'string' || Number.isSafeInteger(release.id)), 'Missing CNB release identity');
  assert.equal(release.tag_name, tag, 'Wrong CNB release tag');
  assert.ok(release.assets === undefined || release.assets === null || Array.isArray(release.assets), 'Invalid CNB assets');
  return { ...release, assets: release.assets ?? [] };
}

async function uploadCnb(config, env, release, file, request) {
  if (release.assets.some(asset => asset.name === file.name)) return; // Anonymous readback below verifies existing bytes too.
  const target = await cnbRequest(config, env, 'POST', `/${encodeURIComponent(release.id)}/asset-upload-url`, {
    asset_name: file.name, size: file.size, overwrite: false,
  }, false, request);
  const upload = new URL(target.upload_url);
  const verify = new URL(decodeURIComponent(target.verify_url));
  assert.ok(config.uploadOrigins.includes(upload.origin) && upload.protocol === 'https:' && !upload.username && !upload.password && !upload.hash, 'Untrusted CNB upload URL');
  assert.ok(verify.origin === apiOrigin && verify.pathname.startsWith(`/${config.repository}/-/releases/`) && !verify.username && !verify.password && !verify.hash, 'Untrusted CNB verification URL');
  const response = await request(upload.href, {
    method: 'PUT', redirect: 'error', signal: AbortSignal.timeout(15 * 60 * 1000),
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) }, body: createReadStream(file.path), duplex: 'half',
  });
  await response.body?.cancel();
  assert.ok(response.ok, `CNB upload failed: ${file.name} HTTP ${response.status}`);
  const confirmed = await request(verify.href, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${env.CNB_TOKEN}`, Accept: 'application/vnd.cnb.api+json' } });
  await confirmed.body?.cancel();
  assert.ok(confirmed.ok, `CNB upload confirmation failed: ${file.name}`);
}

export function nextPointer(candidate, digest) {
  const channel = candidate.channel === 'production' ? 'stable' : 'staging';
  return validatePointer({ schema_version: 1, channel, version: candidate.version, source_sha: candidate.source_sha,
    candidate_sha256: digest, prefix: new URL(updatePrefix(candidate)).pathname.slice(1),
    platforms: offeredPlatforms(candidate.files.map(file => file.name)) }, channel);
}

export function verifyAdvance(previous, next) {
  if (!previous) return;
  validatePointer(previous, next.channel);
  if (previous.candidate_sha256 === next.candidate_sha256) { assert.deepEqual(previous, next); return; }
  const old = previous.version.split('.').map(Number);
  const order = next.version.split('.').map((part, index) => Number(part) - old[index]).find(part => part !== 0) ?? 0;
  assert.ok(order > 0, 'A different candidate must have a newer version');
  assert.ok(previous.platforms.every(platform => next.platforms.includes(platform)), 'Candidate drops a previously offered platform');
}

export async function commitPointer({ previous, next, read, put }) {
  verifyAdvance(previous?.value, next);
  if (previous?.value.candidate_sha256 === next.candidate_sha256) {
    assert.deepEqual((await read())?.value, next, 'Release changed during an idempotent retry');
    return;
  }
  try { await put(next, previous?.etag); }
  catch {
    // A lost response can mean a successful commit. Read back before deciding whether retry is safe.
    const current = await read();
    assert.deepEqual(current?.value, next, 'Release pointer was not committed or was changed concurrently; inspect before retrying');
    return;
  }
  assert.deepEqual((await read())?.value, next, 'Release pointer changed after commit; inspect before retrying');
}

export async function publishMirrors(directory, candidate, websiteFile, { bootstrap = false, env = process.env, request = fetch, r2 = r2Client(env) } = {}) {
  const config = configuration(env);
  const digest = await sha256(path.join(directory, 'candidate.json'));
  assert.equal(digest, env.CANDIDATE_SHA256, 'Frozen candidate digest required');
  assert.deepEqual(await verifyCandidate(directory), candidate, 'Candidate changed before mirror publication');
  assert.notEqual(candidate.windows_signing, 'unsigned', 'Mirrors require signed release candidates');
  assert.ok(candidate.files.some(file => file.name === 'update.json'), 'Frozen update feed required');
  if (!bootstrap) {
    assert.ok(candidate.files.some(file => file.name === 'mirror-policy.json'), 'Candidate does not carry its compiled mirror policy');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(directory, 'mirror-policy.json'), 'utf8')),
      { repository: config.repository, redirectOrigins: config.downloadOrigins }, 'Publisher and compiled client mirror policies differ');
  }
  const next = nextPointer(candidate, digest);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'shhield-mirrors-'));
  const key = `_channels/${next.channel}.json`;
  try {
    const read = async () => {
      const file = path.join(temporary, 'current.json');
      const metadata = await r2('get-object', ['--key', key, file], true);
      if (!metadata) return null;
      assert.ok(typeof metadata.ETag === 'string' && metadata.ETag, 'Missing conditional-write ETag');
      assert.ok((await fs.stat(file)).size <= 16384, 'Release pointer too large');
      return { etag: metadata.ETag, value: validatePointer(JSON.parse(await fs.readFile(file, 'utf8')), next.channel) };
    };
    const previous = await read();
    assert.ok(previous || bootstrap, 'Initialize the current release pointer before enabling mirror publication');
    verifyAdvance(previous?.value, next);
    if (bootstrap) {
      if (previous) assert.deepEqual(previous.value, next, 'Bootstrap cannot replace an existing release');
      await anonymousFile(`${publicOrigin}/${next.channel}/update.json`, candidate.files.find(file => file.name === 'update.json'),
        next.channel === 'stable' ? ['https://github.com', 'https://release-assets.githubusercontent.com'] : [], request);
    }
    if (!bootstrap) {
      const active = await request(`${publicOrigin}/${next.channel}/update.json`, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000) });
      assert.equal(active.status, 200, 'Authoritative download route unavailable');
      assert.equal(active.headers.get('x-shhield-distribution'), 'r2', 'Download route has not migrated to the Worker');
      assert.match(active.headers.get('cache-control') || '', /no-store/, 'Authoritative manifest must not be cached');
      const feed = await active.json();
      assert.equal(feed.schema_version, 1, 'Unexpected authoritative schema');
      assert.equal(feed.channel, next.channel, 'Authoritative route serves the wrong channel');
      assert.equal(feed.version, previous.value.version, 'Authoritative route and R2 pointer disagree');
      assert.equal(feed.source_sha, previous.value.source_sha, 'Authoritative route and R2 source disagree');
    }
    const files = candidate.files.map(file => ({ ...file, path: path.join(directory, file.name) }));
    if (candidate.channel === 'production') {
      assert.ok(websiteFile, 'Frozen website manifest required');
      files.push({ name: 'latest.json', path: websiteFile, size: (await fs.stat(websiteFile)).size, sha256: await sha256(websiteFile) });
    }
    const release = await ensureCnbRelease(config, env, candidate, request);
    for (const file of files) {
      // shortcut: single PutObject is capped at 5 GiB; add conditional multipart uploads if packages grow beyond it.
      assert.ok(file.size < 5 * 1024 ** 3, 'Mirror file exceeds single-upload limit');
      const objectKey = next.prefix + file.name;
      const exists = await r2('head-object', ['--key', objectKey], true);
      if (!exists) {
        try {
          await r2('put-object', ['--key', objectKey, '--body', file.path, '--if-none-match', '*',
            '--content-type', file.name.endsWith('.json') ? 'application/json' : 'application/octet-stream', '--metadata', `sha256=${file.sha256}`]);
        } catch (error) { if (!error.precondition) throw error; }
      }
      await uploadCnb(config, env, release, file, request);
      await anonymousFile(`${bootstrap ? config.probe : publicOrigin}/${objectKey}`, file, [], request);
      await anonymousFile(`https://cnb.cool/${config.repository}/-/releases/download/${mirrorTag(candidate)}/${file.name}`, file, config.downloadOrigins, request);
    }
    assert.equal(await sha256(path.join(directory, 'candidate.json')), digest, 'Candidate metadata changed during publication');
    if (bootstrap) await anonymousFile(`${publicOrigin}/${next.channel}/update.json`, candidate.files.find(file => file.name === 'update.json'),
      next.channel === 'stable' ? ['https://github.com', 'https://release-assets.githubusercontent.com'] : [], request);
    await commitPointer({ previous, next, read, put: async (value, etag) => {
      const file = path.join(temporary, 'next.json');
      await fs.writeFile(file, JSON.stringify(value) + '\n');
      await r2('put-object', ['--key', key, '--body', file, '--content-type', 'application/json', '--cache-control', 'no-store',
        ...(etag ? ['--if-match', etag] : ['--if-none-match', '*'])]);
    } });
    return next;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
