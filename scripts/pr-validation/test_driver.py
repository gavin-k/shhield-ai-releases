import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
WORKFLOW = ROOT.parents[1] / '.github/workflows/validate-pr.yml'


class DriverTests(unittest.TestCase):
    def test_shell_syntax(self):
        for script in ROOT.glob('*.sh'):
            subprocess.run(['bash', '-n', str(script)], check=True)

    def test_sanitizer_preserves_source_and_locks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            files = ['Cargo.toml', 'Cargo.lock', 'ui/pnpm-lock.yaml',
                     'crates/demo/src/lib.rs', 'ui/desktop/src/main.ts',
                     '.cargo/config.toml', 'nested/.cargo/config',
                     'ui/.npmrc', 'ui/.pnpmfile.cjs']
            for name in files:
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('sentinel')
            subprocess.run(['python3', str(ROOT / 'sanitize-config.py'), directory], check=True)
            for name in files[:5]:
                self.assertEqual((root / name).read_text(), 'sentinel')
            for name in files[5:]:
                self.assertFalse((root / name).exists())

    def test_sanitizer_rejects_git_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            (pathlib.Path(directory) / '.git').mkdir()
            result = subprocess.run(['python3', str(ROOT / 'sanitize-config.py'), directory],
                                    capture_output=True)
            self.assertNotEqual(result.returncode, 0)

    def test_workflow_is_manual_and_scoped(self):
        text = WORKFLOW.read_text()
        self.assertIn('workflow_dispatch:', text)
        self.assertNotIn('pull_request:', text)
        self.assertNotIn('push:', text)
        self.assertNotIn('secrets: inherit', text)
        self.assertNotIn('contents: write', text)
        self.assertNotIn('environment:', text)
        self.assertEqual(text.count('secrets.'), 1)
        self.assertIn('secrets.SOURCE_DEPLOY_KEY', text)
        self.assertIn('git@github.com:gavin-k/shhield-ai.git', (ROOT / 'export-source.sh').read_text())
        self.assertIn('refs/heads/main', text)
        self.assertIn('^[a-f0-9]{40}$', text)
        self.assertNotIn('merge-base', text)
        self.assertNotIn('upload-artifact', text)
        self.assertNotIn('actions/cache', text)

    def test_container_boundary_and_suppressed_output(self):
        text = (ROOT / 'run.sh').read_text()
        for boundary in ['network=none', '--network "$network"', '--user 1000:1000',
                         '--cap-drop ALL', '--security-opt no-new-privileges',
                         '--read-only', 'dst=/validation,readonly',
                         '>"$state/$mode.log" 2>&1']:
            self.assertIn(boundary, text)
        self.assertNotIn('--privileged', text)
        self.assertNotIn('docker.sock', text)
        self.assertNotIn('--env-file', text)
        self.assertNotIn('cat "$state', text)

    def test_driver_dynamic_network_and_log_boundary(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            state = root / 'pr-validation'
            (state / 'source').mkdir(parents=True)
            (state / 'home').mkdir()
            tools = root / 'tools'
            tools.mkdir()
            docker = tools / 'docker'
            docker.write_text('#!/bin/sh\nprintf "%s\\n" "$@" > "$TRACE_FILE"\nprintf "PRIVATE_SOURCE ::error::must-not-leak\\n"\nexit "${STUB_EXIT:-0}"\n')
            docker.chmod(0o755)
            sudo = tools / 'sudo'
            sudo.write_text('#!/bin/sh\nexit 0\n')
            sudo.chmod(0o755)
            env = dict(os.environ, RUNNER_TEMP=str(root), TRACE_FILE=str(root / 'trace'),
                       PATH=str(tools) + os.pathsep + os.environ['PATH'])
            for mode, network in [('dependencies', 'bridge'), ('rust', 'none'), ('ui', 'none'), ('ui-sdk', 'none'), ('ui-typecheck', 'none'), ('ui-i18n', 'none'), ('ui-renderer', 'none'), ('ui-tests', 'none')]:
                result = subprocess.run(['bash', str(ROOT / 'run.sh'), mode], env=env,
                                        text=True, capture_output=True)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertNotIn('PRIVATE_SOURCE', result.stdout + result.stderr)
                arguments = (root / 'trace').read_text().splitlines()
                self.assertEqual(arguments[arguments.index('--network') + 1], network)
                self.assertNotIn('--env', arguments)
                self.assertNotIn('-e', arguments)
                self.assertIn('PRIVATE_SOURCE', (state / f'{mode}.log').read_text())
            result = subprocess.run(['bash', str(ROOT / 'run.sh'), 'rust'],
                                    env=dict(env, STUB_EXIT='1'), text=True, capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn('PRIVATE_SOURCE', result.stdout + result.stderr)

    def test_host_preparation_diagnostics_are_private(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            state = root / 'pr-validation'
            (state / 'source').mkdir(parents=True)
            (state / 'home').mkdir()
            tools = root / 'tools'
            tools.mkdir()
            python = tools / 'python3'
            python.write_text('#!/bin/sh\necho "PRIVATE_PATH ::error::must-not-leak" >&2\nexit 1\n')
            python.chmod(0o755)
            env = dict(os.environ, RUNNER_TEMP=str(root),
                       PATH=str(tools) + os.pathsep + os.environ['PATH'])
            result = subprocess.run(['bash', str(ROOT / 'run.sh'), 'dependencies'],
                                    env=env, text=True, capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn('PRIVATE_PATH', result.stdout + result.stderr)
            self.assertIn('PRIVATE_PATH', (state / 'prepare.log').read_text())
        workflow = WORKFLOW.read_text()
        self.assertIn('>"$RUNNER_TEMP/pr-validation/export.log" 2>&1', workflow)
        self.assertIn('pr-validation" >/dev/null 2>&1', workflow)

    def test_export_exact_sha_without_credentials_and_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            repo = root / 'repository'
            repo.mkdir()
            git = shutil.which('git')
            subprocess.run([git, 'init', '-q', str(repo)], check=True)
            (repo / 'private.txt').write_text('private fixture')
            subprocess.run([git, '-C', str(repo), 'add', '.'], check=True)
            subprocess.run([git, '-C', str(repo), '-c', 'user.name=Fixture',
                            '-c', 'user.email=fixture@example.invalid', 'commit', '-qm',
                            'private subject must not be public'], check=True)
            sha = subprocess.check_output([git, '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
            state = root / 'pr-validation'
            state.mkdir()
            tools = root / 'tools'
            tools.mkdir()
            wrapper = tools / 'git'
            wrapper.write_text('#!/usr/bin/env python3\nimport os,subprocess,sys\n'
                               'assert "SOURCE_DEPLOY_KEY" not in os.environ\n'
                               'args=sys.argv[1:]\n'
                               'if "fetch" in args and os.environ.get("FAIL_FETCH"): sys.exit(9)\n'
                               'args=[os.environ["LOCAL_REPOSITORY"] if a=="git@github.com:gavin-k/shhield-ai.git" else a for a in args]\n'
                               'sys.exit(subprocess.call([os.environ["REAL_GIT"],*args]))\n')
            wrapper.chmod(0o755)
            env = dict(os.environ, RUNNER_TEMP=str(root), SOURCE_SHA=sha,
                       SOURCE_DEPLOY_KEY='fixture-only-not-a-key', REAL_GIT=git,
                       LOCAL_REPOSITORY=str(repo), PATH=str(tools)+os.pathsep+os.environ['PATH'])
            result = subprocess.run(['bash', str(ROOT / 'export-source.sh')], env=env,
                                    text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual((state / 'source/private.txt').read_text(), 'private fixture')
            self.assertFalse((state / 'source/.git').exists())
            self.assertEqual(list(state.glob('auth.*')), [])
            result = subprocess.run(['bash', str(ROOT / 'export-source.sh')],
                                    env=dict(env, FAIL_FETCH='1'), capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(list(state.glob('auth.*')), [])
            result = subprocess.run(['bash', str(ROOT / 'export-source.sh')],
                                    env=dict(env, SOURCE_SHA='main; exit 0'), capture_output=True)
            self.assertNotEqual(result.returncode, 0)

    def test_scope_and_stages_are_fixed(self):
        workflow = WORKFLOW.read_text()
        self.assertIn("if: inputs.validation_scope == 'all'", workflow)
        self.assertIn('case "$VALIDATION_SCOPE" in all|ui)', workflow)
        self.assertIn('Rust was NOT run in this UI-only run', workflow)
        for stage in ['sdk', 'typecheck', 'i18n', 'renderer', 'tests']:
            self.assertIn('run.sh ui-' + stage, workflow)
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(['bash', str(ROOT / 'run.sh'), 'ui-../../escape'],
                                    env=dict(os.environ, RUNNER_TEMP=directory), capture_output=True)
            self.assertEqual(result.returncode, 2)
        ui = (ROOT / 'ui.sh').read_text()
        self.assertIn('case "$stage" in all|sdk|typecheck|i18n|renderer|tests)', ui)

    def test_dependencies_cannot_build(self):
        text = (ROOT / 'dependencies.sh').read_text()
        self.assertIn('fetch --locked', text)
        for flag in ['--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile',
                     '--config.manage-package-manager-versions=false']:
            self.assertIn(flag, text)
        self.assertNotIn('pnpm run', text)
        self.assertNotIn('cargo build', text)

    def test_mock_build_scope(self):
        rust = (ROOT / 'rust.sh').read_text()
        ui = (ROOT / 'ui.sh').read_text()
        self.assertIn('--no-default-features', rust)
        self.assertIn('--locked --offline', rust)
        self.assertNotIn('--ignored', rust)
        self.assertNotIn('--all-features', rust)
        self.assertIn('pnpm run typecheck', ui)
        self.assertIn('pnpm exec vite build', ui)
        self.assertIn('pnpm exec vitest run', ui)
        self.assertNotIn('pnpm run test:integration', ui)
        self.assertNotIn('pnpm run make', ui)


if __name__ == '__main__':
    unittest.main()
