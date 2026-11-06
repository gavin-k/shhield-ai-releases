import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { probeCnbOrigins } from './mirror-distribution.mjs';

assert.equal(process.env.GITHUB_REPOSITORY, 'gavin-k/shhield-ai-releases');
assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
const [directory, ...extra] = process.argv.slice(2);
assert.ok(directory && extra.length === 0, 'Usage: node probe-mirror-origins.mjs CANDIDATE_DIRECTORY');
const candidate = JSON.parse(await fs.readFile(path.join(directory, 'candidate.json'), 'utf8'));
const result = await probeCnbOrigins(directory, candidate);
await fs.writeFile('mirror-origins.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
