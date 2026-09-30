#!/usr/bin/env bash
set -euo pipefail
export CARGO_NET_OFFLINE=true
# Keep the complete source workspace and original Cargo.lock. This is a minimal
# Linux compile gate, not the default release/local-inference/code-mode profile.
cargo +1.96.1 build --locked --offline -p shhield-cli --bin shhield \
  --no-default-features --features rustls-tls,system-keyring
cargo +1.96.1 test --locked --offline -p shhield-privacy --no-default-features
cargo +1.96.1 clippy --locked --offline -p shhield-privacy --no-default-features \
  --all-targets -- -D warnings
