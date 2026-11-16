# Changelog

## PocketPal.AI.1.23.1 202611170120

- Removed the PocketPal Plus purchase requirement from **Settings → Local API server → Serve the loaded model**.
- Removed the Local API server entry from the paid Plus feature catalog; hands-free voice remains unchanged.
- Added regression tests proving that the server starts in a store-gated build without a Plus purchase.
- Added the manually dispatched **Android APK** GitHub Actions workflow with payload, store-gate, and signature verification.
- Added fixed release signing through GitHub Secrets; no keystore or signing password is committed.
- Added `PocketPal.AI.1.23.1.apk` and its SHA-256 checksum to workflow artifacts and GitHub Releases.
- Bumped the app version to `1.23.1` and Android `versionCode` to `161`.
