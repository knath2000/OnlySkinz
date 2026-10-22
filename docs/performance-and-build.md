# OnlySkinz Performance Optimizations and Build Notes

Session date: 2026-09-18

Six data-volume hotspots were removed with **zero behavior change**. The UI, the
commands it calls, and the on-disk layout are identical before and after — only
the amount of work per render/action changed.

## Summary

| # | Hotspot | Fix | Location |
|---|---------|-----|----------|
| 1 | `isDownloaded` scanned the whole download list per card | O(1) `Set` of `champion/skin` keys, memoized on `downloads` | `src/hooks/useDownloads.ts:47` |
| 2 | `findChampionByName` did a linear scan of ~170 champions per lookup | `Map<string, Champion>` index built once | `src/hooks/useChampions.ts:18` |
| 3 | `ChampionDetail` recomputed per-skin download state every render | Memoized `Map<string, SkinState>` | `src/components/ChampionDetail.tsx:171` |
| 4 | `MySkins` mounted thousands of rows at once | CSS `content-visibility: auto` on rows | `src/components/MySkins.tsx:247`, `src/App.css:79` |
| 5 | Every download action re-walked the entire skins tree for a size total | Size captured during the list call; frontend sums it | `src-tauri/src/state.rs:43`, `src-tauri/src/commands/skins.rs:185` |
| 6 | `getSkinsForChampion` scanned all ~9k `skin_ids` entries per champion | Per-champion bucket index | `src/hooks/useSkinData.ts:27` |

## Details

### 1. O(1) download lookup

`useDownloads` builds a `Set` of `` `${champion_name}/${skin_name}` `` keys once per
`downloads` change. `isDownloaded` is a `Set.has` call instead of a `Array.some`
scan. `ChampionDetail` calls this for every skin *and* every chroma, so the old
version was O(cards x downloads) per render.

### 2. O(1) champion lookup

`useChampions` lazily builds `championsByName: Map<string, Champion>` from the
champion cache. `findChampionByName` becomes a single `Map.get`.

### 3. Memoized `ChampionDetail` skin state

The component builds a `Map<string, SkinState>` in `useMemo`, keyed on the inputs
that can change it. Previously the state for each card was derived inline on every
render, which re-ran the download lookup and chroma logic for the full grid.

### 4. Off-screen row skipping in `MySkins`

Rows are **variable height** (skin cards `flex-wrap` inside a fixed-width
thumbnail column), so a JS windowing library would need scroll math and would
introduce scrollbar jitter. `content-visibility: auto` plus
`contain-intrinsic-size: auto 132px` gets the same off-screen layout/paint skip
with no dependency:

```css
.cv-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 132px;
}
```

The `auto` keyword tells the browser to reuse the last-rendered size for rows it
has already measured, so the scrollbar stays stable.

### 5. Skin size without a second tree walk

`list_downloaded_skins` already stats each zip to check it exists. That same
`fs::metadata` call now captures the length:

```rust
if let Ok(meta) = fs::metadata(&zip_path) {
    if meta.is_file() {
        skins.push(DownloadedSkin {
            champion_name: champion_name.clone(),
            skin_name: decode_path(&skin_dir_name),
            zip_path: zip_path.to_string_lossy().into_owned(),
            size: meta.len(),
        });
    }
}
```

`DownloadedSkin` gained `size: u64` (Rust) / `size: number` (TS). The frontend
totals from the returned list instead of calling `get_skins_dir_size`, which
recursively walked the whole tree. `getSkinsDirSize` is still exposed and is
still used by `Settings.tsx`.

### 6. Per-champion skin index

`ensureSkinIndexes()` now also fills `skinsByChampKey: Map<number, [id, name][]>`,
bucketed by `Math.floor(parseInt(id, 10) / 1000)`. `getSkinsForChampion` reads its
bucket instead of filtering all ~9k entries. This matters for
`handleDownloadAll` in `App.tsx`, which walks every champion in a single click.

The bucket is only trusted when the caller passed the same `skinIds` object the
index was built from (`indexedFrom === skinIds`); otherwise it falls back to the
full scan, so callers with a different object still get correct results.

## Verification

Both toolchains were green after the changes:

```bash
npm run build     # tsc && vite build — passes, noUnusedLocals is enabled
cargo check       # passes (~45s); needs export PATH="$HOME/.cargo/bin:$PATH"
```

`.cv-row` was confirmed present in the built CSS output.

## Build notes

```bash
npm run tauri -- build --bundles app
```

produces the macOS app bundle at:

```text
src-tauri/target/release/bundle/macos/OnlySkinz.app
```

The bundle is ~18 MB with the `mod-tools` sidecar bundled.

### Version discrepancy (resolved 2026-09-21)

`src-tauri/tauri.conf.json` declared `version: "0.1.12"` while the built
`OnlySkinz.app/Contents/Info.plist` reported `0.1.2`. Root cause: `Info.plist` is
a static file Tauri merges into the bundle, and `tauri.conf.json`'s `version`
does not override the explicit `CFBundleVersion` / `CFBundleShortVersionString`
values already in it. Fixed by updating `src-tauri/Info.plist` to `0.1.12`.
See `docs/rebranding-and-release.md`.

### Gatekeeper

Builds are unsigned. Ad-hoc sign and clear quarantine before launching:

```bash
codesign --force --deep --sign - src-tauri/target/release/bundle/macos/OnlySkinz.app
xattr -cr src-tauri/target/release/bundle/macos/OnlySkinz.app
```

On another machine, also clear the quarantine attribute:

```bash
xattr -dr com.apple.quarantine /path/to/OnlySkinz.app
```
