"""Remove executable downloader configuration, never source or lockfiles."""
import pathlib
import sys

root = pathlib.Path(sys.argv[1]).resolve(strict=True)
# A git archive cannot contain .git, but reject it rather than relying on that.
if (root / '.git').exists():
    raise SystemExit('Refusing checkout metadata')
for path in root.rglob('*'):
    if path.name in {'.npmrc', '.pnpmfile.cjs', '.pnpmfile.js'} or (
        path.parent.name == '.cargo' and path.name in {'config', 'config.toml'}
    ):
        if path.is_dir() and not path.is_symlink():
            raise SystemExit('Unexpected downloader configuration directory')
        path.unlink()
