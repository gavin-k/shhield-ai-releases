#!/usr/bin/env bash
set -euo pipefail
export npm_config_offline=true
cd ui/desktop
pnpm run build-shhield-acp-client
pnpm run typecheck
pnpm run i18n:compile
pnpm exec vite build --config vite.renderer.config.mts
# Explicit existing mock suite only. Never run provider integration, Playwright,
# self-test recipes, the packaged application, or model checkpoint tests.
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
