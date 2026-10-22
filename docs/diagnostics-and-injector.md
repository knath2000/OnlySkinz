# OnlySkinz Skin Injection Diagnostics

## Current status

OnlySkinz's Intel macOS diagnostic build successfully applies a OnlySkinz-native skin in a practice game. The injector-only test also works with an empty overlay.

The remaining known compatibility issue is third-party mod content. The tested `Briar Airi Akizuki.fantome` mod caused League to exit at the loading transition and trigger Riot repair, while the same injector and a OnlySkinz-native skin worked.

## Original failure

The original symptom was a League crash after champion select, just as the loading screen began. The Riot client returned to a reconnect state.

The first diagnostic run showed:

- Import succeeded.
- Overlay creation succeeded.
- The patcher found, scanned, and patched League.
- League exited about 20 seconds later.
- The overlay unexpectedly contained 2.2 GB `Map11` and 1.1 GB `Map12` WADs for a Briar-only mod.

## Implemented fixes

### Persistent patcher diagnostics

`src-tauri/src/commands/patcher.rs` writes patcher traces to:

```text
~/Library/Application Support/com.onlyleague.onlyskinz/patcher-diagnostic.log
```

The trace includes archive paths, import and overlay command output, patcher PID, status messages, stderr, exit status, and overlay preflight results.

### Overlay map filtering

`mod-tools/main.cpp` now removes map WADs created only through overlap propagation. Map WADs remain allowed when explicitly supplied by a map mod.

The preflight guard also refuses to launch the injector when a non-map mod generates map WADs.

### Intel macOS injector hardening

The x86_64 injector now:

- Waits for a valid League process base before scanning.
- Suspends League for the complete memory patch transaction.
- Uses an RAII resume guard if patching fails.
- Catches per-process patch failures and continues safely.
- Preserves stack alignment in the Intel `fopen` hook.

### Stale-overlay build guard

`mkoverlay` stamps the overlay with the game build it was built against
(`<overlay>/.onlyskinz-build`), and the patcher refuses to inject when the stamp no
longer matches the installed build. The app also sweeps a stale overlay on game-path
detection. This prevents serving pre-patch WADs, which is the crash/repair-loop
path — see [`riot-repair-loop-troubleshooting.md`](./riot-repair-loop-troubleshooting.md) §8.

### Injector isolation tests

Settings → Diagnostics provides four empty-overlay tests:

- `Scan`: scan only; no process writes.
- `WAD`: only the `wad_verify` patch.
- `fopen`: only the file hook.
- `Full`: both patches.

The `fopen` test initially exposed an invalid diagnostic target. It now uses a separately allocated and initialized hook pointer, so the isolated result is valid.

## Reproduction and testing procedure

Use a practice game and test in this order:

1. Run `Scan` with no skins.
2. Run `WAD` with no skins.
3. Run `fopen` with no skins.
4. Run `Full` with no skins.
5. Apply one OnlySkinz-native skin.
6. Test one third-party `.fantome` or `.zip` mod only after the native skin succeeds.

After any failure, collect:

```bash
tail -200 "$HOME/Library/Application Support/com.onlyleague.onlyskinz/patcher-diagnostic.log"
```

Do not repeatedly test a mod that triggers Riot repair until its archive and generated overlay have been inspected.

## Related

If a launch hangs on the gold splash and the Riot Client forces an endless
repair, see [`riot-repair-loop-troubleshooting.md`](./riot-repair-loop-troubleshooting.md).
That case is a corrupted install-local `Contents/LoL/Game.db` (SQL error 11), not
a bad mod or WAD.

## Current conclusion

The injector and overlay pipeline are validated by the successful OnlySkinz-native skin test. The Briar third-party archive is currently considered incompatible or stale for the installed League build. Future work should inspect its WAD entries and current-patch references before changing the injector again.

## Build

The Intel diagnostic DMG is produced with:

```bash
cmake --build mod-tools/build --config Release -j2
cp mod-tools/build/mod-tools src-tauri/binaries/mod-tools-x86_64-apple-darwin
npm run tauri -- build
```

The bundle is generated at:

```text
src-tauri/target/release/bundle/dmg/OnlySkinz_0.1.12_x64.dmg
```
