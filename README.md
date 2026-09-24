# Shhield AI releases

This public repository builds and publishes Shhield AI packages from the private `gavin-k/shhield-ai` source repository. The source checkout is pinned to a commit SHA. Signed releases also require a matching `vX.Y.Z` source tag. Public Actions logs and build artifacts may contain details from the private source.

## Configuration

- `SOURCE_DEPLOY_KEY` is configured as a **read-only** deploy key for `gavin-k/shhield-ai`. Keep it read-only and rotate it if the GitHub CLI authorization that created it is revoked.
- rbt3 downloads on demand from the pinned [Hugging Face revision](https://huggingface.co/lijy0717/shhield-rbt3-chinese-base/tree/4deb16d5c5fc74e046e9257cb2bf86ccd50cb8d4). The source manifest verifies file sizes and SHA-256 hashes; installers do not bundle its weights.
- The `signing` Environment requires a reviewer and a protected release-repository branch. Add the Apple and Azure signing secrets used by `bundle-macos.yml` and `bundle-windows.yml` to that environment.
- Update the Azure federated credential to accept this repository's OIDC subject for the `signing` environment. The subject changes from the private source repository.
- Set `ENABLE_MAC_NATIVE_AUTO_UPDATE=true` only after the manifest consumer and asset URLs point to this release repository. The initial release can leave it unset.

Run `Release` manually with a package version and exact source commit SHA. `platform=all` with `signing=false` publishes an unsigned prerelease under `preview-vX.Y.Z-<source SHA>`; it does not update `stable`. `platform=all` with `signing=true` requires a matching source tag and publishes versioned and `stable` releases. The four Desktop variants are macOS arm64, macOS x64, Windows x64 MSI, and Linux x64. Linux provides `.deb`, `.rpm`, and `.flatpak` for that one variant. Workflow artifacts expire after one day; published Release assets remain available separately.

The source repository's existing release workflow remains the active fallback until the hosted Windows MSI smoke, macOS signing/notarization, artifact hashes and architecture, and Desktop activation are checked from a run here. After that run, disable its duplicate release trigger and point download/update URLs to this repository.

The model URL is configured, but Apple/Azure signing secrets are not. No signed product build has run in this repository yet. The source repository is private on a plan where GitHub rejected branch/ruleset protection, so a release reviewer must verify its tag and commit before signing. GitHub-hosted Windows has a 14 GB SSD and a six-hour job limit; the first real build must check disk use and completion time.

Windows currently builds without `code-mode` because the combined V8 and llama.cpp native libraries produce duplicate C++ exception symbols on MSVC. Keep this limitation in preview release notes until an upstream fix is verified.
