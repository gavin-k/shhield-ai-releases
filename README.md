# Shhield AI Releases

Official release repository for Shhield AI.

Download the latest version from [Releases](../../releases/latest).

## Release checklist

1. Run **Release** on `main` with a final version, exact reviewed source SHA and
   `windows_signing=signed`. Standalone validation runs do not replace a release candidate.
2. Publish the frozen staging candidate to the staging download service before
   accepting it. Verify its recorded `candidate.json` SHA-256, then run
   `CANDIDATE_SHA256=<recorded-digest> node scripts/verify-downloads.mjs <candidate-directory>`.
3. Complete installation, update, licensing and channel-isolation acceptance.
   Record the candidate digest and results when approving `staging-acceptance`.
4. Accept the resulting production candidate before approving `release`.
   Publication uploads original files; it does not rebuild them. The final check
   downloads both client update feeds and every candidate file and verifies their hashes.

Signing runs automatically. Both acceptance environments retain required reviewers,
main-only deployment rules and disabled administrator bypass. If publication or its
download check fails, rerun only the failed job; do not rebuild an accepted candidate.
Windows distribution is MSI-only. Checkout activation is a separate business decision.
