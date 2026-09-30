#!/usr/bin/env bash
set -euo pipefail
export npm_config_offline=true
cd ui/desktop
stage=${1:-all}
case "$stage" in all|sdk|typecheck|i18n|renderer|tests) ;; *) exit 2 ;; esac
if [[ $stage == all || $stage == sdk ]]; then pnpm run build-shhield-acp-client; fi
if [[ $stage == all || $stage == typecheck ]]; then pnpm run typecheck; fi
if [[ $stage == all || $stage == i18n ]]; then pnpm run i18n:compile; fi
if [[ $stage == all || $stage == renderer ]]; then
  pnpm exec vite build --config vite.renderer.config.mts
fi
# Existing mocks only; no integration or application launch.
if [[ $stage == all || $stage == tests ]]; then
pnpm exec vitest run \
  src/components/privacy/PrivacyExchangePanel.test.tsx \
  src/components/privacy/PrivacyInputGuard.test.tsx \
  src/components/settings/privacy/OutboundInspector.test.tsx \
  src/components/settings/privacy/PrivacySettingsSection.acp.test.tsx \
  src/components/settings/privacy/PrivacySettingsSection.test.tsx \
  src/components/settings/app/AppSettingsSection.test.tsx \
  src/components/settings/about/AboutSettingsSection.test.tsx \
  src/components/ToolApprovalButtons.acp.test.tsx \
  src/components/ElicitationRequest.test.tsx \
  src/components/settings/providers/modal/ProviderConfigurationModal.flow.test.tsx \
  src/components/ChatInput.test.tsx \
  src/components/MessageQueue.stale-edit.test.tsx \
  src/hooks/useAutoSubmit.test.tsx
fi
