import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { requiredPackages, validateIdentity, sha256, updatePrefix } from './release-candidate.mjs';

const [directoryArg, version, channel, source_sha, run_id, run_attempt, ...extra] = process.argv.slice(2);
assert.equal(extra.length, 0, 'unexpected arguments');
assert.ok(directoryArg, 'candidate directory required');
const identity = { version, channel, source_sha, run_id, run_attempt, workflow_sha: source_sha };
validateIdentity(identity);
const directory = path.resolve(directoryArg);
const aliases = ['Shhield-darwin-arm64.zip', 'Shhield-darwin-x64.zip'];
for (const name of ['candidate.json', 'update.json', 'latest-mac.yml', ...aliases]) {
  await assert.rejects(fs.lstat(path.join(directory, name)), { code: 'ENOENT' }, `refusing to overwrite ${name}`);
}
const prefix = updatePrefix(identity);
const artifacts = [];
for (const [name, id, platform, arch, format, minimum_os] of requiredPackages(identity)) {
  const file = path.join(directory, name);
  const stat = await fs.lstat(file);
  assert.ok(stat.isFile() && stat.size > 0, `invalid package ${name}`);
  artifacts.push({ id, platform, arch, format, minimum_os, name, size: stat.size, sha256: await sha256(file), url: prefix + name });
}
const releaseDate = new Date().toISOString();
const macFiles = [];
for (const [index, artifact] of artifacts.filter(file => file.platform === 'macos').entries()) {
  const source = path.join(directory, artifact.name);
  const alias = path.join(directory, aliases[index]);
  // MacUpdater selects architecture from URL names. Preserve accepted package bytes, not a repack.
  // ponytail: aliases duplicate ZIP storage; use immutable CDN aliases if that cost becomes material.
  await fs.copyFile(source, alias, constants.COPYFILE_EXCL);
  assert.equal(await sha256(alias), artifact.sha256, 'package changed while generating aliases');
  const hash = createHash('sha512');
  for await (const chunk of createReadStream(alias)) hash.update(chunk);
  macFiles.push({ url: prefix + aliases[index], sha512: hash.digest('base64'), size: artifact.size });
}
const write = (name, value) => fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
await write('update.json', { schema_version: 1, channel: channel === 'production' ? 'stable' : 'staging',
  version, source_sha, published_at: releaseDate, artifacts });
// JSON is a YAML subset; the installed updater's YAML reader accepts this without another serializer.
await write('latest-mac.yml', { version, files: macFiles, path: macFiles[0].url, sha512: macFiles[0].sha512, releaseDate });
console.log(`Generated ${channel} update metadata; freeze it with the candidate before acceptance`);
