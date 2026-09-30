#!/usr/bin/env bash
set -euo pipefail
set +x
[[ ${SOURCE_SHA:-} =~ ^[a-f0-9]{40}$ ]]
test -n "${SOURCE_DEPLOY_KEY:-}"
state=${RUNNER_TEMP:?Set RUNNER_TEMP}/pr-validation
umask 077
auth=$(mktemp -d "$state/auth.XXXXXX")
trap 'rm -rf -- "$auth"' EXIT
printf '%s\n' "$SOURCE_DEPLOY_KEY" > "$auth/key"
unset SOURCE_DEPLOY_KEY
# Official GitHub Ed25519 host key, verified 2026-09-30:
# https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
printf '%s\n' 'github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl' > "$auth/known_hosts"
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0
export GIT_SSH_COMMAND="ssh -F /dev/null -i '$auth/key' -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile='$auth/known_hosts' -o GlobalKnownHostsFile=/dev/null -o HostKeyAlgorithms=ssh-ed25519"
git -c core.hooksPath=/dev/null init --bare "$auth/repository"
git -C "$auth/repository" -c core.hooksPath=/dev/null fetch --no-tags --depth=1 \
  git@github.com:gavin-k/shhield-ai.git "$SOURCE_SHA"
test "$(git -C "$auth/repository" rev-parse 'FETCH_HEAD^{commit}')" = "$SOURCE_SHA"
mkdir -p "$state/source" "$state/home"
git -C "$auth/repository" archive "$SOURCE_SHA" | tar -x -C "$state/source"
test ! -e "$state/source/.git"
