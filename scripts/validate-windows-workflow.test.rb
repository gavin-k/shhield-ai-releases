require 'yaml'

workflow = YAML.safe_load_file(File.expand_path('../.github/workflows/validate-windows.yml', __dir__))
raise 'Manual dispatch only' unless workflow.fetch('on').keys == ['workflow_dispatch']
raise 'Read-only default token required' unless workflow.fetch('permissions') == { 'contents' => 'read' }
jobs = workflow.fetch('jobs')
raise 'Validation must not publish or run other platforms' unless jobs.keys.sort == %w[validate windows]
build = jobs.fetch('windows')
raise 'Source validation must gate builds' unless build.fetch('needs') == 'validate'
raise 'Reuse Windows packaging' unless build.fetch('uses') == './.github/workflows/bundle-windows.yml'
raise 'OIDC signing permission required' unless build.fetch('permissions') == { 'contents' => 'read', 'id-token' => 'write' }
raise 'Signed staging only' unless build.fetch('with') == {
  'version' => '${{ inputs.version }}', 'source_sha' => '${{ inputs.source_sha }}',
  'channel' => 'staging', 'signing' => true
}
raise 'Signing credentials must be inherited' unless build.fetch('secrets') == 'inherit'

steps = jobs.fetch('validate').fetch('steps')
identity_check = steps.find { |step| step['name'] == 'Validate build identity' }.fetch('run')
raise 'Main-only guard missing' unless identity_check.include?('test "$GITHUB_REF" = refs/heads/main')
raise 'Shared input validation missing' unless identity_check.include?('validateIdentity({')
source_checkout = steps.find { |step| step.dig('with', 'repository') == 'gavin-k/shhield-ai' }.fetch('with')
raise 'Source must be pinned with full history' unless source_checkout['ref'] == '${{ inputs.source_sha }}' &&
  source_checkout['fetch-depth'] == 0 && source_checkout['persist-credentials'] == false
source_check = steps.last.fetch('run')
raise 'Exact source check missing' unless source_check.include?('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"')
raise 'Reviewed source ancestry check missing' unless source_check.include?('git merge-base --is-ancestor "$SOURCE_SHA" origin/main')

packaging = YAML.safe_load_file(File.expand_path('../.github/workflows/bundle-windows.yml', __dir__))
job = packaging.fetch('jobs').fetch('package-windows')
raise 'OIDC environment changed' unless job.fetch('environment') == "${{ inputs.signing && 'signing' || '' }}"
raise 'Signature verification missing' unless job.fetch('steps').any? { |step| step['name'] == 'Verify signatures' && step.fetch('run').include?('Get-AuthenticodeSignature') }
raise 'Portable packaging is no longer supported' if job.fetch('steps').any? { |step| step['name']&.match?(/Portable/i) }

puts 'Windows-only signed staging, source guards, OIDC and MSI-only packaging verified'
