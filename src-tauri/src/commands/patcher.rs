use crate::state::{AppState, PatcherStatus};
use serde::Serialize;
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

/// Written by `mod-tools mkoverlay`, read back here to decide whether an overlay
/// still matches the installed game. Keep in sync with build_id.cpp.
const BUILD_STAMP_NAME: &str = ".onlyskinz-build";

const STALE_OVERLAY_MSG: &str = "Game was updated since these skins were applied; re-apply your skins.";

/// Records the game build the current overlay was built against. Kept separate
/// from the overlay's own stamp so a patch is still detected after the stale
/// overlay has been swept.
const APPLIED_BUILD_FILE: &str = "last_applied_build";

/// Shown when the injector's byte-pattern scan no longer matches the game
/// binary. Unlike a stale overlay, this cannot be fixed by re-applying — the app
/// itself needs updating for the new build.
const INJECTOR_INCOMPATIBLE_MSG: &str =
    "This League patch changed the game binary. OnlySkinz needs an update to work with it. Download the latest version.";

/// Identifies the installed League build. Riot rewrites the release ID on every
/// patch, so a change here means any existing overlay WAD is stale.
///
/// Mirrors `patcher::game_build_id` in mod-tools/lib/patcher/build_id.cpp so the
/// UI can make the same judgement without launching the injector.
fn game_build_id(game_path: &str) -> Option<String> {
    // game_path is <install>/Contents/LoL/Game; Game.ok sits in <install>/Contents/LoL.
    let install = Path::new(game_path).parent()?;

    if let Some(line) = fs::read_to_string(install.join("Game.ok"))
        .ok()
        .and_then(|c| c.lines().next().map(|l| l.trim().to_string()))
        .filter(|l| !l.is_empty())
    {
        if let Some(rest) = line.split("/releases/").nth(1) {
            if let Some(id) = rest.split('.').next() {
                if !id.is_empty() {
                    return Some(format!("release:{}", id));
                }
            }
        }
        return Some(format!("gameok:{}", line));
    }

    // Fall back to the executable's bundle version when Game.ok is missing.
    let plist = fs::read_to_string(
        Path::new(game_path)
            .join("LeagueofLegends.app")
            .join("Contents")
            .join("Info.plist"),
    )
    .ok()?;
    let after_key = plist.split("<key>CFBundleVersion</key>").nth(1)?;
    let value = after_key.split("<string>").nth(1)?.split("</string>").next()?;
    let value = value.trim();
    if value.is_empty() {
        None
    } else {
        Some(format!("version:{}", value))
    }
}

fn read_build_stamp(overlay_dir: &Path) -> Option<String> {
    fs::read_to_string(overlay_dir.join(BUILD_STAMP_NAME))
        .ok()
        .and_then(|c| c.lines().next().map(|l| l.trim().to_string()))
        .filter(|l| !l.is_empty())
}

/// True when the overlay was built for a game build other than the installed
/// one. False when either identity is unknown, so an unstamped overlay is never
/// treated as stale.
fn overlay_is_stale(overlay_dir: &Path, game_path: &str) -> bool {
    let Some(stamped) = read_build_stamp(overlay_dir) else {
        return false;
    };
    match game_build_id(game_path) {
        Some(current) => stamped != current,
        None => false,
    }
}

/// Delete a stale overlay instead of leaving it reachable.
///
/// The injector serves the overlay as a stand-in for the game's own WADs. If it
/// was built before the installed game build, serving it makes the client fail
/// the WAD mount, write SOFT_REPAIR, and trigger a repair loop. The injector
/// refuses stale overlays on its own, but removing the files means a stale
/// overlay cannot be reached even if that check is bypassed.
fn sweep_stale_overlay(app: &AppHandle, game_path: &str) {
    let base = work_dir(app);
    let overlay = base.join("overlay");
    if !overlay_is_stale(&overlay, game_path) {
        return;
    }

    diagnostic_log(
        &base.join("patcher-diagnostic.log"),
        format!(
            "removing stale overlay: built for {:?}, game is {:?}",
            read_build_stamp(&overlay),
            game_build_id(game_path)
        ),
    );
    let _ = fs::remove_dir_all(&overlay);
    let _ = fs::remove_dir_all(base.join("installed"));
}

/// Called when the app learns which install to use, so an overlay left behind by
/// an earlier session is discarded before any patcher can be started against it.
pub fn sweep_stale_overlay_for(app: &AppHandle, game_path: &str) {
    sweep_stale_overlay(app, game_path);
}

/// Whether the installed game has changed since skins were last applied.
#[derive(Debug, Clone, Default, Serialize)]
pub struct GameUpdateStatus {
    pub current_build: Option<String>,
    pub applied_build: Option<String>,
    /// Both identities are known and differ: the game was patched.
    pub league_updated: bool,
    /// An overlay exists on disk stamped for a different build.
    pub overlay_stale: bool,
}

/// Baseline build recorded at the last successful Apply, scoped to one install
/// so switching game paths does not read as a patch.
fn read_baseline(base: &Path, game_path: &str) -> Option<String> {
    let raw = fs::read_to_string(base.join(APPLIED_BUILD_FILE)).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    if value.get("game_path").and_then(|v| v.as_str()) != Some(game_path) {
        return None;
    }
    value
        .get("build")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

fn write_baseline(base: &Path, game_path: &str, build: &str) {
    let value = serde_json::json!({ "game_path": game_path, "build": build });
    let _ = fs::write(base.join(APPLIED_BUILD_FILE), value.to_string());
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Builds a throwaway `<install>/Contents/LoL/Game` tree with the given
    /// Game.ok contents (and optionally an Info.plist for the fallback path).
    fn fake_install(tag: &str, game_ok: Option<&str>, plist_version: Option<&str>) -> PathBuf {
        let root = std::env::temp_dir().join(format!("onlyskinz-buildid-{}", tag));
        let _ = fs::remove_dir_all(&root);
        let install = root.join("Contents").join("LoL");
        let game = install.join("Game");
        fs::create_dir_all(&game).unwrap();
        if let Some(contents) = game_ok {
            fs::write(install.join("Game.ok"), contents).unwrap();
        }
        if let Some(version) = plist_version {
            let contents = game.join("LeagueofLegends.app").join("Contents");
            fs::create_dir_all(&contents).unwrap();
            fs::write(
                contents.join("Info.plist"),
                format!(
                    "<plist><dict><key>CFBundleVersion</key><string>{}</string></dict></plist>",
                    version
                ),
            )
            .unwrap();
        }
        game
    }

    #[test]
    fn build_id_comes_from_game_ok_release_url() {
        let game = fake_install(
            "release",
            Some("https://lol.secure.dyn.riotcdn.net/channels/public/releases/B0DE7A4FF23DB6B4.manifest\nen_US\nmac\n"),
            None,
        );
        assert_eq!(
            game_build_id(game.to_str().unwrap()).as_deref(),
            Some("release:B0DE7A4FF23DB6B4")
        );
    }

    #[test]
    fn build_id_falls_back_to_bundle_version() {
        let game = fake_install("version", None, Some("16.21.8298620"));
        assert_eq!(
            game_build_id(game.to_str().unwrap()).as_deref(),
            Some("version:16.21.8298620")
        );
    }

    #[test]
    fn build_id_is_none_when_install_is_unidentifiable() {
        let game = fake_install("unknown", None, None);
        assert_eq!(game_build_id(game.to_str().unwrap()), None);
    }

    #[test]
    fn unstamped_overlay_is_not_stale() {
        let game = fake_install("unstamped", Some("https://x/releases/AAAA.manifest\n"), None);
        let overlay = std::env::temp_dir().join("onlyskinz-buildid-unstamped-overlay");
        let _ = fs::remove_dir_all(&overlay);
        fs::create_dir_all(&overlay).unwrap();
        assert!(!overlay_is_stale(&overlay, game.to_str().unwrap()));
    }

    #[test]
    fn stale_overlay_is_detected_only_on_mismatch() {
        let game = fake_install("stale", Some("https://x/releases/AAAA.manifest\n"), None);
        let overlay = std::env::temp_dir().join("onlyskinz-buildid-stale-overlay");
        let _ = fs::remove_dir_all(&overlay);
        fs::create_dir_all(&overlay).unwrap();

        fs::write(overlay.join(BUILD_STAMP_NAME), "release:AAAA\n").unwrap();
        assert!(!overlay_is_stale(&overlay, game.to_str().unwrap()));

        fs::write(overlay.join(BUILD_STAMP_NAME), "release:BBBB\n").unwrap();
        assert!(overlay_is_stale(&overlay, game.to_str().unwrap()));
    }

    #[test]
    fn unidentifiable_install_never_blocks_an_overlay() {
        let game = fake_install("noblock", None, None);
        let overlay = std::env::temp_dir().join("onlyskinz-buildid-noblock-overlay");
        let _ = fs::remove_dir_all(&overlay);
        fs::create_dir_all(&overlay).unwrap();
        fs::write(overlay.join(BUILD_STAMP_NAME), "release:AAAA\n").unwrap();
        assert!(!overlay_is_stale(&overlay, game.to_str().unwrap()));
    }

    #[test]
    fn baseline_round_trips_and_is_scoped_to_one_install() {
        let base = std::env::temp_dir().join("onlyskinz-baseline-test");
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();

        assert_eq!(read_baseline(&base, "/game/A"), None);
        write_baseline(&base, "/game/A", "release:AAAA");
        assert_eq!(read_baseline(&base, "/game/A").as_deref(), Some("release:AAAA"));
        // A different install must not inherit the baseline.
        assert_eq!(read_baseline(&base, "/game/B"), None);
    }

    #[test]
    fn mount_name_matches_mod_tools_make_name() {
        assert_eq!(mount_name("Common.wad.client"), "common");
        assert_eq!(mount_name("Viego.wad.client"), "viego");
        assert_eq!(mount_name("Map11.wad.client"), "map11");
        assert_eq!(mount_name("Something.wad"), "something");
    }

    /// The Revenant Reign Viego case: the mod ships `Common.wad.client`, which the
    /// game only has at `DATA/FINAL/Maps/Shipping/Common.wad.client`. The overlay
    /// map WAD is intentional and must not be blocked.
    #[test]
    fn mod_supplied_map_wad_is_not_unrelated() {
        let base = std::env::temp_dir().join("onlyskinz-preflight-supplied");
        let _ = fs::remove_dir_all(&base);
        let installed = base.join("installed").join("mod_0").join("WAD");
        let overlay = base
            .join("overlay")
            .join("DATA")
            .join("FINAL")
            .join("Maps")
            .join("Shipping");
        fs::create_dir_all(&installed).unwrap();
        fs::create_dir_all(&overlay).unwrap();
        fs::write(installed.join("Common.wad.client"), b"").unwrap();
        fs::write(overlay.join("Common.wad.client"), b"").unwrap();

        let mod_mounts = installed_mod_mounts(&base.join("installed"));
        let generated = overlay_map_wads(&base.join("overlay"));
        assert_eq!(generated.len(), 1);
        assert!(mod_mounts.contains(&mount_name("Common.wad.client")));
        let unrelated: Vec<_> = generated
            .iter()
            .filter(|wad| {
                Path::new(wad)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| !mod_mounts.contains(&mount_name(n)))
                    .unwrap_or(true)
            })
            .collect();
        assert!(unrelated.is_empty());
    }

    /// A leaked overlap map (the Briar Map11/Map12 case) has no matching mod WAD
    /// and must still be flagged.
    #[test]
    fn leaked_overlap_map_wad_is_unrelated() {
        let base = std::env::temp_dir().join("onlyskinz-preflight-leaked");
        let _ = fs::remove_dir_all(&base);
        let installed = base.join("installed").join("mod_0").join("WAD");
        let overlay = base
            .join("overlay")
            .join("DATA")
            .join("FINAL")
            .join("Maps")
            .join("Shipping");
        fs::create_dir_all(&installed).unwrap();
        fs::create_dir_all(&overlay).unwrap();
        fs::write(installed.join("Viego.wad.client"), b"").unwrap();
        fs::write(overlay.join("Map11.wad.client"), b"").unwrap();

        let mod_mounts = installed_mod_mounts(&base.join("installed"));
        let generated = overlay_map_wads(&base.join("overlay"));
        assert_eq!(generated.len(), 1);
        let unrelated: Vec<_> = generated
            .iter()
            .filter(|wad| {
                Path::new(wad)
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| !mod_mounts.contains(&mount_name(n)))
                    .unwrap_or(true)
            })
            .collect();
        assert_eq!(unrelated.len(), 1);
    }
}

/// Serializes patcher setup (kill-old → import → mkoverlay → spawn → record pid).
/// Two live mod-tools tracers on the same game task port make the kernel SIGSEGV
/// the new one, so only one apply may be in its setup phase at a time. Held until
/// just before the long monitoring wait, then released.
fn apply_setup_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

fn work_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .expect("failed to get app data dir");
    fs::create_dir_all(&dir).ok();
    dir
}

fn diagnostic_log(path: &PathBuf, message: impl AsRef<str>) {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        writeln!(file, "{} {}", timestamp, message.as_ref()).ok();
    }
}

/// Mount name for a WAD filename: lowercased, with a trailing `.client` and then
/// `.wad` stripped. Mirrors `wad::Mounted::make_name` in
/// `mod-tools/lib/wad/mounted.hpp` so the Rust preflight and `mkoverlay` agree on
/// which WAD a file refers to.
fn mount_name(filename: &str) -> String {
    let mut name = filename.to_lowercase();
    if let Some(stripped) = name.strip_suffix(".client") {
        name = stripped.to_string();
    }
    if let Some(stripped) = name.strip_suffix(".wad") {
        name = stripped.to_string();
    }
    name
}

/// Mount names of every WAD the installed mods supply.
///
/// Imported mods are stored flattened as `installed/mod_N/WAD/<Name>.wad.client`,
/// so the game's directory layout (and thus any `/Maps/` component) is gone by
/// the time the preflight runs. The mount name is what survives and what
/// `mkoverlay` matches on, so it is the only reliable way to tell whether a map
/// WAD in the overlay was intentionally supplied by a mod.
fn installed_mod_mounts(path: &Path) -> HashSet<String> {
    let mut names = HashSet::new();
    let Ok(entries) = fs::read_dir(path) else {
        return names;
    };

    for entry in entries.flatten() {
        let child = entry.path();
        if child.is_dir() {
            names.extend(installed_mod_mounts(&child));
        } else if let Some(name) = child.file_name().and_then(|n| n.to_str()) {
            names.insert(mount_name(name));
        }
    }

    names
}

fn overlay_map_wads(path: &PathBuf) -> Vec<String> {
    let mut paths = Vec::new();
    let Ok(entries) = fs::read_dir(path) else {
        return paths;
    };

    for entry in entries.flatten() {
        let child = entry.path();
        if child.is_dir() {
            paths.extend(overlay_map_wads(&child));
        } else if child.to_string_lossy().contains("/Maps/") {
            paths.push(child.to_string_lossy().into_owned());
        }
    }

    paths
}

fn sidecar_path(_app: &AppHandle) -> PathBuf {
    let triple = if cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else {
        "x86_64-apple-darwin"
    };

    // Production: Tauri bundles the sidecar as "mod-tools" next to the app binary
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let bin = dir.join("mod-tools");
            if bin.exists() {
                return bin;
            }
        }
    }

    // Dev: binary lives in src-tauri/binaries/ with the target triple suffix
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("mod-tools-{}", triple))
}

fn run_mod_tools(binary: &PathBuf, args: &[String], log_path: &PathBuf) -> Result<String, String> {
    diagnostic_log(log_path, format!("command start: {} {:?}", binary.display(), args));
    let output = Command::new(binary)
        .args(args)
        .output()
        .map_err(|e| format!("Failed to run mod-tools: {}", e))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    diagnostic_log(
        log_path,
        format!(
            "command exit: success={} code={:?}\nstdout:\n{}\nstderr:\n{}",
            output.status.success(),
            output.status.code(),
            stdout.trim(),
            stderr.trim()
        ),
    );

    if !output.status.success() {
        let detail = if stderr.is_empty() {
            stdout.trim().to_string()
        } else {
            format!("{}\n{}", stdout.trim(), stderr.trim())
        };
        return Err(format!(
            "mod-tools failed (exit {}): {}",
            output.status.code().unwrap_or(-1),
            detail
        ));
    }

    Ok(stdout)
}

#[tauri::command]
pub fn apply_skin(
    app: AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
    zip_path: String,
) -> Result<String, String> {
    start_apply(app, vec![zip_path], state.inner().clone())
}

#[tauri::command]
pub fn apply_skins(
    app: AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
    zip_paths: Vec<String>,
) -> Result<String, String> {
    start_apply(app, zip_paths, state.inner().clone())
}

#[tauri::command]
pub fn test_injector(
    app: AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
    mode: String,
) -> Result<String, String> {
    let game_path = state
        .lock()
        .map_err(|e| e.to_string())?
        .game_path
        .clone()
        .ok_or_else(|| "Game path not set".to_string())?;
    let binary = sidecar_path(&app);
    if !binary.exists() {
        return Err(format!("mod-tools not found at {:?}", binary));
    }

    let base = work_dir(&app);
    let overlay = base.join("injector-test-overlay");
    let config = base.join("injector-test-config");
    let log_path = base.join("patcher-diagnostic.log");
    let _ = fs::remove_dir_all(&overlay);
    fs::create_dir_all(&overlay).map_err(|e| e.to_string())?;
    fs::write(&config, "").map_err(|e| e.to_string())?;

    let gen = {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.patcher_gen += 1;
        s.patcher_status = PatcherStatus::WaitingForGame;
        s.patcher_gen
    };
    if !["scan-only", "wad-verify-only", "fopen-only", "full"].contains(&mode.as_str()) {
        return Err("Invalid injector test mode".to_string());
    }
    diagnostic_log(&log_path, format!("injector-only test requested: mode={} generation={} game={}", mode, gen, game_path));
    let state = state.inner().clone();

    std::thread::spawn(move || {
        let overlay_str = overlay.to_string_lossy().to_string();
        let config_str = config.to_string_lossy().to_string();
        let game_arg = format!("--game:{}", game_path);
        let opts_arg = format!("--opts:{}", mode);
        let mut child = match Command::new(&binary)
            .args(["runoverlay", &overlay_str, &config_str, &game_arg, &opts_arg])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
        {
            Ok(child) => child,
            Err(e) => {
                diagnostic_log(&log_path, format!("injector-only spawn failed: {}", e));
                return;
            }
        };
        diagnostic_log(&log_path, format!("injector-only spawned: pid={}", child.id()));
        let child_pid = child.id();
        let stdin = child.stdin.take();
        if let Ok(mut s) = state.lock() {
            s.patcher_stdin = stdin;
            s.patcher_pid = Some(child_pid);
        }

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();
        let stdout_log = log_path.clone();
        let stdout_thread = std::thread::spawn(move || {
            if let Some(out) = stdout {
                for line in BufReader::new(out).lines().map_while(Result::ok) {
                    diagnostic_log(&stdout_log, format!("injector-only stdout: {}", line));
                }
            }
        });
        let stderr_log = log_path.clone();
        let stderr_thread = std::thread::spawn(move || {
            if let Some(err) = stderr {
                for line in BufReader::new(err).lines().map_while(Result::ok) {
                    diagnostic_log(&stderr_log, format!("injector-only stderr: {}", line));
                }
            }
        });
        let exit = child.wait();
        let _ = stdout_thread.join();
        let _ = stderr_thread.join();
        diagnostic_log(&log_path, format!("injector-only exit: {:?}", exit));
        if let Ok(mut s) = state.lock() {
            if s.patcher_gen == gen {
                s.patcher_status = PatcherStatus::Idle;
                s.patcher_stdin = None;
                s.patcher_pid = None;
            }
        }
    });

    Ok("Injector-only test started".to_string())
}

/// Validates inputs, sets status to Importing, spawns a background thread
/// for the heavy work, and returns immediately so the UI stays responsive.
fn start_apply(
    app: AppHandle,
    zip_paths: Vec<String>,
    state: Arc<Mutex<AppState>>,
) -> Result<String, String> {
    if zip_paths.is_empty() {
        return Err("No skins selected".to_string());
    }

    let game_path = {
        let s = state.lock().map_err(|e| e.to_string())?;
        s.game_path
            .clone()
            .ok_or_else(|| "Game path not set".to_string())?
    };

    let binary = sidecar_path(&app);
    if !binary.exists() {
        return Err(format!("mod-tools not found at {:?}", binary));
    }

    // Bump the generation up front so any apply already waiting for the setup
    // lock knows it has been superseded and can bail without spawning a patcher.
    let gen = {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.patcher_gen += 1;
        s.patcher_status = PatcherStatus::Importing;
        s.patcher_gen
    };

    let base = work_dir(&app);
    let log_path = base.join("patcher-diagnostic.log");
    diagnostic_log(
        &log_path,
        format!(
            "apply requested: generation={} game={} archives={:?}",
            gen, game_path, zip_paths
        ),
    );

    std::thread::spawn(move || {
        // Serialize the whole setup so two patchers can never run at once. This
        // blocks until any in-flight apply has finished spawning and *recorded*
        // its pid — only then can we see and kill it. Released before monitoring.
        let setup_guard = apply_setup_lock().lock().unwrap_or_else(|e| e.into_inner());

        // A newer apply superseded us while we waited for the lock — let it win.
        if let Ok(s) = state.lock() {
            if s.patcher_gen != gen {
                return;
            }
        }

        // Stop the currently-tracked patcher: close its stdin (graceful abort),
        // then confirm it is fully dead before we touch the game. pid is read
        // here (under the setup lock) so it reflects the real running patcher.
        let old_pid = match state.lock() {
            Ok(mut s) => {
                if let Some(mut pipe) = s.patcher_stdin.take() {
                    pipe.write_all(b"\n").ok();
                    drop(pipe);
                }
                s.patcher_pid.take()
            }
            Err(_) => None,
        };
        if let Some(pid) = old_pid {
            diagnostic_log(&log_path, format!("stopping previous patcher pid={}", pid));
            let pid_i = pid as i32;
            // kill(pid, 0) probes existence: 0 while alive, -1 (ESRCH) once gone.
            let wait_gone = |timeout_ms: u64| -> bool {
                let deadline =
                    std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
                loop {
                    if unsafe { libc::kill(pid_i, 0) } != 0 {
                        return true;
                    }
                    if std::time::Instant::now() >= deadline {
                        return false;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            };
            if !wait_gone(3000) {
                unsafe { libc::kill(pid_i, libc::SIGTERM) };
                if !wait_gone(1500) {
                    unsafe { libc::kill(pid_i, libc::SIGKILL) };
                    wait_gone(2000);
                }
            }
        }

        if let Err(e) =
            do_apply_skins_bg(binary, base, game_path, zip_paths, state.clone(), gen, setup_guard)
        {
            diagnostic_log(&log_path, format!("apply failed: {}", e));
            if let Ok(mut s) = state.lock() {
                if s.patcher_gen == gen {
                    s.patcher_status = PatcherStatus::Error(e);
                    s.patcher_stdin = None;
                    s.patcher_pid = None;
                }
            }
        }
    });

    Ok("Patcher starting".to_string())
}

fn do_apply_skins_bg(
    binary: PathBuf,
    base: PathBuf,
    game_path: String,
    zip_paths: Vec<String>,
    state: Arc<Mutex<AppState>>,
    gen: u64,
    setup_guard: MutexGuard<'static, ()>,
) -> Result<(), String> {
    let installed_dir = base.join("installed");
    let overlay_dir = base.join("overlay");
    let config_file = base.join("config");
    let log_path = base.join("patcher-diagnostic.log");
    diagnostic_log(&log_path, format!("setup: game={} archives={:?}", game_path, zip_paths));

    // Any previous overlay is discarded here and rebuilt below, so a stale one
    // cannot survive into the next session's runoverlay.
    let _ = fs::remove_dir_all(&installed_dir);
    let _ = fs::remove_dir_all(&overlay_dir);
    fs::create_dir_all(&installed_dir).map_err(|e| e.to_string())?;
    fs::create_dir_all(&overlay_dir).map_err(|e| e.to_string())?;
    fs::write(&config_file, "").map_err(|e| e.to_string())?;

    // Step 1: Import all skins
    let mut mod_names = Vec::new();
    for (i, zip_path) in zip_paths.iter().enumerate() {
        let mod_name = format!("mod_{}", i);
        let mod_dir = installed_dir.join(&mod_name);

        diagnostic_log(&log_path, format!("import start: {} -> {}", zip_path, mod_dir.display()));
        run_mod_tools(
            &binary,
            &[
                "import".into(),
                zip_path.clone(),
                mod_dir.to_string_lossy().to_string(),
                format!("--game:{}", game_path),
            ],
            &log_path,
        )?;

        mod_names.push(mod_name);
    }

    // Step 2: Build overlay with all mods
    {
        if let Ok(mut s) = state.lock() {
            if s.patcher_gen == gen {
                s.patcher_status = PatcherStatus::BuildingOverlay;
            }
        }
    }

    let mods_arg = format!("--mods:{}", mod_names.join("/"));
    let mkoverlay_args = vec![
        "mkoverlay".into(),
        installed_dir.to_string_lossy().to_string(),
        overlay_dir.to_string_lossy().to_string(),
        format!("--game:{}", game_path),
        mods_arg,
    ];

    diagnostic_log(&log_path, format!("overlay start: {}", overlay_dir.display()));
    run_mod_tools(&binary, &mkoverlay_args, &log_path).map_err(|e| {
        if e.to_lowercase().contains("conflict") {
            "You can't apply two skins to the same champion at once. Deselect one and try again.".to_string()
        } else {
            e
        }
    })?;

    // Remember the build this overlay was made for, so a later game patch is
    // still detected after the stale overlay has been swept.
    if let Some(build) = game_build_id(&game_path) {
        write_baseline(&base, &game_path, &build);
    }

    // A map WAD in the overlay is legitimate only when a mod actually supplies
    // that WAD. mkoverlay already drops map WADs that leak in purely through
    // overlap propagation, so anything left that no mod supplied is unrelated
    // (the historical Briar Map11/Map12 case) and must not be injected.
    let mod_mounts = installed_mod_mounts(&installed_dir);
    let generated_map_wads = overlay_map_wads(&overlay_dir);
    let unrelated_map_wads: Vec<String> = generated_map_wads
        .iter()
        .filter(|wad| {
            Path::new(wad)
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| !mod_mounts.contains(&mount_name(n)))
                .unwrap_or(true)
        })
        .cloned()
        .collect();
    diagnostic_log(
        &log_path,
        format!(
            "overlay preflight: mod_mounts={:?} generated_map_wads={:?} unrelated_map_wads={:?}",
            mod_mounts, generated_map_wads, unrelated_map_wads
        ),
    );
    if !unrelated_map_wads.is_empty() {
        return Err(format!(
            "Overlay contains unrelated map WADs; patcher was not started: {:?}",
            unrelated_map_wads
        ));
    }

    // Step 3: Run patcher
    {
        if let Ok(mut s) = state.lock() {
            if s.patcher_gen == gen {
                s.patcher_status = PatcherStatus::WaitingForGame;
            }
        }
    }

    let overlay_str = overlay_dir.to_string_lossy().to_string();
    let config_str = config_file.to_string_lossy().to_string();
    let game_arg = format!("--game:{}", game_path);

    let mut child = Command::new(&binary)
        .args([
            "runoverlay",
            &overlay_str,
            &config_str,
            &game_arg,
            "--opts:none",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Failed to start patcher: {}", e))?;
    diagnostic_log(&log_path, format!("runoverlay spawned: pid={} overlay={} config={} game={}", child.id(), overlay_str, config_str, game_path));

    // Record pid/stdin unconditionally (even if a newer apply just superseded us
    // while we held the setup lock): a superseding apply must be able to find and
    // kill this patcher. The generation guard elsewhere keeps stale status/cleanup
    // from clobbering the newer patcher.
    let child_pid = child.id();
    let stdin = child.stdin.take();
    if let Ok(mut s) = state.lock() {
        s.patcher_stdin = stdin;
        s.patcher_pid = Some(child_pid);
    }

    // Setup is done and the pid is recorded — release the lock so a queued apply
    // can now proceed (it will kill this patcher first). Everything below is just
    // long-running monitoring.
    drop(setup_guard);

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let state_arc = state.clone();
    let stdout_log = log_path.clone();
    // The stale case exits cleanly, so it must be remembered: the exit-status
    // block below would otherwise report a generic "exited unexpectedly" and
    // bury the reason the user needs.
    let stale_overlay = Arc::new(AtomicBool::new(false));
    let stale_overlay_out = stale_overlay.clone();
    // Set when the injector reports that it cannot locate wad_verify in the game
    // binary, which means a League patch moved it and the app needs updating.
    let injector_incompatible = Arc::new(AtomicBool::new(false));
    let incompatible_stdout = injector_incompatible.clone();
    let stdout_thread = std::thread::spawn(move || {
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[onlyskinz] mod-tools: {}", line);
                diagnostic_log(&stdout_log, format!("stdout: {}", line));
                if let Some(status_msg) = line.strip_prefix("Status: ") {
                    let new_status = match status_msg {
                        "Waiting for league match to start" => Some(PatcherStatus::WaitingForGame),
                        "Found League" => Some(PatcherStatus::FoundGame),
                        "Scanning" | "Wait initialized" | "Saving" | "Wait patchable" => Some(PatcherStatus::Scanning),
                        "Patching" => Some(PatcherStatus::Patching),
                        "Waiting for exit" => Some(PatcherStatus::InGame),
                        "League exited" => Some(PatcherStatus::GameExited),
                        "Overlay is stale" => {
                            stale_overlay_out.store(true, Ordering::SeqCst);
                            Some(PatcherStatus::Error(STALE_OVERLAY_MSG.to_string()))
                        }
                        _ => None,
                    };
                    if let Some(status) = new_status {
                        // Once the injector is known to be incompatible, later
                        // retry status lines must not clobber the message.
                        if !incompatible_stdout.load(Ordering::SeqCst) {
                            if let Ok(mut s) = state_arc.lock() {
                                if s.patcher_gen == gen {
                                    s.patcher_status = status;
                                }
                            }
                        }
                    }
                }
            }
        }
    });

    let stderr_log = log_path.clone();
    let state_stderr = state.clone();
    let incompatible_stderr = injector_incompatible.clone();
    let stderr_thread = std::thread::spawn(move || {
        if let Some(err) = stderr {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[onlyskinz] mod-tools err: {}", line);
                diagnostic_log(&stderr_log, format!("stderr: {}", line));
                // The injector finds wad_verify by scanning the game binary for a
                // byte pattern. A League patch can move it, in which case no
                // overlay will ever apply and the app itself needs updating.
                // Retrying is pointless, so report it and ask the patcher to exit.
                if line.contains("Failed to find wad_verify") {
                    incompatible_stderr.store(true, Ordering::SeqCst);
                    if let Ok(mut s) = state_stderr.lock() {
                        if s.patcher_gen == gen {
                            s.patcher_status =
                                PatcherStatus::Error(INJECTOR_INCOMPATIBLE_MSG.to_string());
                            if let Some(mut pipe) = s.patcher_stdin.take() {
                                pipe.write_all(b"\n").ok();
                                drop(pipe);
                            }
                        }
                    }
                }
            }
        }
    });

    let exit_status = child
        .wait()
        .map_err(|e| format!("Failed to wait for patcher: {}", e))?;
    diagnostic_log(&log_path, format!("runoverlay exit: success={} code={:?}", exit_status.success(), exit_status.code()));
    let _ = stdout_thread.join();
    let _ = stderr_thread.join();

    if let Ok(mut s) = state.lock() {
        if s.patcher_gen == gen {
            if stale_overlay.load(Ordering::SeqCst) {
                // Already reported with its explanation by the stdout thread.
            } else if injector_incompatible.load(Ordering::SeqCst) {
                // Already reported by the stderr thread; keep the message instead
                // of the generic "exited unexpectedly".
                s.patcher_status = PatcherStatus::Error(INJECTOR_INCOMPATIBLE_MSG.to_string());
            } else if !exit_status.success() {
                use std::os::unix::process::ExitStatusExt;
                let detail = if let Some(code) = exit_status.code() {
                    format!("exit code {}", code)
                } else if let Some(sig) = exit_status.signal() {
                    let name = match sig {
                        1 => "SIGHUP", 2 => "SIGINT", 3 => "SIGQUIT", 6 => "SIGABRT",
                        9 => "SIGKILL", 10 => "SIGBUS", 11 => "SIGSEGV", 13 => "SIGPIPE",
                        15 => "SIGTERM", _ => "?",
                    };
                    format!("killed by signal {} ({})", sig, name)
                } else {
                    "unknown".to_string()
                };
                eprintln!("[onlyskinz] mod-tools runoverlay exited: {}", detail);
                s.patcher_status =
                    PatcherStatus::Error(format!("Patcher exited unexpectedly ({})", detail));
            } else {
                s.patcher_status = PatcherStatus::Idle;
            }
            s.patcher_stdin = None;
            s.patcher_pid = None;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn stop_patcher(state: State<'_, Arc<Mutex<AppState>>>) -> Result<(), String> {
    let stdin = {
        let mut s = state.lock().map_err(|e| e.to_string())?;
        s.patcher_stdin.take()
    };

    if let Some(mut pipe) = stdin {
        pipe.write_all(b"\n").ok();
        drop(pipe);
    }

    let mut s = state.lock().map_err(|e| e.to_string())?;
    s.patcher_status = PatcherStatus::Idle;
    Ok(())
}

#[tauri::command]
pub fn get_patcher_status(state: State<'_, Arc<Mutex<AppState>>>) -> Result<PatcherStatus, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(s.patcher_status.clone())
}

/// Reports whether the installed game build changed since skins were last
/// applied, and whether an on-disk overlay is stale. Cheap (reads Game.ok and a
/// small file), so the UI can poll it and re-check on focus.
#[tauri::command]
pub fn get_game_update_status(
    app: AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<GameUpdateStatus, String> {
    let game_path = state.lock().map_err(|e| e.to_string())?.game_path.clone();
    let Some(game_path) = game_path else {
        return Ok(GameUpdateStatus::default());
    };

    let base = work_dir(&app);
    let current_build = game_build_id(&game_path);
    let applied_build = read_baseline(&base, &game_path);
    let overlay_stale = overlay_is_stale(&base.join("overlay"), &game_path);
    let league_updated = match (&applied_build, &current_build) {
        (Some(applied), Some(current)) => applied != current,
        _ => false,
    };

    Ok(GameUpdateStatus {
        current_build,
        applied_build,
        league_updated,
        overlay_stale,
    })
}

#[tauri::command]
pub fn get_work_dir_size(app: AppHandle) -> Result<u64, String> {
    let base = work_dir(&app);
    let installed = dir_size(&base.join("installed"));
    let overlay = dir_size(&base.join("overlay"));
    Ok(installed + overlay)
}

#[tauri::command]
pub fn clear_work_dir(
    app: AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    {
        let s = state.lock().map_err(|e| e.to_string())?;
        if s.patcher_stdin.is_some() {
            return Err("Cannot clear while patcher is running".to_string());
        }
    }
    let base = work_dir(&app);
    let _ = fs::remove_dir_all(base.join("installed"));
    let _ = fs::remove_dir_all(base.join("overlay"));
    let _ = fs::remove_file(base.join("config"));
    Ok(())
}

use super::dir_size;
