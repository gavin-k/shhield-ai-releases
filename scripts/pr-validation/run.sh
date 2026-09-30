#!/usr/bin/env bash
set -euo pipefail
mode=${1:?Expected image, dependencies, rust or ui}
case "$mode" in image|dependencies|rust|ui) ;; *) exit 2 ;; esac
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
state=${RUNNER_TEMP:?Set RUNNER_TEMP}/pr-validation
image=shhield-pr-validation:local
mkdir -p "$state"
# Source/build output must never reach public Actions logs, including workflow commands.
if [[ $mode == image ]]; then
  if ! docker build --pull -t "$image" "$root" >"$state/image.log" 2>&1; then
    echo 'Validation tool image failed; reproduce privately for diagnostics.' >&2
    exit 1
  fi
  echo 'Validation tool image ready.'
  exit 0
fi
test -d "$state/source"
test ! -e "$state/source/.git"
if [[ $mode == dependencies ]]; then
  # Do not let repository Cargo/npm configuration install executable credential
  # helpers or package-manager hooks during the only network-enabled phase.
  if ! {
    python3 "$root/sanitize-config.py" "$state/source" &&
    sudo chown -R 1000:1000 "$state/source" "$state/home"
  } >"$state/prepare.log" 2>&1; then
    echo 'Dependency preparation failed; private diagnostics were not published.' >&2
    exit 1
  fi
fi
network=none
if [[ $mode == dependencies ]]; then network=bridge; fi
if ! docker run --rm --init --network "$network" \
  --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=2g \
  --mount "type=bind,src=$state/source,dst=/work" \
  --mount "type=bind,src=$state/home,dst=/home/node" \
  --mount "type=bind,src=$root,dst=/validation,readonly" \
  --workdir /work \
  "$image" bash "/validation/$mode.sh" >"$state/$mode.log" 2>&1; then
  echo "$mode failed; private diagnostics were not published." >&2
  exit 1
fi
echo "$mode passed."
