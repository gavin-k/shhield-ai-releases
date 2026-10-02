import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, verifyCandidate } from './release-candidate.mjs';

const repository = 'gavin-k/shhield-ai-releases';
const origin = `https://github.com/${repository}`;
export function selectCandidate(run, artifacts) {
  assert.equal(run.repository.full_name, repository);
  assert.equal(run.head_branch, 'main', 'Release must originate on main');
  assert.equal(run.event, 'workflow_dispatch');
  assert.equal(run.path, '.github/workflows/release.yml');
  assert.match(run.head_sha, /^[a-f0-9]{40}$/);
  const title = /^Release v(\d+\.\d+\.\d+) from ([a-f0-9]{40})$/.exec(run.display_title);
  assert.ok(title, 'Unexpected release identity');
  const candidates = artifacts.filter(artifact => new RegExp(`^candidate-staging-${run.id}-[1-9]\\d*$`).test(artifact.name));
  candidates.sort((a, b) => Number(b.name.split('-').at(-1)) - Number(a.name.split('-').at(-1)));
  assert.ok(candidates.length, 'No frozen staging candidate');
  const artifact = candidates[0];
  const attempt = artifact.name.split('-').at(-1);
  assert.equal(candidates.filter(item => item.name === artifact.name).length, 1, 'Ambiguous candidate artifact');
  assert.ok(!artifact.expired, 'Candidate artifact expired');
  assert.ok(Number(attempt) <= run.run_attempt, 'Invalid candidate attempt');
  return { run_id: String(run.id), run_attempt: attempt, workflow_sha: run.head_sha,
    version: title[1], source_sha: title[2], artifact_id: String(artifact.id) };
}

export function verifyProvenance(results, candidate, digest) {
  assert.ok(Array.isArray(results) && results.some(result => {
    const statement = result.verificationResult?.statement;
    const definition = statement?.predicate?.buildDefinition;
    const workflow = definition?.externalParameters?.workflow;
    const details = statement?.predicate?.runDetails;
    return statement?.predicateType === 'https://slsa.dev/provenance/v1'
      && statement.subject?.some(subject => subject.name === 'candidate.json' && subject.digest?.sha256 === digest)
      && workflow?.repository === origin && workflow.ref === 'refs/heads/main' && workflow.path === '.github/workflows/release.yml'
      && definition.resolvedDependencies?.some(dependency => dependency.uri === `git+${origin}@refs/heads/main` && dependency.digest?.gitCommit === candidate.workflow_sha)
      && details?.builder?.id === `${origin}/.github/workflows/prepare-candidate.yml@refs/heads/main`
      && details.metadata?.invocationId === `${origin}/actions/runs/${candidate.run_id}/attempts/${candidate.run_attempt}`;
  }), 'Verified attestation does not match the frozen release run');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [command, ...args] = process.argv.slice(2);
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.equal(process.env.GITHUB_REF, 'refs/heads/main');
  if (command === 'select') {
    const [runId, contextFile] = args;
    assert.match(runId, /^[1-9]\d*$/);
    const get = resource => JSON.parse(execFileSync('gh', ['api', `repos/${repository}/${resource}`], { encoding: 'utf8' }));
    const run = get(`actions/runs/${runId}`);
    const artifacts = get(`actions/runs/${runId}/artifacts?per_page=100`);
    assert.ok(artifacts.total_count <= 100, 'Too many artifacts to select unambiguously');
    const context = selectCandidate(run, artifacts.artifacts);
    const jobs = get(`actions/runs/${runId}/attempts/${context.run_attempt}/jobs?per_page=100`);
    assert.ok(jobs.total_count <= 100, 'Too many jobs to verify');
    assert.ok(jobs.jobs.some(job => job.name === 'staging-candidate / prepare' && job.conclusion === 'success'), 'Candidate preparation must have succeeded');
    await fs.writeFile(contextFile, JSON.stringify(context));
    await fs.appendFile(process.env.GITHUB_OUTPUT, `artifact_id=${context.artifact_id}\n`);
  } else if (command === 'verify') {
    const [contextFile, directory, attestationFile] = args;
    const context = JSON.parse(await fs.readFile(contextFile, 'utf8'));
    const { artifact_id, ...identity } = context;
    const candidate = await verifyCandidate(directory, { ...identity, channel: 'staging', windows_signing: 'signed' });
    const digest = await sha256(path.join(directory, 'candidate.json'));
    verifyProvenance(JSON.parse(await fs.readFile(attestationFile, 'utf8')), candidate, digest);
    const output = { version: candidate.version, source_sha: candidate.source_sha, workflow_sha: candidate.workflow_sha,
      run_id: candidate.run_id, run_attempt: candidate.run_attempt, sha256: digest };
    await fs.appendFile(process.env.GITHUB_OUTPUT, Object.entries(output).map(([key, value]) => `${key}=${value}\n`).join(''));
    console.log(`Verified signed staging candidate ${candidate.version} from release ${candidate.run_id}/${candidate.run_attempt}: ${digest}`);
  } else {
    assert.fail('Expected select or verify');
  }
}
