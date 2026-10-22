# Riot Repair Loop / Corrupted Game.db — Troubleshooting Runbook

Session date: 2026-10-21. League build: 16.21.829.8620 (release `B0DE7A4FF23DB6B4`,
branch `releases-16-21`). Install: `/Volumes/WD/League of Legends.app`.

## 1. Symptom

1. Launch League → hangs on the **gold "League of Legends" splash**.
2. Force-quit, open the Riot Client → it **forces a repair**.
3. Repair appears to run, finishes (or spins), then the whole cycle repeats on the
   next Play press.

The install files themselves can be perfectly fine while this happens. Do not
assume the WADs are corrupt.

## 2. Root cause

Two independent things stack up:

**(a) Stale OnlySkinz overlay.** `mkoverlay` writes full-size replacement WADs
into `~/Library/Application Support/com.onlyleague.onlyskinz/overlay/`. The
injector's `fopen` hook redirects every `*.client` read to that directory. If the
overlay was built *before* a game patch, the game reads an old WAD → WAD mount
fails → `WadFileMountError` → crash. Riot then writes a `SOFT_REPAIR` marker.
(OnlySkinz 0.1.13+ stamps the overlay with the build it was made for and refuses
to inject a stale one — see §8.)

**(b) Corrupted install-local patch DB.** The repair needs `Contents/LoL/Game.db`
to reconcile the install. If that SQLite DB is malformed, the repair dies with
`SQL error: 11 - database disk image is malformed` and **never clears the
corruption flag** → endless repair loop → the gold-splash hang.

**(a) creates the marker; (b) is what makes it un-fixable by Riot alone.** Fixing
only the marker leaves the loop intact.

## 3. The three DBs — do not confuse them

This was the single biggest source of confusion. There are three SQLite-ish files
and only one of them is the problem:

| Path | What it is | Can it corrupt? |
|------|-----------|-----------------|
| `<install>/Contents/LoL/Game.db` | **Install-local patch DB.** Chunk index for the game WADs. This is the one that goes bad. | **Yes — this is the culprit** |
| `<install>/Contents/LoL/Game/Game.db` | 0-byte artifact. Not a database. Ignore it. | No |
| `~/../Shared/Riot Games/Metadata/league_of_legends.live/league_of_legends.live.db` | Riot Client metadata DB (tracks client/plugin files, ~244 rows). Separate and usually healthy. | Rarely |

`Game.ok` sits next to `Game.db` and holds the CDN manifest URL + locale +
platform. `Game.manifest` (17 MB, `RMAN` format) is the source of truth for what
the install should contain.

## 4. Diagnosis procedure

Run these in order. Do not delete anything until step 5 confirms.

### 4.1 Confirm no Riot/League processes are running

```bash
ps aux | grep -iE "riot|league" | grep -v grep
```

Must be empty before touching the DB. League also writes a `lockfile` in
`Contents/LoL/`.

### 4.2 Check for the repair marker

```bash
find "/Volumes/WD/League of Legends.app" -iname SOFT_REPAIR
```

If present, read it — it names the exact WAD that failed to mount:

```bash
cat "/Volumes/WD/League of Legends.app/Contents/LoL/SOFT_REPAIR"
# {"failure_description":"Inconsistent","failure_identifier":"WadFileMountError",
#  "wadfile":"DATA/FINAL/Champions/Kayn.wad.client"}
```

### 4.3 Check the install-local DB for corruption

```bash
cd "/Volumes/WD/League of Legends.app/Contents/LoL"
ls -la Game.db Game.db-wal Game.db-shm
sqlite3 Game.db "PRAGMA integrity_check;"
```

Healthy → `ok` and a size around **33,193,984 bytes**.
Corrupt → `file is not a database (26)` on prepare, or an all-zero hexdump, or a
tiny size (e.g. 12 KB) where 33 MB is expected:

```bash
xxd -l 64 Game.db          # all zeros = destroyed
```

### 4.4 Read Riot's own log — this is the authoritative evidence

Riot Client log:

```bash
ls -lat "$HOME/Library/Logs/Riot Games/Riot Client/Riot Client Logs" | head -5
```

Search it for the smoking gun:

```bash
grep -anE "Repair|repair|SQL error|malformed|Verification completed|status: (UpToDate|Repairing|NeedsRepair)" \
  "$HOME/Library/Logs/Riot Games/Riot Client/Riot Client Logs/<newest>.log" | tail -40
```

The failure signature looks like:

```text
Patch job started because: patchingForRepair
Loading manifest .../Game.manifest for release ID B0DE7A4FF23DB6B4
Creating patch database .../Game.db
Verifying install .../Contents/LoL/Game
Verification: 417 existing files ... 0 missing files, 0 inconsistent files, 417 extra files
Performing partial repair of install at .../Contents/LoL/Game
...
Error patching: Error performing repair: Error rebuilding patch database:
  Error rechunking files: Error removing chunks for rechunked file
  DATA/FINAL/Maps/Shipping/Map11.wad.client: SQL error: 11 - database disk image is malformed
```

`0 missing, 0 inconsistent` is the key line: **the game files are fine.** The
repair is failing purely on the database.

### 4.5 Verify the actual WADs are NOT corrupt

Only worth doing if step 4.4 shows missing/inconsistent files rather than a SQL
error. A WAD is structurally sound if the magic is `RW`, version is `3.4`, and
every TOC entry's `offset + size` is within the file:

```bash
python3 - <<'PY'
import struct, os, sys
p = sys.argv[1] if len(sys.argv) > 1 else "Game/DATA/FINAL/Champions/Kayn.wad.client"
d = open(p, 'rb').read(4096)
assert d[:2] == b'RW', f"bad magic {d[:2]!r}"
n = struct.unpack_from('<I', d, 268)[0]
need = 272 + 32 * n
sz = os.path.getsize(p)
assert need <= sz, f"TOC past EOF: need {need} size {sz}"
toc = open(p, 'rb').read(need)
bad = sum(1 for i in range(n)
          if sum(struct.unpack_from('<II', toc, 272 + 32*i + 8)) > sz)
print(f"{p}: RW {d[2]}.{d[3]} entries={n} oob={bad} {'OK' if not bad else 'BAD'}")
PY
```

### 4.6 Check the OnlySkinz overlay for staleness

**Fastest check — the build stamp.** Builds after 0.1.12 make `mkoverlay` write
`.onlyskinz-build` into the overlay dir, one line holding the game build it was
built against (`release:<id>`, `gameok:<line>`, or `version:<v>`). Compare it to
what the install currently is:

```bash
OV="$HOME/Library/Application Support/com.onlyleague.onlyskinz/overlay"
cat "$OV/.onlyskinz-build"
# -> release:B0DE7A4FF23DB6B4
grep -o '/releases/[A-Z0-9]*' \
  "/Volumes/WD/League of Legends.app/Contents/LoL/Game.ok" | head -1
# -> /releases/B0DE7A4FF23DB6B4
```

Mismatch = stale overlay. No stamp at all = overlay predates the stamp (≤ 0.1.12),
or the build could not be identified; fall back to the size check below.

**Size check (works for any version).** Compare the overlay WAD against the real
one — same entry count, but differing sizes/checksums means the overlay predates a
patch:

```bash
REAL="/Volumes/WD/League of Legends.app/Contents/LoL/Game"
ls -la "$OV/DATA/FINAL/Champions/Kayn.wad.client" \
       "$REAL/DATA/FINAL/Champions/Kayn.wad.client"
```

Real WAD at 16.21 is **113,775,514** bytes. A stale overlay was **107,708,389**
and built ~2 minutes *before* the patch rewrote the real WAD.

`~/Library/Application Support/com.onlyleague.onlyskinz/patcher-diagnostic.log`
timestamps the overlay build.

## 5. Fix

### 5.1 Clear the stale overlay + installed dirs (needs sudo, root-owned)

```bash
sudo rm -rf "$HOME/Library/Application Support/com.onlyleague.onlyskinz/overlay" \
            "$HOME/Library/Application Support/com.onlyleague.onlyskinz/installed"
```

These are rebuilt on the next Apply. They are the artifact that *caused* the
crash, so do not leave them in place.

### 5.2 Delete the corrupted DB + marker

With all Riot/League processes quit:

```bash
cd "/Volumes/WD/League of Legends.app/Contents/LoL"
rm -f Game.db Game.db-shm Game.db-wal SOFT_REPAIR
```

Keep `Game.manifest` and `Game.ok` — Riot needs them to rebuild.

### 5.3 Restart the Riot Client and let it rebuild

Riot sees the missing DB and performs one clean rebuild from `Game.manifest`.
**Do not press Play repeatedly during this.** It takes roughly **7–8 minutes**
with no per-file log output (see §6).

## 6. What a HEALTHY repair looks like (so you don't mistake it for a hang)

This is important — the healthy repair looks *stuck* but is not.

- `status: Repairing, progress: 0` repeats every ~2 s. **Progress stays at 0 for
  the entire run**, then jumps straight to `UpToDate`. Do not read `progress: 0`
  as a stall.
- **No log line at all** between `Performing partial repair` and the final
  `UpToDate` — about 7.5 minutes of silence. The `patch-proxy` status repeater is
  the only output.
- `Game.db` stays at **4096 bytes** and `Game.db-wal` grows to ~13 MB. This is one
  large **uncommitted** transaction — so `SELECT COUNT(*) FROM files` returns
  **0** the whole time. That is expected, not corruption.
- At the end the transaction commits and checkpoints: `Game.db` becomes
  33,193,984 bytes, `Game.db-wal`/`-shm` **disappear**.

Success markers:

```text
status: UpToDate, progress: 0
combinedPatchState: 4, launchable: 1
```

Then verify:

```bash
cd "/Volumes/WD/League of Legends.app/Contents/LoL"
ls -la Game.db Game.db-wal Game.db-shm   # only Game.db, ~33193984
sqlite3 Game.db "PRAGMA integrity_check;"                 # ok
sqlite3 Game.db "SELECT COUNT(*) FROM files;"             # 417
sqlite3 Game.db "SELECT COUNT(*) FROM chunks;"            # ~1,105,466
cat "/Users/Shared/Riot Games/Metadata/league_of_legends.live/league_of_legends.live.product_settings.yaml" | grep should_repair  # false
```

`417 files` = 394 game WADs + 20 `LeagueofLegends.app` files + 3 metadata JSONs.

## 7. Evidence that a repair is genuinely stuck (vs. just slow)

Only conclude "stuck" if **all** of these hold:

- `progress` still 0 after ~15 minutes, **and**
- `Game.db-wal` size has not changed for several minutes, **and**
- `find "<install>/Contents/LoL/Game" -newermt "-3 minutes" -type f` returns
  nothing, **and**
- no new meaningful (non-repeater) log lines.

Note: the patch worker can burn ~20% CPU while writing nothing to disk during the
index phase, so CPU alone is not a stall signal.

## 8. Prevention (OnlySkinz side) — implemented after 0.1.12

The underlying app bug was: `src-tauri/src/commands/patcher.rs`
`do_apply_skins_bg` wipes and rebuilds `installed/` and `overlay/` **only at Apply
time**, with no patch/version guard — so a stale overlay was silently served to a
freshly-patched game. Three mechanisms now prevent it.

### 8.1 Build identity

`mod-tools/lib/patcher/build_id.cpp` derives one stable string for the installed
game, in priority order:

1. `<install>/Contents/LoL/Game.ok` line 1 — the CDN release manifest URL
   `https://lol.secure.dyn.riotcdn.net/channels/public/releases/<ID>.manifest`
   → `release:<ID>`. Riot rewrites this file on every patch, so it is the best
   signal.
2. Otherwise `Game.ok` line 1 verbatim → `gameok:<line>`.
3. Otherwise `LeagueofLegends.app/Contents/Info.plist` `CFBundleVersion` →
   `version:<v>`.

The same logic is mirrored in Rust (`game_build_id` in
`src-tauri/src/commands/patcher.rs`) so both sides agree.

### 8.2 Stamp at build, gate at inject

- `mod-tools mkoverlay` writes the id to `<overlay>/.onlyskinz-build` after
  `wad::Index::cleanup_in_directory` (which only deletes `*.wad.client` not in
  `mounts`, so the stamp survives). If the build cannot be identified it logs a
  warning and writes nothing.
- `patcher::run` (both `patcher_macos_amd64.cpp` and `patcher_macos_arm64.cpp`)
  compares the stamp against `game_build_id(game_path)` and refuses to inject on a
  mismatch, throwing `PatcherStaleOverlay`. It is checked **twice**: once before
  the wait-for-game loop (a stale overlay fails immediately at Apply) and once per
  launch after the game is found (a patch landing while we wait does not slip
  through).
- The gate only blocks when the stamp is non-empty **and** the current build is
  identifiable **and** they differ. Unstamped overlays and unidentifiable installs
  are never blocked, so old overlays keep working.
- `scan-only` / `wad-verify-only` / `fopen-only` diagnostics bypass the gate.

`mod_runoverlay` catches `PatcherStaleOverlay`, clears the error stack, and returns
cleanly, so the UI shows the real reason instead of "Patcher exited unexpectedly":

```text
[patcher] overlay is stale: built for release:<OLD>, game is release:<NEW> - refusing to patch
Status: Overlay is stale
```

`M_STALE_OVERLAY` maps to `PatcherStatus::Error("Game was updated since these
skins were applied; re-apply your skins.")`; a `stale_overlay` flag stops the
exit-status handler from overwriting it.

### 8.3 Never leave a stale overlay reachable

`sweep_stale_overlay_for` (Rust) deletes `overlay/` and `installed/` when the app
learns the game path — called from `detect_game_path` and `set_game_path` — so an
overlay built for a previous install/build cannot be served. `do_apply_skins_bg`
additionally wipes both dirs unconditionally at the start of every Apply, so
re-applying always rebuilds against the current build.

### 8.4 If the loop still happens

The gate cannot help if the overlay was already served and Riot is now mid-loop;
follow §5 to clear the overlay and rebuild the DB. When the overlay is root-owned
(the injector runs as root), §5.1 needs `sudo`.

## 9. Key paths

| What | Path |
|------|------|
| Install-local patch DB | `<install>/Contents/LoL/Game.db` |
| Repair marker | `<install>/Contents/LoL/SOFT_REPAIR` |
| Manifest / ok | `<install>/Contents/LoL/Game.manifest`, `Game.ok` |
| Game WADs | `<install>/Contents/LoL/Game/DATA/FINAL/` |
| Riot Client metadata | `~/Library/Application Support/Riot Games/League of Legends/` |
| Riot Client DB | `~/../Shared/Riot Games/Metadata/league_of_legends.live/league_of_legends.live.db` |
| **Riot Client log** | `~/Library/Logs/Riot Games/Riot Client/Riot Client Logs/` |
| League Client log | `<install>/Contents/LoL/Logs/LeagueClient Logs/` |
| OnlySkinz overlay | `~/Library/Application Support/com.onlyleague.onlyskinz/overlay/` |
| Overlay build stamp | `<overlay>/.onlyskinz-build` (e.g. `release:B0DE7A4FF23DB6B4`) |
| OnlySkinz diagnostics | `~/Library/Application Support/com.onlyleague.onlyskinz/patcher-diagnostic.log` |
