import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordPublishedRelease, prunePublishedReleases } from './r2-retention.mjs';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'r2-retention-check-'));
const pointer = (channel, n, batch = `${n}-1`) => ({
  schema_version: 1, channel, version: `1.0.${n}`, source_sha: 'a'.repeat(40),
  candidate_sha256: n.toString(16).padStart(64, '0'), platforms: ['macos'],
  prefix: channel === 'stable' ? `releases/1.0.${n}/` : `staging/releases/1.0.${n}/${'a'.repeat(40)}/${batch}/`,
});
const objects = new Map();
const modified = new Map();
let sequence = 0;
let failDelete = false;
let changePointer = false;
let loseResponse = false;
let deletionCount = 0;
const put = (key, value) => {
  objects.set(key, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)));
  modified.set(key, new Date(1700000000000 + sequence++ * 1000).toISOString());
};
const r2 = async (command, args) => {
  const key = args[args.indexOf('--key') + 1];
  if (command === 'get-object') {
    if (!objects.has(key)) return null;
    await fs.writeFile(args.at(-1), objects.get(key));
    return { ETag: `"${modified.get(key)}"` };
  }
  if (command === 'put-object') {
    assert.ok(args.includes('--if-none-match'));
    assert.ok(!objects.has(key));
    put(key, await fs.readFile(args[args.indexOf('--body') + 1], 'utf8'));
    if (loseResponse) { loseResponse = false; throw new Error('lost write response'); }
    return {};
  }
  if (command === 'delete-object') {
    if (failDelete && key.endsWith('package.zip')) { failDelete = false; throw new Error('delete failed'); }
    objects.delete(key);
    deletionCount++;
    return {};
  }
  assert.equal(command, 'list-objects-v2');
  assert.ok(args.includes('--no-paginate'));
  const prefix = args[args.indexOf('--prefix') + 1];
  const keys = [...objects.keys()].filter(key => key.startsWith(prefix)).sort();
  const offset = args.includes('--continuation-token') ? Number(args[args.indexOf('--continuation-token') + 1]) : 0;
  if (changePointer && prefix.startsWith('releases/')) {
    changePointer = false;
    put('_channels/stable.json', pointer('stable', 1));
  }
  return { Contents: keys.slice(offset, offset + 2).map(Key => ({ Key, LastModified: modified.get(Key) })),
    IsTruncated: offset + 2 < keys.length, NextContinuationToken: String(offset + 2) };
};
async function publish(value) {
  put(value.prefix + 'package.zip', 'signed bytes');
  put(value.prefix + 'update.json', '{}');
  put(`_channels/${value.channel}.json`, value);
  await recordPublishedRelease(r2, directory, value);
}
try {
  for (const channel of ['stable', 'staging']) {
    for (let n = 1; n <= 5; n++) await publish(pointer(channel, n));
  }
  put('releases/0.0.1/untracked.zip', 'legacy objects are not proof of publication');
  const unpublished = pointer('staging', 90).prefix + 'package.zip';
  put(unpublished, 'failed upload must not displace published batches');
  const stable = await prunePublishedReleases(r2, directory, 'stable');
  assert.equal(stable.deleted, 3);
  assert.deepEqual(new Set(stable.retained), new Set([3, 4, 5].map(n => pointer('stable', n).prefix)));
  assert.ok(objects.has(pointer('staging', 1).prefix + 'package.zip'), 'channels must be isolated');
  assert.ok(!objects.has('releases/0.0.1/untracked.zip'), 'legacy prefixes below three confirmed publications can be retired');
  assert.ok(objects.has(unpublished));
  assert.equal((await prunePublishedReleases(r2, directory, 'stable')).deleted, 0, 'cleanup is idempotent');
  // Same-version staging rebuilds count as separate published batches.
  for (let n = 6; n <= 9; n++) await publish({ ...pointer('staging', 5, `${n}-1`), candidate_sha256: String(n).repeat(64) });
  assert.equal((await prunePublishedReleases(r2, directory, 'staging')).retained.length, 3);
  for (const n of [7, 8, 9]) assert.ok(objects.has(pointer('staging', 5, `${n}-1`).prefix + 'package.zip'));
  await publish(pointer('stable', 6));
  failDelete = true;
  await assert.rejects(prunePublishedReleases(r2, directory, 'stable'), /delete failed/);
  assert.ok(objects.has(`_published/${pointer('stable', 3).prefix}receipt.json`), 'partial cleanup retains retry evidence');
  assert.equal((await prunePublishedReleases(r2, directory, 'stable')).deleted, 1);
  await publish(pointer('stable', 7));
  const before = deletionCount;
  changePointer = true;
  await assert.rejects(prunePublishedReleases(r2, directory, 'stable'), /Channel changed/);
  assert.equal(deletionCount, before, 'pointer changes stop deletion');
  put('_channels/stable.json', pointer('stable', 5));
  const rollback = await prunePublishedReleases(r2, directory, 'stable');
  assert.ok(rollback.retained.includes(pointer('stable', 5).prefix), 'rollback target stays protected');
  loseResponse = true;
  await publish(pointer('stable', 8));
  await recordPublishedRelease(r2, directory, pointer('stable', 8));
  const bad = '_published/releases/1.0.0/receipt.json';
  put(bad, { ...pointer('stable', 1), prefix: '_channels/' });
  await assert.rejects(prunePublishedReleases(r2, directory, 'stable'), /Invalid release pointer/);
  objects.delete(bad);
  await assert.rejects(prunePublishedReleases(r2, directory, 'production'), /Invalid retention channel/);
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
console.log('PASS published-only retention, pagination, channel isolation, rollback protection and retry safety');
