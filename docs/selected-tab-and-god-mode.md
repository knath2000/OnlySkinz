# OnlySkinz Selected Skins Tab and GOD Mode Chroma Fix

Session date: 2026-09-21

Two frontend-only features were implemented and a testable macOS `.app` bundle was
produced. No Tauri/Rust changes were required.

## 1. Dedicated "Selected" tab

### Problem

Selection lives in `App.tsx` as `skinSelection: Record<championName, skinName>`
(one skin per champion), persisted to `localStorage` under `onlyskinz_skin_selection`.
It was only editable from inside `MySkins` (re-click a card, or delete the file).
There was no single place to review the current loadout or deselect entries.

### Implementation

| Change | Location |
|--------|----------|
| `"selected"` added to the `View` union and `NAV_ITEMS` (icon `ListChecks`) | `src/App.tsx` |
| New `renderContent()` branch rendering `<SelectedSkins …/>` | `src/App.tsx` |
| New component listing the selection with per-entry deselect | `src/components/SelectedSkins.tsx` (new) |
| `SkinThumb` / `ChampAvatar` extracted for reuse | `src/components/SkinMedia.tsx` (new) |
| `MySkins` now imports the shared media components | `src/components/MySkins.tsx` |

`SelectedSkins` resolves each `[championName, skinName]` pair against
`downloads` so it can render the splash art and champion avatar. It provides:

- Per-entry **Deselect** button.
- **Clear all** button.
- Filter box matching champion or skin name.
- Chroma swatch/label via `lookupChromaInfo`.
- Graceful "Not downloaded — deselect or download it again" state when the
  selected entry is no longer present in `downloads`.

Deselect and Clear all are disabled while the patcher is active, consistent with
`MySkins`.

## 2. GOD mode: no same skin group back-to-back

### Problem

In GOD mode (`App.tsx` `handleApply`), the random draw recorded the **exact**
`skin_name` in `localStorage` (`onlyskinz_god_last_skin`) and excluded only that
exact name. A chroma of the same base skin is a distinct `skin_name`, so the same
skin could be reused across two games just with a different chroma.

This was confirmed against the live data. `lookupChromaInfo` resolves a chroma to
its parent via Community Dragon's `parentId`, and LeagueSkins names chromas as
`"<Base> (<Variant>)"`:

```text
266002 'Mecha Aatrox'              chroma? None
266004 'Mecha Aatrox (Obsidian)'   chroma? 266002
266005 'Mecha Aatrox (Pearl)'      chroma? 266002
266006 'Mecha Aatrox (Tanzanite)'  chroma? 266002
```

So after `Mecha Aatrox (Obsidian)`, the old code could still draw `Mecha Aatrox`,
`(Pearl)`, or `(Tanzanite)`.

### Fix

Added a group-key helper in `src/App.tsx`:

```ts
function skinGroupName(skinName: string): string {
  return lookupChromaInfo(skinName)?.parentName ?? skinName;
}
```

The GOD mode branch now:

1. Awaits `ensureSkinIds()` + `ensureChromaInfo()` so chroma resolution is
   guaranteed before grouping.
2. Normalizes the stored `lastRaw` name to a group key, so existing saved history
   keeps working with no migration.
3. Filters candidates whose `skinGroupName` matches the last group, then stores
   the picked skin's **group** name.

Implication: if a champion has only one skin group downloaded, repeats are still
unavoidable and the existing `pool.length > 0 ? pool : candidates` fallback
handles it.

## Verification

```bash
npx tsc --noEmit          # passes (noUnusedLocals enabled)
npm run build             # tsc && vite build — passes
npm run tauri build       # release build + bundles
```

The full Tauri build produced both artifacts:

```text
src-tauri/target/release/bundle/macos/OnlySkinz.app
src-tauri/target/release/bundle/dmg/OnlySkinz_0.1.12_x64.dmg
```

## Build notes (2026-09-21)

- Host: Intel x86_64. The release sidecar `mod-tools-x86_64-apple-darwin` was
  already present, so the build prerequisites were satisfied.
- Rust release compile took ~3 minutes.
- The bundle produced by `npm run tauri build` is **not signed at all** (unlike
  the note in the README that says ad-hoc). It was ad-hoc signed after bundling
  to avoid Gatekeeper friction:

  ```bash
  codesign --force --deep --sign - OnlySkinz.app
  xattr -cr OnlySkinz.app
  codesign --verify --verbose=2 OnlySkinz.app   # valid on disk / satisfies Designated Requirement
  ```

- The `.dmg` was generated *before* the ad-hoc signing, so it contains the
  unsigned copy. Re-sign and re-bundle if a signed DMG is needed.
- The version discrepancy noted in `docs/performance-and-build.md` still applies:
  `Info.plist` reports `0.1.2` while `tauri.conf.json` declares `0.1.12`.
