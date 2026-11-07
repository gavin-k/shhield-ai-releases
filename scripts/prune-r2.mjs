import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { r2Client } from './mirror-distribution.mjs';
import { prunePublishedReleases } from './r2-retention.mjs';

const [channel, ...extra] = process.argv.slice(2);
assert.ok(['stable', 'staging'].includes(channel) && extra.length === 0, 'Usage: node prune-r2.mjs stable|staging');
assert.match(process.env.R2_ACCOUNT_ID || '', /^[a-f0-9]{32}$/);
assert.match(process.env.R2_RELEASE_BUCKET || '', /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/);
assert.ok(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY, 'Missing R2 credentials');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'shhield-retention-'));
try {
  const result = await prunePublishedReleases(r2Client(process.env), directory, channel);
  console.log(JSON.stringify({ channel, ...result }));
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
