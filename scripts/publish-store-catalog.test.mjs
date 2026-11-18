import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import worker from '../download/worker.mjs';
import { checkStoreCatalog, publishStoreCatalog, storeCatalogKey } from './publish-store-catalog.mjs';

const objects = new Map();
const reads = [];
let cancelled = 0;
function object(key) {
  reads.push(key);
  if (!objects.has(key)) return null;
  const { bytes, contentType } = objects.get(key);
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); }, cancel() { cancelled++; } });
  return { size: bytes.length, httpEtag: '"etag"', body, writeHttpMetadata: headers => headers.set('Content-Type', contentType ?? 'application/octet-stream') };
}
const env = { RELEASES: { get: async key => object(key), head: async key => object(key) } };
const get = (pathname, init) => worker.fetch(new Request('https://download.shhield.ai' + pathname, init), env);

// Worker: both channels, catalog and signature, served straight from _store/ with no-store and nosniff.
for (const channel of ['stable', 'staging']) {
  for (const [name, type] of [['store-catalog.json', 'application/json'], ['store-catalog.json.sig', 'text/plain; charset=utf-8']]) {
    const pathname = `/${channel}/${name}`;
    assert.equal((await get(pathname)).status, 404, `missing ${pathname} is a plain 404`);
    objects.set(storeCatalogKey(channel, name), { bytes: Buffer.from(`${channel} ${name}`) });
    const response = await get(pathname);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), `${channel} ${name}`);
    assert.equal(response.headers.get('content-type'), type);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('content-length'), String(Buffer.byteLength(`${channel} ${name}`)));
    assert.equal(response.headers.get('x-robots-tag'), channel === 'staging' ? 'noindex, nofollow' : null);
    assert.ok(reads.at(-1) === `_store/${channel}/${name}`, 'reads only the store key');
    const head = await get(pathname, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('content-length'), String(Buffer.byteLength(`${channel} ${name}`)));
    assert.equal(head.headers.get('cache-control'), 'no-store');
    const query = await get(pathname + '?v=1');
    assert.equal(query.status, 404, 'query strings are rejected like update.json');
    if (channel === 'staging') assert.equal(query.headers.get('x-robots-tag'), 'noindex, nofollow');
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const rejected = await get(pathname, { method, body: method === 'DELETE' ? undefined : 'x' });
      assert.equal(rejected.status, 405);
      assert.equal(rejected.headers.get('allow'), 'GET, HEAD');
      assert.equal(rejected.headers.get('x-robots-tag'), channel === 'staging' ? 'noindex, nofollow' : null);
    }
  }
}
for (const [name, limit] of [['store-catalog.json', 512 * 1024], ['store-catalog.json.sig', 256]]) {
  objects.set(storeCatalogKey('stable', name), { bytes: Buffer.alloc(limit, 0x20) });
  assert.equal((await get(`/stable/${name}`)).status, 200, `${name} at the limit is served`);
  objects.set(storeCatalogKey('staging', name), { bytes: Buffer.alloc(limit + 1, 0x20) });
  const before = cancelled;
  const oversized = await get(`/staging/${name}`);
  assert.equal(oversized.status, 503, `oversized ${name} is unavailable`);
  assert.equal(oversized.headers.get('cache-control'), 'no-store');
  assert.equal(oversized.headers.get('x-robots-tag'), 'noindex, nofollow');
  assert.equal(cancelled, before + 1, 'the unread R2 body is released');
  assert.equal((await get(`/staging/${name}`, { method: 'HEAD' })).status, 503);
}
reads.length = 0;
for (const pathname of ['/_store/stable/store-catalog.json', '/production/store-catalog.json', '/stable/store-catalog.json.sig.sig',
  '/stable/store-catalog.sig', '/stable/Store-Catalog.json', '/stable//store-catalog.json', '/stable/store%2Dcatalog.json']) {
  assert.equal((await get(pathname)).status, 404, pathname);
}
assert.ok(!reads.some(key => key.startsWith('_store/')), 'other paths never reach the store objects');

// Publisher: checks match the app, uploads both files, and must read back the exact pair.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const publicKeyHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
const catalog = Buffer.from('{"version":1,"entries":[]}\n');
const signature = Buffer.from(`${sign(null, catalog, privateKey).toString('base64')}\n`);
checkStoreCatalog(catalog, signature, publicKeyHex);
assert.throws(() => checkStoreCatalog(Buffer.alloc(512 * 1024 + 1, 0x20), signature, publicKeyHex), /1-524288 bytes/);
assert.throws(() => checkStoreCatalog(Buffer.alloc(0), signature, publicKeyHex), /1-524288 bytes/);
assert.throws(() => checkStoreCatalog(catalog, Buffer.alloc(257, 0x41), publicKeyHex), /1-256 bytes/);
assert.throws(() => checkStoreCatalog(catalog, Buffer.from('not base64'), publicKeyHex), /base64 Ed25519/);
assert.throws(() => checkStoreCatalog(Buffer.from('[]'), signature, publicKeyHex), /JSON object/);
assert.throws(() => checkStoreCatalog(Buffer.from('{"version":1,"entries":[] }\n'), signature, publicKeyHex), /does not verify/);
assert.throws(() => checkStoreCatalog(catalog, signature, other), /does not verify/);
assert.throws(() => checkStoreCatalog(catalog, signature, ''), /public key/);

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'store-catalog-publish-'));
try {
  const catalogFile = path.join(directory, 'store-catalog.json');
  const signatureFile = catalogFile + '.sig';
  await fs.writeFile(catalogFile, catalog);
  await fs.writeFile(signatureFile, signature);
  const writes = [];
  let failWrite = false;
  const r2 = async (command, args) => {
    assert.equal(command, 'put-object');
    const key = args[args.indexOf('--key') + 1];
    if (failWrite) throw new Error('R2 put-object failed (AccessDenied)');
    assert.equal(args[args.indexOf('--cache-control') + 1], 'no-store');
    const contentType = args[args.indexOf('--content-type') + 1];
    assert.equal(contentType, key.endsWith('.sig') ? 'text/plain' : 'application/json');
    writes.push(key);
    objects.set(key, { bytes: await fs.readFile(args[args.indexOf('--body') + 1]), contentType });
    return {};
  };
  const served = [];
  let tamper;
  const request = async (input, options) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.credentials, 'omit');
    served.push(input);
    const response = await worker.fetch(new Request(input, { method: 'GET' }), env);
    return tamper ? tamper(input, response) : response;
  };
  for (const channel of ['staging', 'stable']) {
    writes.length = 0;
    served.length = 0;
    assert.deepEqual(await publishStoreCatalog(channel, catalogFile, signatureFile, publicKeyHex, { r2, request }),
      { channel, catalog_bytes: catalog.length, signature_bytes: signature.length });
    assert.deepEqual(writes, [storeCatalogKey(channel, 'store-catalog.json'), storeCatalogKey(channel, 'store-catalog.json.sig')]);
    assert.deepEqual(served, [`https://download.shhield.ai/${channel}/store-catalog.json`, `https://download.shhield.ai/${channel}/store-catalog.json.sig`]);
    assert.ok(objects.get(storeCatalogKey(channel, 'store-catalog.json')).bytes.equals(catalog));
  }
  writes.length = 0;
  await assert.rejects(publishStoreCatalog('stable', catalogFile, signatureFile, other, { r2, request }), /does not verify/);
  await assert.rejects(publishStoreCatalog('production', catalogFile, signatureFile, publicKeyHex, { r2, request }), /Invalid store catalog channel/);
  assert.equal(writes.length, 0, 'nothing is uploaded before local checks pass');
  failWrite = true;
  await assert.rejects(publishStoreCatalog('stable', catalogFile, signatureFile, publicKeyHex, { r2, request }), /AccessDenied/);
  failWrite = false;
  tamper = (input, response) => input.endsWith('.sig') ? new Response('stale signature\n', { headers: response.headers }) : response;
  await assert.rejects(publishStoreCatalog('stable', catalogFile, signatureFile, publicKeyHex, { r2, request }), /store-catalog\.json\.sig differs/);
  tamper = () => new Response(null, { status: 302, headers: { Location: 'https://elsewhere.example.invalid/store-catalog.json' } });
  await assert.rejects(publishStoreCatalog('stable', catalogFile, signatureFile, publicKeyHex, { r2, request }), /readback HTTP 302/);
  tamper = (input, response) => new Response(response.body, { headers: { 'Cache-Control': 'public, max-age=60' } });
  await assert.rejects(publishStoreCatalog('stable', catalogFile, signatureFile, publicKeyHex, { r2, request }), /cacheable/);
  tamper = () => new Response(Buffer.alloc(512 * 1024 + 1, 0x20), { headers: { 'Cache-Control': 'no-store' } });
  await assert.rejects(publishStoreCatalog('stable', catalogFile, signatureFile, publicKeyHex, { r2, request }), /exceeds 524288 bytes/);
  tamper = undefined;

  const cli = fileURLToPath(new URL('./publish-store-catalog.mjs', import.meta.url));
  const run = (args, extraEnv = {}) => spawnSync(process.execPath, [cli, ...args], {
    env: { PATH: process.env.PATH, R2_ACCOUNT_ID: '1'.repeat(32), R2_RELEASE_BUCKET: 'synthetic-bucket', R2_ACCESS_KEY_ID: 'synthetic', R2_SECRET_ACCESS_KEY: 'synthetic', ...extraEnv },
    encoding: 'utf8',
  });
  const usage = run(['production', catalogFile, signatureFile, publicKeyHex]);
  assert.notEqual(usage.status, 0);
  assert.match(usage.stderr, /Usage/);
  const credentials = run(['stable', catalogFile, signatureFile, publicKeyHex], { R2_SECRET_ACCESS_KEY: '' });
  assert.notEqual(credentials.status, 0);
  assert.match(credentials.stderr, /Missing R2 credentials/);
  const unsigned = run(['stable', catalogFile, signatureFile, other]);
  assert.notEqual(unsigned.status, 0, 'a signature the app cannot verify fails before any R2 call');
  assert.match(unsigned.stderr, /does not verify/);
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
console.log('PASS store catalog Worker routes, size limits, local signature checks and exact readback');
