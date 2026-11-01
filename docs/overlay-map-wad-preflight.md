# Overlay Map-WAD Preflight Guard

## Symptom

Applying a skin fails before the patcher starts:

```text
Overlay contains unrelated map WADs; patcher was not started: [.../overlay/DATA/FINAL/Maps/Shipping/Common.wad.client]
```

The app never launches `runoverlay`, so no injection happens. The skin itself is fine;
the preflight guard is misfiring.

## Background

`mkoverlay` merges each mod's WAD entries into the base game WADs. While doing so it
propagates overlapping entries into other game WADs, which historically pulled huge
`Map11`/`Map12` WADs into a champion-only overlay (the Briar incident). Two defences
were added:

1. `mod-tools/main.cpp` erases overlay mounts whose relpath contains `/Maps/` and that
   are not present in the mod's own mounts. This removes overlap-only map WADs.
2. `src-tauri/src/commands/patcher.rs` refuses to launch the injector when a "non-map
   mod" produces map WADs.

## Root cause

The Rust guard decided "is this a map mod?" by scanning the installed mod folder for a
path containing `/Maps/`:

```rust
fn has_map_wad(path: &PathBuf) -> bool {
    // ... child.to_string_lossy().contains("/Maps/")
}
```

Imported mods are stored **flattened** as `installed/mod_N/WAD/<Name>.wad.client`. The
game's directory layout (and therefore any `/Maps/` component) does not survive import —
only the overlay, written using the game's relpaths, contains `/Maps/`. So
`has_map_wad(installed_dir)` returned `false` for essentially every mod, and the guard
treated every overlay map WAD as unrelated.

### Why a champion skin legitimately produces a map WAD

Revenant Reign Viego ships a `Common.wad.client`. The install has exactly one
`Common.wad.client` in the game:

```text
DATA/FINAL/Maps/Shipping/Common.wad.client
```

`mkoverlay` matches the mod's `Common` to that game WAD by mount name, merges the mod's
entries, and writes it at the game relpath. The overlay therefore contains a real,
intentional map WAD. The diagnostic log confirms it:

```text
Writing wad: WAD/Common.wad.client
Writing wad: DATA/FINAL/Maps/Shipping/Common.wad.client
overlay preflight: imported_map_mod=false generated_map_wads=[".../overlay/DATA/FINAL/Maps/Shipping/Common.wad.client"]
```

## Fix

The guard now compares **mount names** rather than paths, matching what `mkoverlay`
already uses (`mod_index.mounts.contains(mount_name)`):

- `mount_name(filename)` lowercases and strips a trailing `.client` then `.wad`,
  mirroring `wad::Mounted::make_name` in `mod-tools/lib/wad/mounted.hpp`.
- `installed_mod_mounts(dir)` collects the mount names of every WAD the installed mods
  supply.
- A generated map WAD is rejected only when no mod supplies a WAD with that mount name.

This allows a skin that intentionally modifies `Maps/Shipping/Common.wad.client` while
still blocking the historical overlap-only `Map11`/`Map12` leak.

### Files changed

- `src-tauri/src/commands/patcher.rs`: replaced `has_map_wad` with `mount_name` +
  `installed_mod_mounts`; preflight now filters generated map WADs by mount name; added
  tests (`mount_name_matches_mod_tools_make_name`,
  `mod_supplied_map_wad_is_not_unrelated`, `leaked_overlap_map_wad_is_unrelated`).

## Verifying

```bash
cd src-tauri && cargo test --lib commands::patcher
```

Or inspect the diagnostic log after an apply attempt:

```bash
tail -20 "$HOME/Library/Application Support/com.onlyleague.onlyskinz/patcher-diagnostic.log"
```

A successful preflight logs `unrelated_map_wads=[]` and proceeds to `runoverlay`.
