# OnlySkinz Multi-Skin Selection and Favorites

Session date: 2026-09-27

Two frontend-only features were implemented and a testable macOS `.app` bundle was
produced. No Tauri/Rust changes were required.

## 0. Background: why "one skin per champion" existed

The selection model was `skinSelection: Record<championName, skinName>` (one skin
per champion). The hard constraint is in the backend, not the UI: the overlay
builder merges every selected mod into a single WAD set, and two mods that patch
the same champion WAD entry with different checksums throw a conflict
(`mod-tools/lib/wad/mounted.cpp`, surfaced as "You can't apply two skins to the
same champion at once" in `src-tauri/src/commands/patcher.rs`).

So allowing multiple *selections* per champion requires Apply to reduce each
champion to a single skin at apply time. That was the core design decision.

## 1. Multi-skin selection

### Design decisions (confirmed with the user)

| Question | Choice |
|----------|--------|
| Apply while NOT in champ select, multiple selected | One random selected skin per champion |
| Random pick behavior in champ select | Avoid the last game's skin group (anti-repeat) |
| GOD mode vs the new random | GOD = random among ALL downloaded; GOD off = random among selected |
| Selectable combinations for one champion | Any combination (base + chromas together allowed) |

### Data model

`SkinSelection` is now `Record<string, string[]>` (champion -> selected skins),
defined in `src/types/index.ts`. Persistence is unchanged
(`localStorage["onlyskinz_skin_selection"]`), and old values auto-migrate:
`parseSelection` in `src/App.tsx` wraps a legacy `string` in a one-element array
and filters non-strings from arrays.

### UI changes

| Change | Location |
|--------|----------|
| Clicking a skin toggles it in/out of the champion's set (no longer replaces) | `src/components/MySkins.tsx` (`toggleSkin`) |
| Deleting a skin/group removes exactly those entries from the selection | `src/components/MySkins.tsx` (`deselectSkins`) |
| Base card shows selection check; chromas each keep their own ring + check | `src/components/MySkins.tsx` |
| Selected tab lists one row per selected skin (multiple rows per champion) | `src/components/SelectedSkins.tsx` |
| Header counts are totals across all champions | `src/App.tsx`, `MySkins`, `SelectedSkins` |

When a champion has both a base skin and chroma(s) selected, the base card shows
the selection check and suppresses the chroma swatch badge to avoid overlapping
badges (guarded by `!baseSelected`).

### Apply logic (`src/App.tsx` `handleApply`)

A shared helper performs the anti-repeat draw:

```ts
function pickWithAntiRepeat(championName, candidates: DownloadedSkin[]): DownloadedSkin
```

It reads/writes the existing `onlyskinz_god_last_skin` history (grouped via
`skinGroupName`), so GOD mode and the new random pick share one history and stay
compatible with existing installs. `ensureSkinIds()` + `ensureChromaInfo()` are
awaited at the top of `handleApply` so chromas resolve to their base group.

- **Not in champ select:** `applyAll` iterates every champion with a selection,
  filters to downloaded selected skins, and pushes exactly one anti-repeat pick
  per champion, plus `customs.enabledPaths`.
- **In champ select, GOD off:** draws a random anti-repeat pick among the locked
  champion's selected+downloaded skins. If the champion has selections but none
  are downloaded, it toasts and falls back to `applyAll`.
- **GOD mode:** unchanged — random among ALL downloaded skins for the champion.

## 2. Favorites

### Persistence

New `src/lib/favorites.ts`:

- Key format `favoriteKey(championName, skinName)` -> `"<champion>/<skin>"`.
  Champion names never contain `/`, so `parseFavoriteKey` splits on the first `/`.
- Stored as a JSON array in `localStorage["onlyskinz_favorites"]`; loaded into a
  `Set<string>` (`loadFavorites` / `saveFavorites`).

### UI

| Change | Location |
|--------|----------|
| New Favorites tab + nav entry (icon `Star`, between My Skins and Selected) | `src/App.tsx` |
| New component listing favorites with Select toggle, Unfavorite, and search | `src/components/Favorites.tsx` (new) |
| Base skin card: star button bottom-right (name text gets `pr-6` so it never collides) | `src/components/MySkins.tsx` |
| Chroma swatches: small star button under each swatch | `src/components/MySkins.tsx` |
| `favorites` state + `toggleFavorite` callback | `src/App.tsx` |

The Favorites tab resolves each key against `downloads` and `lookupChromaInfo`,
sorts by champion then skin, and disables Select when the skin is not downloaded
(showing "Not downloaded — download it again to apply").

### Behavior notes

- Favorites are independent of selection: starring does not select, and selecting
  does not star.
- Favorites are **not** pruned when a skin is deleted or all skins are cleared —
  they act as a wishlist and reappear once re-downloaded.
- The Favorites tab's Select toggle follows the multi-selection model (any
  combination per champion); the one-random-per-champion reduction still happens
  at apply time.

## 3. Verification

```bash
npx tsc --noEmit    # passes (noUnusedLocals enabled)
npm run build       # tsc && vite build — passes
```

Production bundle: `index-BKZx0ecA.js` (287.30 kB, gzip 84.18 kB).

## 4. Build (2026-09-27)

```bash
npm run tauri -- build --bundles app
codesign --force --deep --sign - src-tauri/target/release/bundle/macos/OnlySkinz.app
xattr -cr src-tauri/target/release/bundle/macos/OnlySkinz.app
```

Output: `src-tauri/target/release/bundle/macos/OnlySkinz.app` — 18 MB, version
0.1.12, x86_64, `mod-tools` sidecar at `Contents/MacOS/mod-tools`. Rust release
compile took ~3m12s. See `docs/overlay-injection-and-performance.md` for the
runtime behavior of the patcher.