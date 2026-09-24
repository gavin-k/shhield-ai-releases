# Shhield AI releases

This public repository builds and publishes Shhield AI packages from the private `gavin-k/shhield-ai` source repository. The source checkout is pinned to a commit SHA and checked against a `vX.Y.Z` source tag before any build starts. Public Actions logs and build artifacts may contain details from the private source.

## Configuration

- Add a **read-only** deploy key to `gavin-k/shhield-ai` and store its private key as the `SOURCE_DEPLOY_KEY` Actions secret here. Do not grant write access.
- Store the controlled model directory URL as the `SHHIELD_RBT3_BUILD_BASE_URL` Actions secret here. The URL must serve `config.json`, `tokenizer.json`, and `model.safetensors` to hosted runners. Confirm the model license permits the public release assets.
- Create a `signing` Environment with required reviewers. Add the Apple and Azure signing secrets used by `bundle-macos.yml` and `bundle-windows.yml` to that environment. Allow signed jobs only from reviewed source tags.
- Update the Azure federated credential to accept this repository's OIDC subject for the `signing` environment. The subject changes from the private source repository.
- Set `ENABLE_MAC_NATIVE_AUTO_UPDATE=true` only after the manifest consumer and asset URLs point to this release repository. The initial release can leave it unset.

Run `Release` manually with a source version and the exact commit SHA for its tag. Use `platform=windows` or `platform=macos` and `signing=false` for an unsigned diagnostic build. Use `platform=all` and `signing=true` to publish a versioned and `stable` GitHub Release. Workflow artifacts expire after one day; published Release assets remain available separately.

The source repository's existing release workflow remains the active fallback until the hosted Windows MSI/Portable smoke, macOS signing/notarization, artifact hashes and architecture, and Desktop activation are checked from a run here. After that run, disable its duplicate release trigger and point download/update URLs to this repository.
