#!/usr/bin/env bash
set -euo pipefail
# cargo fetch resolves/downloads only; no compilation, build.rs or tests.
cargo +1.96.1 fetch --locked --target x86_64-unknown-linux-gnu
cd ui
# No package scripts, project pnpmfile hooks, automatic pnpm version switch,
# Electron download or source build is permitted while network is enabled.
pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile \
  --config.manage-package-manager-versions=false --config.package-manager-strict=false
