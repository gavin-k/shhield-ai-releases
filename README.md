# Shhield AI Releases

Official release repository for Shhield AI.

Download the latest version from [Releases](../../releases/latest).

## Release checklist

1. Run **Release** on `main` with a final version, exact reviewed source SHA and
   `windows_signing=signed`. Standalone validation runs do not replace a release candidate.
2. Signed staging candidates automatically enter the testing download and update
   channels. The publisher verifies the original run, attestation and package hashes,
   then downloads the published files and feeds to verify their original bytes.
3. Complete installation, update, licensing and channel-isolation acceptance.
   Record the candidate digest and results when approving `staging-acceptance`.
4. Accept the resulting production candidate before approving `release`.
   Publication uploads original files; it does not rebuild them. The final check
   downloads both client update feeds and every candidate file and verifies their hashes.

Signing runs automatically. Both acceptance environments retain required reviewers,
main-only deployment rules and disabled administrator bypass. If publication or its
download check fails, rerun only the failed job; do not rebuild an accepted candidate.
For an existing candidate, run **Publish signed staging** on `main` with its original
Release run ID. This uses the same publisher and preserves the frozen packages.
Windows distribution is MSI-only. Checkout activation is a separate business decision.
