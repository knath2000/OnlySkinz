# OnlySkinz 0.1.13 Release Note

Session date: 2026-11-06

Version bump from `0.1.12` to `0.1.13`.

## What changed

This release is a version bump only — no behavior, UI, or backend changes. The
working tree was clean at the previous commit (`be7cc95`, "Fix false-positive map
WAD preflight for mod-supplied map WADs") before the bump.

## Files touched

`0.1.12` is declared in more than one place; all were updated so the built bundle
and the lockfiles agree:

| File | Field(s) |
|------|----------|
| `package.json` | `version` |
| `package-lock.json` | root `version` + `packages[""].version` |
| `src-tauri/tauri.conf.json` | `version` |
| `src-tauri/Cargo.toml` | `[package] version` |
| `src-tauri/Cargo.lock` | `onlyskinz` package `version` |
| `src-tauri/Info.plist` | `CFBundleVersion`, `CFBundleShortVersionString` |
| `README.md` | version badge |
| `docs/rebranding-and-release.md` | Identity table |

### Why `Info.plist` matters

`src-tauri/Info.plist` is a **static** file that Tauri merges into the bundle.
`tauri.conf.json`'s `version` does **not** override the explicit
`CFBundleVersion` / `CFBundleShortVersionString` values already present in it.
Missing this is exactly how the historical `0.1.2` vs `0.1.12` discrepancy
happened (see `docs/rebranding-and-release.md`, `docs/performance-and-build.md`).

## Build and verification

```bash
export PATH="$HOME/.cargo/bin:$PATH"
npm run tauri -- build --bundles app
```

Produces `src-tauri/target/release/bundle/macos/OnlySkinz.app`. The bundle is not
code-signed; ad-hoc sign and clear quarantine for local testing:

```bash
codesign --force --deep --sign - src-tauri/target/release/bundle/macos/OnlySkinz.app
xattr -cr src-tauri/target/release/bundle/macos/OnlySkinz.app
```

Confirm the built version:

```bash
/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" \
  src-tauri/target/release/bundle/macos/OnlySkinz.app/Contents/Info.plist
# -> 0.1.13
```

## CI note

`.github/workflows/release.yaml` runs on every push to `main` and publishes DMGs
for `aarch64-apple-darwin` and `x86_64-apple-darwin` via a GitHub Release, tagged
`v<version>-<run_number>`. Pushing this bump therefore also kicks off a 0.1.13
release build in CI.
