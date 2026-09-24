# Shhield AI releases

This public repository builds and publishes Shhield AI packages from the private `gavin-k/shhield-ai` source repository. The source checkout is pinned to a commit SHA and checked against a `vX.Y.Z` source tag before any build starts. Public Actions logs and build artifacts may contain details from the private source.

## Configuration

- `SOURCE_DEPLOY_KEY` is configured as a **read-only** deploy key for `gavin-k/shhield-ai`. Keep it read-only and rotate it if the GitHub CLI authorization that created it is revoked.
- Store the controlled model directory URL as the `SHHIELD_RBT3_BUILD_BASE_URL` Actions secret here. The URL must serve `config.json`, `tokenizer.json`, and `model.safetensors` to hosted runners. Confirm the model license permits the public release assets.
- The `signing` Environment requires a reviewer and a protected release-repository branch. Add the Apple and Azure signing secrets used by `bundle-macos.yml` and `bundle-windows.yml` to that environment.
- Update the Azure federated credential to accept this repository's OIDC subject for the `signing` environment. The subject changes from the private source repository.
- Set `ENABLE_MAC_NATIVE_AUTO_UPDATE=true` only after the manifest consumer and asset URLs point to this release repository. The initial release can leave it unset.

Run `Release` manually with a source version and the exact commit SHA for its tag. Use `platform=windows` or `platform=macos` and `signing=false` for an unsigned diagnostic build. Use `platform=all` and `signing=true` to publish a versioned and `stable` GitHub Release. Workflow artifacts expire after one day; published Release assets remain available separately.

The source repository's existing release workflow remains the active fallback until the hosted Windows MSI/Portable smoke, macOS signing/notarization, artifact hashes and architecture, and Desktop activation are checked from a run here. After that run, disable its duplicate release trigger and point download/update URLs to this repository.

Current setup has no model URL or Apple/Azure signing secrets. No product build has run in this repository yet. The source repository is private on a plan where GitHub rejected branch/ruleset protection, so a release reviewer must verify its tag and commit before signing. GitHub-hosted Windows has a 14 GB SSD and a six-hour job limit; the first real build must check disk use and completion time.
