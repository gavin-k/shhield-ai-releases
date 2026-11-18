import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { storeCatalogLimits } from '../download/worker.mjs';
import { r2Client } from './mirror-distribution.mjs';

const publicOrigin = 'https://download.shhield.ai';
const catalogName = 'store-catalog.json';
const signatureName = 'store-catalog.json.sig';

export const storeCatalogKey = (channel, name) => `_store/${channel}/${name}`;

// Same checks as the desktop app: size caps, a 64-byte base64 signature and an Ed25519 verify over the exact bytes.
export function checkStoreCatalog(catalog, signature, publicKeyHex) {
  assert.ok(catalog.length > 0 && catalog.length <= storeCatalogLimits[catalogName], `Store catalog must be 1-${storeCatalogLimits[catalogName]} bytes`);
  assert.ok(signature.length > 0 && signature.length <= storeCatalogLimits[signatureName], `Store catalog signature must be 1-${storeCatalogLimits[signatureName]} bytes`);
  const parsed = JSON.parse(catalog.toString('utf8'));
  assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'Store catalog must be a JSON object');
  const encoded = signature.toString('utf8').trim();
  assert.match(encoded, /^[A-Za-z0-9+/]{86}==$/, 'Store catalog signature must be one base64 Ed25519 signature');
  assert.match(publicKeyHex || '', /^[0-9a-f]{64}$/, 'App public key must be 64 lowercase hex characters');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
  assert.ok(verify(null, catalog, key, Buffer.from(encoded, 'base64')), 'Store catalog signature does not verify with the app public key');
}

// Reads like the app: direct same-origin 200 only, no redirects, no credentials, capped size.
async function anonymousBytes(url, limit, request) {
  const response = await request(url, { redirect: 'manual', credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(30000) });
  if (response.status !== 200 || !response.body) {
    await response.body?.cancel();
    throw new Error(`Store catalog readback HTTP ${response.status}: ${url}`);
  }
  assert.match(response.headers.get('cache-control') || '', /no-store/, `Store catalog readback is cacheable: ${url}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) { await response.body.cancel().catch(() => {}); throw new Error(`Store catalog readback exceeds ${limit} bytes: ${url}`); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function publishStoreCatalog(channel, catalogFile, signatureFile, publicKeyHex, { r2, request = fetch, origin = publicOrigin } = {}) {
  assert.ok(['stable', 'staging'].includes(channel), 'Invalid store catalog channel');
  const files = { [catalogName]: await fs.readFile(catalogFile), [signatureName]: await fs.readFile(signatureFile) };
  checkStoreCatalog(files[catalogName], files[signatureName], publicKeyHex);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'shhield-store-catalog-'));
  try {
    // Upload from a private copy so the bytes compared below are exactly the bytes that were checked.
    // R2 has no cross-object transaction: until both writes land, the app may see a mismatched pair,
    // reject the signature and keep its built-in catalog. The readback below must end with a matching pair.
    for (const [name, contentType] of [[catalogName, 'application/json'], [signatureName, 'text/plain']]) {
      const file = path.join(temporary, name);
      await fs.writeFile(file, files[name], { mode: 0o600 });
      await r2('put-object', ['--key', storeCatalogKey(channel, name), '--body', file, '--content-type', contentType, '--cache-control', 'no-store']);
    }
    for (const name of [catalogName, signatureName]) {
      const served = await anonymousBytes(`${origin}/${channel}/${name}`, storeCatalogLimits[name], request);
      assert.ok(served.equals(files[name]), `Published ${name} differs from the signed file`);
    }
    return { channel, catalog_bytes: files[catalogName].length, signature_bytes: files[signatureName].length };
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [channel, catalogFile, signatureFile, publicKeyHex, ...extra] = process.argv.slice(2);
  assert.ok(['stable', 'staging'].includes(channel) && catalogFile && signatureFile && publicKeyHex && extra.length === 0,
    'Usage: node publish-store-catalog.mjs stable|staging STORE_CATALOG_JSON STORE_CATALOG_SIG APP_PUBLIC_KEY_HEX');
  assert.match(process.env.R2_ACCOUNT_ID || '', /^[a-f0-9]{32}$/, 'Missing R2 account');
  assert.match(process.env.R2_RELEASE_BUCKET || '', /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'Invalid release bucket');
  assert.ok(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY, 'Missing R2 credentials');
  const result = await publishStoreCatalog(channel, catalogFile, signatureFile, publicKeyHex, { r2: r2Client(process.env) });
  console.log(JSON.stringify(result));
}
