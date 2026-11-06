import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { publishMirrors } from './mirror-distribution.mjs';
import { verifyCandidate, websiteManifest } from './release-candidate.mjs';

const [command, directory, websiteFile, ...extra] = process.argv.slice(2);
assert.ok(['staging', 'bootstrap'].includes(command) && directory && extra.length === 0,
  'Usage: node publish-mirrors.mjs staging|bootstrap CANDIDATE_DIRECTORY [FROZEN_WEBSITE_MANIFEST]');
if (command === 'staging') {
  assert.equal(process.env.GITHUB_REPOSITORY, 'gavin-k/shhield-ai-releases');
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main', 'Staging publication requires main');
  assert.match(process.env.GITHUB_RUN_ATTEMPT, /^[1-9]\d*$/);
}
const candidate = await verifyCandidate(directory, command === 'staging' ? {
  channel: 'staging', windows_signing: 'signed', version: process.env.VERSION, source_sha: process.env.SOURCE_SHA,
  workflow_sha: process.env.GITHUB_SHA, run_id: process.env.GITHUB_RUN_ID, run_attempt: process.env.GITHUB_RUN_ATTEMPT,
} : {});
if (candidate.channel === 'production') {
  assert.ok(websiteFile, 'Bootstrap stable requires the existing published latest.json');
  const website = JSON.parse(await fs.readFile(websiteFile, 'utf8'));
  assert.ok(Number.isFinite(Date.parse(website.published_at)), 'Invalid website timestamp');
  assert.deepEqual(website, websiteManifest(candidate, website.published_at), 'Website manifest differs from frozen candidate');
}
await publishMirrors(directory, candidate, websiteFile, { bootstrap: command === 'bootstrap' });
console.log(`Verified both mirrors and committed ${candidate.channel} ${candidate.version}`);
