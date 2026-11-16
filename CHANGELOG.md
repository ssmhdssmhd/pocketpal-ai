# Changelog

## MXPocketPal.Al.1.23.3 202611170449

- Accelerated public Hugging Face model-file downloads with `hf-mirror.com` and added a one-time automatic fallback to the official source.
- Kept authenticated downloads on `huggingface.co`, prevented HF tokens from reaching the mirror, preserved custom URLs, and reset partial data when changing sources.
- Fixed cancellation and duplicate-event races, kept iOS observable progress in sync, and filtered stale Android events by source URL when native download IDs are reused.
- Added Android and iOS regression coverage for mirror selection, fallback failures, cancellation, authorization boundaries, observable progress, and reused download IDs; CI now runs the native download controller tests.
- Bumped the app version to `1.23.3`, Android `versionCode` to `163`, and the corresponding iOS build version.

## MXPocketPal.Al.1.23.2 202611170309

- Renamed the Android APK artifact to `MXPocketPal.Al.apk` for workflow artifacts and GitHub Releases.
- Reused the established fixed release signing identity and added a mandatory certificate SHA-256 comparison to prevent signing conflicts with the previous release.
- Bumped the app version to `1.23.2`, Android `versionCode` to `162`, and the corresponding iOS build version.

## PocketPal.AI.1.23.1 202611170120

- Removed the PocketPal Plus purchase requirement from **Settings → Local API server → Serve the loaded model**.
- Removed the Local API server entry from the paid Plus feature catalog; hands-free voice remains unchanged.
- Added regression tests proving that the server starts in a store-gated build without a Plus purchase.
- Added the manually dispatched **Android APK** GitHub Actions workflow with payload, store-gate, and signature verification.
- Added fixed release signing through GitHub Secrets; no keystore or signing password is committed.
- Added `PocketPal.AI.1.23.1.apk` and its SHA-256 checksum to workflow artifacts and GitHub Releases.
- Bumped the app version to `1.23.1` and Android `versionCode` to `161`.
