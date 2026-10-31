# Game Update Detection

How OnlySkinz detects that League was patched and tells the user what to do.

Before this, the only signal was **reactive**: the injector refused a stale
overlay at Apply time, and the app swept stale overlays on launch. Both happen
*after* the user tries to play, and the sweep deletes the evidence — so the user
got no advance notice. This adds a proactive check plus a clear, actionable
notice.

Two distinct situations are covered, because they need different fixes:

| Situation | Cause | Fix |
|---|---|---|
| **League was updated** | Overlay/skins were built for an older game build | Re-apply skins (rebuilds the overlay against the current build) |
| **OnlySkinz needs an update** | A patch moved `wad_verify`, so the injector's byte-pattern scan no longer matches the binary | Download a new OnlySkinz release — re-applying cannot help |

## Layer 1 — "League was updated" (proactive, offline)

### Baseline

At the end of every successful Apply, `do_apply_skins_bg` records the build the
overlay was made for into `<app_data>/last_applied_build`:

```json
{ "game_path": "/…/Contents/LoL/Game", "build": "release:B0DE7A4FF23DB6B4" }
```

It is scoped to the game path, so switching installs is not misread as a patch.
Unlike the overlay's own `.onlyskinz-build` stamp, this file survives the stale
overlay sweep, which is what makes an already-swept patch still detectable.

### Status command

`get_game_update_status` (in `src-tauri/src/commands/patcher.rs`) returns:

```ts
interface GameUpdateStatus {
  current_build: string | null;   // game_build_id() of the installed game
  applied_build: string | null;   // baseline recorded at the last Apply
  league_updated: boolean;        // both known and different
  overlay_stale: boolean;         // an overlay exists stamped for another build
}
```

It only reads `Game.ok` and a small file, so it is cheap to poll. The conservative
rule matches the inject-time gate: `league_updated` is true **only** when both
builds are identifiable and differ, so a fresh install (no baseline) or an
unidentifiable install never raises a false alarm.

### Frontend

- `src/hooks/useGameUpdate.ts` checks on mount, on a 60s interval, and on window
  focus (the highest-value trigger: the user alt-tabs back after a patch).
  `leagueUpdated` is `league_updated || overlay_stale`.
- `src/components/GameUpdateBanner.tsx` renders the notice at the top of the main
  area, with a **Re-apply** button (runs the normal Apply flow) and a dismiss.
- `src/App.tsx` also refreshes the status when the game path becomes known and
  whenever the patcher goes idle, so the banner clears promptly after a re-apply.

## Layer 2 — "OnlySkinz needs an update"

The injector locates `wad_verify` by scanning the game binary for a byte pattern
(`mod-tools/lib/patcher/patcher_macos_{arm64,amd64}.cpp`, `find_wad_verify`). A
League patch can move it, in which case `ctx.scan` throws
`Failed to find wad_verify call`.

That throw is caught per-iteration, so the patcher would otherwise stay alive and
retry forever, spamming the UI. Instead, the stderr reader thread in
`do_apply_skins_bg`:

1. detects `Failed to find wad_verify`,
2. sets `PatcherStatus::Error(INJECTOR_INCOMPATIBLE_MSG)`, and
3. writes `\n` to the patcher's stdin to make it exit cleanly (retrying is
   pointless).

A `injector_incompatible` flag makes the stdout reader ignore later retry status
lines and stops the exit handler from overwriting the message with the generic
"Patcher exited unexpectedly".

The frontend recognises the message and shows the **Download update** banner
(reusing the releases URL from `useVersionCheck`).

> No `mod-tools` rebuild is required: detection keys off the injector's existing
> stderr output. A dedicated `M_INJECTOR_INCOMPATIBLE` status marker (analogous
> to `M_STALE_OVERLAY`) would be a cleaner long-term signal if the C++ is rebuilt.

## Files

- `src-tauri/src/commands/patcher.rs` — `GameUpdateStatus`, baseline read/write,
  `get_game_update_status`, injector-incompatibility detection, baseline write on
  Apply.
- `src-tauri/src/lib.rs` — registers `get_game_update_status`.
- `src/types/index.ts`, `src/lib/commands.ts` — `GameUpdateStatus` + wrapper.
- `src/hooks/useGameUpdate.ts`, `src/components/GameUpdateBanner.tsx`,
  `src/App.tsx` — polling and UI.

## Edge cases

- **Fresh install / never applied** → no baseline → no banner.
- **Unidentifiable build** → never reported as updated.
- **Different install** → baseline is path-scoped, so no false positive.
- **Apply blocked by Layer 2** → baseline is still recorded at `mkoverlay`, but
  the Layer 2 banner takes precedence and tells the user to update.

## Verification

- `npm run build` passes (`tsc && vite build`).
- `cargo check` and `cargo test --lib` pass (19 tests, including
  `baseline_round_trips_and_is_scoped_to_one_install`).

To exercise Layer 1 by hand: apply skins, then edit the release id in
`<app_data>/last_applied_build` (or the game's `Game.ok`) to differ, and reopen
or refocus the app.
