import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { validatePointer } from '../download/worker.mjs';

const receiptKey = pointer => `_published/${pointer.prefix}receipt.json`;
const compareVersion = (a, b) => a.split('.').map((part, index) => Number(part) - Number(b.split('.')[index])).find(part => part !== 0) ?? 0;
function compareBatch(a, b) {
  const left = a.prefix.split('/').at(-2).split('-');
  const right = b.prefix.split('/').at(-2).split('-');
  for (let index = 0; index < 2; index++) {
    const difference = BigInt(left[index]) - BigInt(right[index]);
    if (difference) return difference > 0n ? 1 : -1;
  }
  return 0;
}

async function readJson(r2, key, directory) {
  const file = path.join(directory, 'read.json');
  const metadata = await r2('get-object', ['--key', key, file], true);
  if (!metadata) return null;
  assert.ok((await fs.stat(file)).size <= 16384, 'Oversized publication record');
  return { value: JSON.parse(await fs.readFile(file, 'utf8')), etag: metadata.ETag };
}

export async function recordPublishedRelease(r2, directory, pointer) {
  validatePointer(pointer, pointer.channel);
  const key = receiptKey(pointer);
  const existing = await readJson(r2, key, directory);
  if (existing) {
    assert.deepEqual(existing.value, pointer, 'Published receipt differs from channel identity');
    return;
  }
  const file = path.join(directory, 'receipt.json');
  await fs.writeFile(file, JSON.stringify(pointer) + '\n');
  try {
    await r2('put-object', ['--key', key, '--body', file, '--if-none-match', '*', '--content-type', 'application/json']);
  } catch {
    assert.deepEqual((await readJson(r2, key, directory))?.value, pointer, 'Publication receipt was not recorded; retry publication');
  }
}

async function listObjects(r2, prefix) {
  const objects = [];
  let token;
  const seen = new Set();
  do {
    const page = await r2('list-objects-v2', ['--prefix', prefix, '--no-paginate', ...(token ? ['--continuation-token', token] : [])]);
    assert.ok(Array.isArray(page.Contents ?? []), 'Invalid R2 object listing');
    for (const object of page.Contents ?? []) {
      assert.ok(typeof object.Key === 'string' && object.Key.startsWith(prefix), 'Object outside retention prefix');
      objects.push(object);
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    if (page.IsTruncated) {
      assert.ok(typeof token === 'string' && token && !seen.has(token), 'Invalid R2 continuation token');
      seen.add(token);
    }
  } while (token);
  return objects;
}

export async function prunePublishedReleases(r2, directory, channel) {
  assert.ok(['stable', 'staging'].includes(channel), 'Invalid retention channel');
  const key = `_channels/${channel}.json`;
  const current = await readJson(r2, key, directory);
  assert.ok(current?.etag, 'Cannot prune without a current channel pointer and ETag');
  validatePointer(current.value, channel);
  await recordPublishedRelease(r2, directory, current.value);
  const base = channel === 'stable' ? 'releases/' : 'staging/releases/';
  const receipts = [];
  for (const object of await listObjects(r2, `_published/${base}`)) {
    const record = await readJson(r2, object.Key, directory);
    assert.ok(record, 'Publication receipt disappeared');
    const pointer = validatePointer(record.value, channel);
    assert.equal(object.Key, receiptKey(pointer), 'Receipt key differs from published prefix');
    const published = Date.parse(object.LastModified);
    assert.ok(Number.isFinite(published), 'Invalid receipt publication time');
    receipts.push({ pointer, published });
  }
  receipts.sort((a, b) => b.published - a.published || compareVersion(b.pointer.version, a.pointer.version) || (channel === 'staging' ? compareBatch(b.pointer, a.pointer) : 0));
  const keep = new Set([current.value.prefix]);
  for (const { pointer } of receipts) {
    if (keep.size < 3) keep.add(pointer.prefix);
  }
  const obsolete = new Map(receipts.filter(({ pointer }) => !keep.has(pointer.prefix)).map(({ pointer }) => [pointer.prefix, pointer]));
  // Old objects predate receipts. Only retire them once three known publications prove a floor.
  if (keep.size === 3) {
    const floor = receipts.filter(({ pointer }) => keep.has(pointer.prefix)).map(({ pointer }) => pointer.version).sort(compareVersion)[0];
    for (const object of await listObjects(r2, base)) {
      const parts = object.Key.split('/');
      const prefix = parts.slice(0, channel === 'stable' ? 2 : 5).join('/') + '/';
      const version = parts[channel === 'stable' ? 1 : 2];
      const pointer = { ...current.value, prefix, version, source_sha: channel === 'stable' ? current.value.source_sha : parts[3] };
      try { validatePointer(pointer, channel); } catch { continue; }
      if (compareVersion(version, floor) < 0 && !keep.has(prefix)) obsolete.set(prefix, pointer);
    }
  }
  let deleted = 0;
  for (const pointer of obsolete.values()) {
    const objects = await listObjects(r2, pointer.prefix);
    // Publication and cleanup share the channel's workflow lock, including manual recovery.
    const active = await readJson(r2, key, directory);
    assert.deepEqual(active, current, 'Channel changed during cleanup; stop before deleting');
    assert.notEqual(pointer.prefix, active.value.prefix, 'Cannot delete the active release');
    for (const object of objects) await r2('delete-object', ['--key', object.Key]);
    // A partial deletion keeps its receipt so the same cleanup can finish on retry.
    await r2('delete-object', ['--key', receiptKey(pointer)]);
    deleted++;
  }
  return { retained: [...keep], deleted };
}
