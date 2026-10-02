import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, updatePrefix, verifyCandidate } from './release-candidate.mjs';

export async function verifyDownloads(directory, request = fetch) {
  const candidate = await verifyCandidate(directory);
  const channel = candidate.channel === 'production' ? 'stable' : 'staging';
  const check = async (url, file) => {
    const response = await request(url, { cache: 'no-store', signal: AbortSignal.timeout(15 * 60 * 1000) });
    assert.equal(response.status, 200, `Download unavailable: ${url}`);
    if (channel === 'staging') {
      assert.match(response.headers.get('x-robots-tag') || '', /noindex/i, `Missing noindex: ${url}`);
      assert.match(response.headers.get('cache-control') || '', /no-store/i, `Missing no-store: ${url}`);
    }
    assert.ok(response.body, `Empty download: ${url}`);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= file.size, `Download exceeds frozen size: ${url}`);
      hash.update(chunk);
    }
    assert.equal(size, file.size, `Download size mismatch: ${url}`);
    assert.equal(hash.digest('hex'), file.sha256, `Download hash mismatch: ${url}`);
  };
  for (const name of ['update.json', 'latest-mac.yml']) {
    const file = candidate.files.find(item => item.name === name);
    assert.ok(file, `Missing frozen update metadata: ${name}`);
    await check(`https://download.shhield.ai/${channel}/${name}`, file);
  }
  for (const file of candidate.files) await check(updatePrefix(candidate) + file.name, file);
  return candidate;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const directory = process.argv[2];
  assert.ok(directory, 'Usage: node verify-downloads.mjs CANDIDATE_DIRECTORY');
  assert.equal(await sha256(path.join(directory, 'candidate.json')), process.env.CANDIDATE_SHA256,
    'Download check must use the frozen candidate digest');
  const candidate = await verifyDownloads(directory);
  console.log(`Verified ${candidate.channel} update feeds and ${candidate.files.length} original files over HTTPS`);
}
