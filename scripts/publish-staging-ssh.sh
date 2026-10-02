#!/usr/bin/env bash
set -euo pipefail

[[ $# == 1 ]] || { echo 'Usage: publish-staging-ssh.sh CANDIDATE_DIRECTORY' >&2; exit 2; }
scripts=$(cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
umask 077

node --input-type=module - "$1" "$temporary" "$scripts" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [directoryArg, temporary, scripts] = process.argv.slice(2);
const { sha256, validateIdentity, verifyCandidate } = await import(pathToFileURL(path.join(scripts, 'release-candidate.mjs')));
const directory = await fs.realpath(directoryArg);
const env = process.env;
assert.equal(env.GITHUB_REPOSITORY, 'gavin-k/shhield-ai-releases');
assert.equal(env.GITHUB_REF, 'refs/heads/main', 'Staging publication requires main');
assert.match(env.CANDIDATE_SHA256, /^[a-f0-9]{64}$/, 'Frozen candidate digest required');
assert.equal(await sha256(path.join(directory, 'candidate.json')), env.CANDIDATE_SHA256, 'Candidate digest mismatch');
const candidate = await verifyCandidate(directory, { channel: 'staging', windows_signing: 'signed', version: env.VERSION,
  source_sha: env.SOURCE_SHA, workflow_sha: env.GITHUB_SHA, run_id: env.GITHUB_RUN_ID });
assert.match(env.GITHUB_RUN_ATTEMPT, /^[1-9]\d*$/);
assert.match(candidate.run_attempt, /^[1-9]\d*$/);
assert.ok(BigInt(candidate.run_attempt) <= BigInt(env.GITHUB_RUN_ATTEMPT), 'Candidate is from a later run attempt');
validateIdentity(candidate);
assert.match(env.STAGING_SSH_TARGET, /^shhield-staging-publisher@[A-Za-z0-9][A-Za-z0-9.-]*$/, 'Invalid staging SSH target');
assert.ok(env.STAGING_SSH_KEY?.trim(), 'Missing staging SSH key');
assert.ok(env.STAGING_SSH_KNOWN_HOSTS?.trim(), 'Missing pinned staging SSH host key');
const identity = { VERSION: candidate.version, SOURCE_SHA: candidate.source_sha, GITHUB_SHA: candidate.workflow_sha,
  GITHUB_RUN_ID: candidate.run_id, GITHUB_RUN_ATTEMPT: candidate.run_attempt, CANDIDATE_SHA256: env.CANDIDATE_SHA256 };
await fs.writeFile(path.join(temporary, 'publish.env'), Object.entries(identity).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 });
await fs.writeFile(path.join(temporary, 'key'), env.STAGING_SSH_KEY + '\n', { mode: 0o600 });
await fs.writeFile(path.join(temporary, 'known_hosts'), env.STAGING_SSH_KNOWN_HOSTS + '\n', { mode: 0o600 });
await fs.symlink(directory, path.join(temporary, 'candidate'));
await fs.mkdir(path.join(temporary, 'scripts'));
for (const name of ['publish-staging.mjs', 'release-candidate.mjs']) {
  await fs.copyFile(path.join(scripts, name), path.join(temporary, 'scripts', name));
}
JS
unset STAGING_SSH_KEY STAGING_SSH_KNOWN_HOSTS

# Dereference only our local candidate link; the shared verifier requires regular candidate files.
COPYFILE_DISABLE=1 tar -chf - -C "$temporary" candidate scripts publish.env |
  ssh -F /dev/null -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o ClearAllForwardings=yes -o ForwardAgent=no -o ConnectTimeout=20 \
    -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -o "UserKnownHostsFile=$temporary/known_hosts" -i "$temporary/key" "$STAGING_SSH_TARGET"
