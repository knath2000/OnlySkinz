# OnlySkinz Overlay Injection and Runtime Performance

Session date: 2026-09-27

A deep read of how the "overlay" reaches the game, and what it costs in CPU/RAM
during a match. Findings only — no code changed for this analysis.

## 0. Terminology

"Overlay" here means an **asset overlay**, not a visual/HUD overlay. There is no
frame hook, no DirectX/Metal interception, and nothing drawn over the game. The
overlay is a directory of modded WAD files that the game is redirected to read
instead of its own.

## 1. Two phases

### Phase A — build the overlay (pre-game, heavy, one-shot)

`src-tauri/src/commands/patcher.rs` `do_apply_skins_bg`:

1. `mod-tools import <zip> installed/mod_N --game:<path>` for each selected mod.
2. `mod-tools mkoverlay installed overlay --game:<path> --mods:mod_0/mod_1/...`.

In `mod-tools/lib/wad/index.cpp` `add_overlay_mod`, each touched mount is copied
wholesale from the game WAD (`*base_mounted`) and the mod's entries are merged in
(`merge_in`). `write_to_directory` writes the **full** WAD, so a skin for Aatrox
produces a full-size copy of `Aatrox.wad.client` with modded assets swapped in.
`archive.cpp` `write_to_file` already sorts entries by address and calls
`into_optimal()`, so the overlay WAD is laid out for sequential reads.

### Phase B — inject (at game launch, one-shot, tiny)

`mod-tools runoverlay` -> `patcher::run`
(`mod-tools/lib/patcher/patcher_macos_arm64.cpp`).

## 2. What the injection actually does

1. **Open the task port** (`process_macos.cpp` `Process::Open`) — requires root,
   which is why the app relaunches itself as admin (`src-tauri/src/lib.rs`).
2. **`wad_verify` bypass** — finds the `wad_verify` call in `__text` via a byte
   pattern and overwrites it with a "return true" stub.
3. **`fopen` hook** — allocates ~528 bytes in the game, writes a small shellcode
   stub, and repoints the `fopen` import. It intercepts only `fopen(path, "rb")`
   calls whose path ends in `.client` (max 128 chars), prepends the overlay
   directory, and falls back to the original path if the overlay file is absent.
4. **Freeze/resume** — patched while the game is suspended via `task_suspend`
   (not ptrace, to avoid League's anti-debug kill), then resumed by an RAII guard.
5. **Wait for exit** — `run_until_or(3h, Intervals{5s,10s,15s}, IsExited)`, then
   loops for the next game launch.

No per-frame code runs; the injected payload is a few hundred bytes.

## 3. Resource profile

| Phase | CPU | RAM |
|-------|-----|-----|
| Overlay build (pre-game) | High (index + write full WADs) | Moderate in `mod-tools mkoverlay` (transient) |
| Game launch (inject) | Brief spike + short freeze; `Dump()` reads the executable | Transient executable-sized buffer in patcher |
| In-game | ~0 patcher CPU; `fopen` hook cost only on asset opens | ~few hundred bytes injected; rest driven by mod assets |
| Waiting for game | ~100 Hz full PID enumeration (`FindPid` every 10 ms) | Small |
| Tauri app (while active) | 2 status polls/sec (`usePatcher` 500 ms interval) | Small, stable |

### Injected footprint

`Payload_fopen_hook` = 0x100 shellcode + 0x100 prefix + pointers ≈ 528 bytes
(arm64); x86-64 additionally allocates an 8-byte hook-target pointer and a 6-byte
import stub. The game's own memory behavior is unchanged in kind — it loads WAD
assets normally, so net RAM/VRAM tracks the size of the mod assets merged.

### Patcher process

`runoverlay` does not hold the overlay in memory (only the prefix string). The
spike is `Process::Dump()` (`process_macos.cpp`), which reads the **entire game
executable from disk** into a `std::vector<char>` during `ctx.scan()`, then frees
it before the freeze. `ReadMemory`/`TryReadMemory` allocate and immediately
deallocate a kernel buffer per call.

### CPU during the match

`run_until_or` wakes only every 5–15 s to call `IsExited()`. The `fopen` hook
fires only when the game opens a `.client` file (mostly at load, not per frame).
There is no frame callback and no game-memory polling.

The largest sustained cost is **while waiting for the game**: `FindPid` every
10 ms enumerates all PIDs and `proc_pidpath`s each until it finds
`/LeagueofLegends`. It does not overlap with gameplay (once found, the patcher is
in wait-exit), but it competes with the client/champ select.

App-side, `usePatcher` polls `get_patcher_status` every 500 ms and only stops on
`Idle`/`Error`; React bails on unchanged status, so the cost is ~2 IPC calls/sec.

## 4. Minimization levers (not implemented)

1. **Cache the Mach-O scan offsets.** `Dump()` + parse + pattern search runs on
   every launch; offsets are stable for a game build. Cache keyed by a hash of
   the binary, invalidating on game patch. Removes the transient allocation and
   scan CPU per launch.
2. **Slow / event-drive `FindPid`.** Raise 10 ms to 250 ms–1 s, or watch the game
   dir with FSEvents/kqueue. The Phase 2 bind-wait tolerates late attach.
3. **Event-driven status.** Push patcher status via Tauri `app.emit` from the
   existing stdout reader instead of 500 ms polling. The downloads flow already
   uses this pattern (`src-tauri/src/commands/skins.rs` emits; `useDownloads.ts`
   listens).
4. **Background QoS.** Set the `mod-tools` child and Tauri process to background
   priority so the OS prefers the foreground game during load.
5. **Trim logging.** The diagnostic log appends every mod-tools line unbounded
   (`patcher.rs` `diagnostic_log`).

The overlay must remain a full-WAD replacement because the game opens a WAD and
parses its TOC; a sparse/virtual overlay would require higher-level loader
interception and is far more fragile. Per-match cost therefore stays proportional
to the mod assets merged, by construction.

## 5. Key files

| Concern | File |
|---------|------|
| Apply orchestration, status, patcher lifecycle | `src-tauri/src/commands/patcher.rs` |
| Overlay build/merge/write | `mod-tools/main.cpp`, `mod-tools/lib/wad/index.cpp`, `archive.cpp` |
| Injection (arm64 / x86-64) | `mod-tools/lib/patcher/patcher_macos_arm64.cpp`, `patcher_macos_amd64.cpp` |
| Process/memory primitives | `mod-tools/lib/patcher/utility/process_macos.cpp` |
| Mach-O parsing | `mod-tools/lib/patcher/utility/macho.hpp` |
| Status polling | `src/hooks/usePatcher.ts` |
| Status display | `src/components/StatusBar.tsx` |