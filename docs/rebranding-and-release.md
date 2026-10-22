# OnlySkinz Rebranding, Identity, and Local Release Build

Session date: 2026-09-21

The upstream project (Zushi) was repackaged into its own product, **OnlySkinz**.
This is a *fresh product*, not a fork with a migration path: no compatibility
shims were added for the old identity, so storage keys, data directories, and
bundle metadata were renamed freely.

## Identity

| Field | Value |
|-------|-------|
| Product name | `OnlySkinz` |
| Bundle identifier | `com.onlyleague.onlyskinz` |
| Executable | `onlyskinz` |
| Rust lib crate | `onlyskinz_lib` |
| Version | `0.1.12` |
| Repo | `github.com/onlyleague/onlyskinz` |

Declared in `src-tauri/tauri.conf.json` (`productName`, `identifier`, `version`)
and mirrored in `src-tauri/Info.plist` (`CFBundleIdentifier`, `CFBundleName`,
`CFBundleDisplayName`, `CFBundleExecutable`, `CFBundleShortVersionString`,
`CFBundleVersion`).

### Why the identifier change also relocates data

Tauri's `app_data_dir()` derives its path from the bundle identifier. Renaming
the identifier from `com.zushi.app` to `com.onlyleague.onlyskinz` therefore
moved the app's data directory with no code change:

```text
~/Library/Application Support/com.onlyleague.onlyskinz/{skins,customs}
~/Library/WebKit/com.onlyleague.onlyskinz
```

The old `~/Library/Application Support/com.zushi.app` directory is stale and can
be deleted.

### localStorage keys

Renamed to the `onlyskinz_` prefix:

| Key | Used in |
|-----|---------|
| `onlyskinz_skin_selection` | `src/App.tsx`, `src/components/Settings.tsx` |
| `onlyskinz_god_mode` | `src/App.tsx` |
| `onlyskinz_god_last_skin` | `src/App.tsx` |
| `onlyskinz_customs_enabled` | `src/hooks/useCustoms.ts`, `src/components/Settings.tsx` |

Because this is a fresh product, existing users' `zushi_*` keys are intentionally
not migrated.

## Rebase marker rename is behavior-neutral

`mod-tools/main.cpp` looks for a `"ZushiRebased": true` marker when deciding
whether a mod needs rebasing. That string was renamed to
`"OnlySkinzRebased": true`.

This is safe because the marker has **no write site** — neither in this repo nor
in the upstream project. `is_rebased_mod()` is only called from `mod_import`,
and the `info.json` written there never contains a `Rebased` key. The lookup
always returns false, before and after the rename. There is nothing to migrate.

## Files touched

- `src-tauri/tauri.conf.json`, `src-tauri/Info.plist`, `src-tauri/Cargo.toml`,
  `src-tauri/src/main.rs`, `src-tauri/src/lib.rs`,
  `src-tauri/capabilities/default.json`
- `src/App.tsx`, `src/components/{Settings,GamePathSelector}.tsx`,
  `src/hooks/{useChampions,useCustoms,useGamePath,useSkinData,useVersionCheck}.ts`
- `mod-tools/main.cpp`, `mod-tools/lib/patcher/patcher.hpp`,
  `mod-tools/lib/patcher/utility/process_macos.cpp`
- `.github/workflows/release.yaml`, `README.md`, `index.html`, `package.json`
- Icon assets regenerated: `icon.png`, `preview.png`, `src/assets/icon.png`,
  `src-tauri/icons/*` (including `icon.icns` and `icon.ico`)

Verification that the rename is complete:

```bash
git grep -i zushi    # tracked files: no matches
```

## Version discrepancy — resolved

A previously tracked bug had the built bundle report `0.1.2` while
`tauri.conf.json` declared `0.1.12`. Root cause: `src-tauri/Info.plist` is a
static file that Tauri merges into the bundle, and it still hardcoded `0.1.2`.
`tauri.conf.json`'s `version` does not override the explicit plist values.

Fixed by editing `src-tauri/Info.plist` to `0.1.12` for both `CFBundleVersion`
and `CFBundleShortVersionString`. The built bundle now reports `0.1.12`.

## Local release build

```bash
export PATH="$HOME/.cargo/bin:$PATH"
npm run tauri -- build --bundles app
```

Produces:

```text
src-tauri/target/release/bundle/macos/OnlySkinz.app
```

~18 MB. `externalBin: ["binaries/mod-tools"]` bundles the sidecar to
`Contents/MacOS/mod-tools` (1.3 MB).

### Signing and launching locally

The Tauri-produced bundle is not signed. Ad-hoc sign it, then clear quarantine:

```bash
codesign --force --deep --sign - src-tauri/target/release/bundle/macos/OnlySkinz.app
xattr -cr src-tauri/target/release/bundle/macos/OnlySkinz.app
codesign --verify --verbose=1 src-tauri/target/release/bundle/macos/OnlySkinz.app
```

### Admin relaunch is expected

`lib.rs` checks `geteuid()` at startup and relaunches itself as root through
macOS Authorization Services (falling back to `osascript`) because mod-tools
needs `task_for_pid`. A healthy launch therefore shows **two** processes:

```text
onlyskinz   (user)  — original process, waits for the root process
onlyskinz   (root)  — the real app
```

The launcher process exiting immediately means the authorization prompt was
cancelled, not that the app crashed.

### Known cosmetic issue

The bundled `mod-tools` binary still embeds the build-time source path
`/Volumes/MyPassport/Downloads/zushi-main/mod-tools/main.cpp` in its debug
line-table strings. That is the checkout folder name leaking through the
compiler, not product branding; the main `onlyskinz` binary contains no `zushi`
strings. Renaming the checkout directory removes it.

## Open issue: license inconsistency

`src-tauri/Cargo.toml` declares `license = "GPL-3.0"`, but the top-level
`LICENSE` file and the README badge both say MIT. This is a real contradiction
that should be settled before shipping: `mod-tools` descends from cslol-manager,
which is GPL-3.0, so the bundled-binary licensing likely forces GPL-3.0 for the
distribution as a whole.

## Deferred feature work

Two requested features were **not** implemented in this session:

1. **Stop / resume batch downloads.** Add a cancel control to the "Download All
   Skins" batch operation, and make a restart pick up where it left off.
   Resume already half-works: `handleDownloadAll` in `src/App.tsx` filters items
   with `!dl.isDownloaded(...)`, and `isDownloaded` is disk-backed via
   `listDownloadedSkins()`, so completed skins are naturally skipped. Cancellation
   needs new plumbing: a flag in `AppState` (`src-tauri/src/state.rs`), a check at
   the top of the loop in `download_multiple_skins`
   (`src-tauri/src/commands/skins.rs`), a new `cancel_download` command registered
   in `src-tauri/src/lib.rs`, a wrapper in `src/lib/commands.ts`, and a Stop button
   in `src/components/DownloadBar.tsx` (which already parses `"Skin (3/10)"`
   progress).
2. **GOD mode auto-download.** When GOD mode picks a skin for the champ-select
   champion that is not on disk yet, download it immediately so it can be applied
   in the same game. Today `handleApply` in `src/App.tsx` filters
   `dl.downloads` and, finding nothing, shows a toast instead.
