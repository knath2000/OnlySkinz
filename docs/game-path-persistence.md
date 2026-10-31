# Game Path Persistence

How OnlySkinz remembers the League install across launches.

## Problem

`detect_game_path` used to probe **only** `/Applications/League of Legends.app/…`
on startup. If the game lived anywhere else (e.g. an external volume such as
`/Volumes/WD/League of Legends.app`), the user had to re-browse to it on every
single launch, and `set_game_path` only stored the choice in memory.

## Behaviour now

Startup resolves the install in this order:

1. **The path the user last chose**, persisted at `<app_data>/game_path`
   (single line, absolute `…/Contents/LoL/Game` directory).
2. **The conventional default** `/Applications/League of Legends.app/Contents/LoL/Game`.
3. **Nothing** → the UI shows the manual browse screen as before.

If the saved path is missing or no longer valid, it is simply ignored and the
next fallback is tried, so a moved/uninstalled copy degrades to a manual prompt
rather than an error.

## Implementation (`src-tauri/src/commands/game_path.rs`)

- `GAME_PATH_FILE = "game_path"`, stored under `app.path().app_data_dir()`.
- `read_saved_game_path` / `write_saved_game_path` — one-line file helpers.
- `set_game_path` validates via `resolve_game_path`, **persists the choice**, then
  sweeps any stale overlay built for the previous install.
- `detect_game_path` tries the saved path first (`resolve_game_path`), then the
  default, then returns `None`.
- `resolve_game_path` accepts the `.app` root, the `Game` directory, or a bare
  `<x>/Game`, and canonicalizes the result (so `/var` vs `/private/var` and other
  symlink forms compare consistently).

The frontend is unchanged: `useGamePath` still calls `detect_game_path` on mount
and gates the setup screen on `onlyskinz:setup_complete`.

## Verification

- `cargo test --lib` passes (20 tests), including
  `game_path::tests::resolve_accepts_app_root_game_dir_and_rejects_invalid`.
- Manual: choose a non-default install once, quit, relaunch — it should reopen
  straight to the main UI without asking again.
