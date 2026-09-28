require 'yaml'

workflow = YAML.safe_load_file(File.expand_path('../.github/workflows/validate-macos.yml', __dir__))
raise 'Manual dispatch only' unless workflow.fetch('on').keys == ['workflow_dispatch']
raise 'Read-only token required' unless workflow.fetch('permissions') == { 'contents' => 'read' }
jobs = workflow.fetch('jobs')
raise 'Validation must not publish or run other platforms' unless jobs.keys.sort == %w[macos validate]

build = jobs.fetch('macos')
raise 'Source validation must gate builds' unless build.fetch('needs') == 'validate'
raise 'Reuse the signed packaging workflow' unless build.fetch('uses') == './.github/workflows/bundle-macos.yml'
raise 'Both architectures must run independently' unless build.fetch('strategy') == {
  'fail-fast' => false, 'matrix' => { 'target' => %w[aarch64-apple-darwin x86_64-apple-darwin] }
}
raise 'Staging signing inputs changed' unless build.fetch('with') == {
  'version' => '${{ inputs.version }}', 'source_sha' => '${{ inputs.source_sha }}',
  'target' => '${{ matrix.target }}', 'channel' => 'staging',
  'signing' => true, 'package_desktop' => true, 'environment' => 'signing'
}

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

puts 'macOS-only staging workflow, signing and source guards verified'
