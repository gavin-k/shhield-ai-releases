import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateIdentity(identity) {
  assert.match(identity.version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.ok(identity.version.split('.').every((n, i) => Number(n) <= (i === 2 ? 65535 : 255)));
  assert.ok(['staging', 'production'].includes(identity.channel));
  assert.match(identity.source_sha, /^[a-f0-9]{40}$/);
  assert.match(identity.workflow_sha, /^[a-f0-9]{40}$/);
  assert.match(identity.run_id, /^\d+$/);
  assert.match(identity.run_attempt, /^\d+$/);
  if (identity.platforms !== undefined) {
    const platforms = identity.platforms.split(',');
    assert.ok(platforms.every((name, i) => PLATFORMS.includes(name) && (i === 0 || platforms[i - 1] < name)),
      'Platforms must be a sorted, unique subset of linux,macos,windows');
    assert.ok(platforms.includes('macos'), 'Every release ships macOS');
    assert.ok(identity.channel === 'production' || !platforms.includes('linux'), 'Linux is built for production only');
  }
  if (identity.windows_signing !== undefined) {
    assert.ok(['signed', 'unsigned'].includes(identity.windows_signing), 'Invalid Windows signing mode');
    if (identity.windows_signing === 'unsigned') {
      assert.equal(identity.channel, 'staging', 'Production Windows packages must be signed');
      assert.ok(releaseScope(identity).platforms.includes('windows'), 'Unsigned mode requires a Windows package');
    }
  }
}

const PLATFORMS = ['linux', 'macos', 'windows'];
const LINUX_SUFFIXES = ['.deb', '.rpm', '.flatpak'];

// Windows may sit out production (or ship unsigned to staging) while its certificate is pending.
// Candidates without explicit scope include all platforms for their channel.
export function releaseScope(identity) {
  const platforms = identity.platforms ?? (identity.channel === 'production' ? 'linux,macos,windows' : 'macos,windows');
  return { platforms: platforms.split(','), unsignedWindows: identity.windows_signing === 'unsigned' };
}

export function scopeFromEnvironment(env = process.env) {
  return { ...(env.RELEASE_PLATFORMS ? { platforms: env.RELEASE_PLATFORMS } : {}),
    ...(env.WINDOWS_SIGNING ? { windows_signing: env.WINDOWS_SIGNING } : {}) };
}

// Download links and update feeds follow the latest release, so a new one must not drop a platform.
export function offeredPlatforms(names) {
  return PLATFORMS.filter(platform => names.some(name => platform === 'windows' ? name.endsWith('.msi')
    : platform === 'macos' ? name === 'Shhield.zip' : LINUX_SUFFIXES.some(suffix => name.endsWith(suffix))));
}

export async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export function requiredPackages(identity) {
  const label = identity.channel === 'staging' ? 'Shhield-AI-Staging' : 'Shhield-AI';
  const { platforms, unsignedWindows } = releaseScope(identity);
  const packages = [];
  if (platforms.includes('windows')) {
    // Windows ships only an MSI; unsigned packages are restricted to staging testers.
    packages.push([`${label}-${identity.version}-windows-x64${unsignedWindows ? '-unsigned' : ''}.msi`, 'windows-msi', 'windows', 'x64', 'msi', 'Windows 11']);
  }
  packages.push(['Shhield.zip', 'macos-arm64', 'macos', 'arm64', 'zip', 'macOS 12'],
    ['Shhield_intel_mac.zip', 'macos-x64', 'macos', 'x64', 'zip', 'macOS 12']);
  return packages;
}

function validatePackages(names, identity) {
  const packages = requiredPackages(identity);
  const { platforms } = releaseScope(identity);
  for (const [name] of packages) assert.ok(names.includes(name), `Missing ${name}`);
  if (identity.channel === 'production' && platforms.includes('linux')) {
    for (const suffix of LINUX_SUFFIXES) {
      assert.ok(names.some(name => name.endsWith(suffix)), `Missing Linux ${suffix}`);
    }
  }
  const packageFile = id => packages.find(([, packageId]) => packageId === id)?.[0];
  for (const name of names) {
    if (name === 'update.json') continue;
    assert.match(name, /^[A-Za-z0-9][A-Za-z0-9_+.-]*\.(zip|msi|sha256|deb|rpm|flatpak|yml)$/);
    if (/unsigned/i.test(name)) {
      const msi = packageFile('windows-msi');
      assert.ok(msi && /unsigned/i.test(msi) && (name === msi || name === msi + '.sha256'), `Non-release package: ${name}`);
    }
    assert.ok(!/portable/i.test(name), `Unexpected Portable package: ${name}`);
    if (!platforms.includes('windows')) assert.ok(!/windows/i.test(name), `Out-of-scope Windows file: ${name}`);
    if (!platforms.includes('linux')) assert.ok(!LINUX_SUFFIXES.some(suffix => name.endsWith(suffix)), `Out-of-scope Linux file: ${name}`);
    if (identity.channel === 'production') assert.ok(!/staging/i.test(name));
  }
}

export async function createCandidate(directory, identity) {
  validateIdentity(identity);
  const names = (await fs.readdir(directory)).sort();
  validatePackages(names, identity);
  const files = [];
  for (const name of names) {
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    assert.ok(stat.isFile() && stat.size > 0, `Invalid file: ${name}`);
    files.push({ name, size: stat.size, sha256: await sha256(file) });
  }
  const candidate = { ...identity, created_at: new Date().toISOString(), files };
  await verifyUpdateMetadata(directory, candidate);
  await fs.writeFile(path.join(directory, 'candidate.json'), JSON.stringify(candidate, null, 2) + '\n', { flag: 'wx' });
  return candidate;
}

export async function verifyCandidate(directory, expected = {}) {
  const candidate = JSON.parse(await fs.readFile(path.join(directory, 'candidate.json'), 'utf8'));
  validateIdentity(candidate);
  for (const [key, value] of Object.entries(expected)) assert.equal(candidate[key], value, `Wrong ${key}`);
  assert.ok(Array.isArray(candidate.files));
  const names = candidate.files.map(file => file.name);
  assert.equal(new Set(names).size, names.length, 'Duplicate file names');
  assert.deepEqual((await fs.readdir(directory)).sort(), [...names, 'candidate.json'].sort(), 'Unexpected/missing files');
  validatePackages(names, candidate);
  for (const file of candidate.files) {
    assert.match(file.sha256, /^[a-f0-9]{64}$/);
    assert.ok(Number.isSafeInteger(file.size) && file.size > 0);
    const actual = path.join(directory, file.name);
    const stat = await fs.lstat(actual);
    assert.ok(stat.isFile());
    assert.equal(stat.size, file.size, `Wrong size: ${file.name}`);
    assert.equal(await sha256(actual), file.sha256, `Wrong SHA-256: ${file.name}`);
  }
  await verifyUpdateMetadata(directory, candidate);
  return candidate;
}

export function updatePrefix(identity) {
  return identity.channel === 'production' ? `https://download.shhield.ai/releases/${identity.version}/`
    : `https://download.shhield.ai/staging/releases/${identity.version}/${identity.source_sha}/${identity.run_id}-${identity.run_attempt}/`;
}

async function verifyUpdateMetadata(directory, candidate) {
  // Old accepted candidates predate update feeds; new prepare-candidate always generates them.
  if (!candidate.files.some(file => file.name === 'update.json')) return;
  const feed = JSON.parse(await fs.readFile(path.join(directory, 'update.json'), 'utf8'));
  assert.equal(feed.schema_version, 1);
  assert.equal(feed.channel, candidate.channel === 'production' ? 'stable' : 'staging', 'update channel');
  assert.equal(feed.version, candidate.version, 'update version');
  assert.equal(feed.source_sha, candidate.source_sha, 'update source');
  assert.ok(Number.isFinite(Date.parse(feed.published_at)), 'update timestamp');
  const prefix = updatePrefix(candidate);
  const packages = requiredPackages(candidate);
  assert.equal(feed.artifacts.length, packages.length, 'update artifact count');
  for (const [index, [name, id, platform, arch, format, minimum_os]] of packages.entries()) {
    const file = candidate.files.find(item => item.name === name);
    assert.deepEqual(feed.artifacts[index], { id, platform, arch, format, minimum_os, ...file, url: prefix + name }, 'update artifact does not match frozen package');
  }
  assert.ok(candidate.files.some(file => file.name === 'latest-mac.yml'), 'missing frozen macOS metadata');
  const mac = JSON.parse(await fs.readFile(path.join(directory, 'latest-mac.yml'), 'utf8'));
  const expected = [];
  for (const [index, name] of ['Shhield-darwin-arm64.zip', 'Shhield-darwin-x64.zip'].entries()) {
    const alias = candidate.files.find(file => file.name === name);
    const original = feed.artifacts.find(file => file.id === (index === 0 ? 'macos-arm64' : 'macos-x64'));
    assert.ok(alias && alias.sha256 === original.sha256 && alias.size === original.size, 'macOS alias must preserve original bytes');
    const hash = createHash('sha512');
    for await (const chunk of createReadStream(path.join(directory, name))) hash.update(chunk);
    expected.push({ url: prefix + name, sha512: hash.digest('base64'), size: alias.size });
  }
  assert.deepEqual(mac, { version: candidate.version, files: expected, path: expected[0].url, sha512: expected[0].sha512, releaseDate: feed.published_at }, 'macOS update metadata mismatch');
}

export function websiteManifest(candidate, publishedAt = new Date().toISOString()) {
  assert.equal(candidate.channel, 'production');
  return {
    version: candidate.version,
    published_at: publishedAt,
    artifacts: requiredPackages(candidate).map(([name, id, platform, arch, format, minimum_os]) => {
      const file = candidate.files.find(item => item.name === name);
      assert.ok(file, `Missing ${name}`);
      return { id, platform, arch, format, minimum_os, ...file,
        url: `https://download.shhield.ai/releases/${candidate.version}/${name}` };
    }),
  };
}

export async function checkBackend(channel) {
  assert.ok(['staging', 'production'].includes(channel), 'Invalid backend channel');
  const origin = channel === 'staging' ? 'https://staging.shhield.ai' : 'https://shhield.ai';
  const response = await fetch(`${origin}/api/v1/commerce/status`, { signal: AbortSignal.timeout(15000), redirect: 'error' });
  assert.equal(response.status, 200, `${channel} backend is not ready`);
  const status = await response.json();
  assert.equal(status.staging, channel === 'staging', 'Backend environment mismatch');
  if (channel === 'staging') assert.equal(status.checkoutEnabled, true, 'Staging checkout is disabled');
  return origin;
}

export async function checkApprovalGates() {
  assert.equal(process.env.GITHUB_REPOSITORY, 'gavin-k/shhield-ai-releases');
  const get = async resource => {
    const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${resource}`, {
      headers: { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    assert.equal(response.status, 200, `Cannot verify ${resource}`);
    return response.json();
  };
  for (const name of ['staging-acceptance', 'release']) {
    const environment = await get(`environments/${name}`);
    assert.ok(environment.protection_rules.some(rule => rule.type === 'required_reviewers' && rule.reviewers.length > 0),
      `${name} requires human reviewers`);
    assert.equal(environment.deployment_branch_policy?.custom_branch_policies, true, `${name} requires selected branches`);
    const policies = await get(`environments/${name}/deployment-branch-policies`);
    assert.equal(policies.total_count, 1, `${name} must allow only main`);
    assert.equal(policies.branch_policies[0].name, 'main');
    assert.equal(policies.branch_policies[0].type, 'branch');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, directory] = process.argv.slice(2);
  if (command === 'check-backend') {
    console.log(`Backend ready: ${await checkBackend(directory)}`);
  } else if (command === 'preflight') {
    validateIdentity({ version: process.env.VERSION, channel: 'staging', source_sha: process.env.SOURCE_SHA,
      workflow_sha: process.env.GITHUB_SHA, run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT });
    await checkApprovalGates();
    await checkBackend('staging');
    console.log('Release identity, approval gates and staging service verified');
  } else {
    const identity = { version: process.env.VERSION, channel: process.env.CHANNEL,
      source_sha: process.env.SOURCE_SHA, workflow_sha: process.env.GITHUB_SHA,
      run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT, ...scopeFromEnvironment() };
    const expected = { ...identity };
    delete expected.run_attempt;
    const candidate = command === 'create'
      ? await createCandidate(directory, identity)
      : command === 'verify' ? await verifyCandidate(directory, expected) : assert.fail('Expected create, verify or check-backend');
    const digest = await sha256(path.join(directory, 'candidate.json'));
    if (command === 'verify') {
      assert.equal(digest, process.env.CANDIDATE_SHA256, 'Candidate differs from the approved artifact');
      await checkApprovalGates();
    }
    if (process.env.GITHUB_OUTPUT) await fs.appendFile(process.env.GITHUB_OUTPUT, `sha256=${digest}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,
        `## ${candidate.channel} candidate ${candidate.version}\n\nSource: \`${candidate.source_sha}\`\n\nCandidate SHA-256: \`${digest}\`\n\n` +
        candidate.files.map(file => `- ${file.name}: \`${file.sha256}\``).join('\n') +
        '\n\nApproval must record this candidate hash, tested OS versions, actual backend image digest, and package/licensing acceptance results.\n');
    }
    console.log(`Candidate verified: ${digest}`);
  }
}
