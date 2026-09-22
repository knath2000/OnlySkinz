use crate::state::{AppState, PatcherStatus};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

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

fn has_map_wad(path: &PathBuf) -> bool {
    let Ok(entries) = fs::read_dir(path) else {
        return false;
    };

    for entry in entries.flatten() {
        let child = entry.path();
        if child.is_dir() {
            if has_map_wad(&child) {
                return true;
            }
        } else if child
            .to_string_lossy()
            .contains("/Maps/")
        {
            return true;
        }
    }

    false
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

    let imported_map_mod = has_map_wad(&installed_dir);
    let generated_map_wads = overlay_map_wads(&overlay_dir);
    diagnostic_log(
        &log_path,
        format!(
            "overlay preflight: imported_map_mod={} generated_map_wads={:?}",
            imported_map_mod, generated_map_wads
        ),
    );
    if !imported_map_mod && !generated_map_wads.is_empty() {
        return Err(format!(
            "Overlay contains unrelated map WADs; patcher was not started: {:?}",
            generated_map_wads
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
    let stdout_thread = std::thread::spawn(move || {
        if let Some(out) = stdout {
            let reader = BufReader::new(out);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[zushi] mod-tools: {}", line);
                diagnostic_log(&stdout_log, format!("stdout: {}", line));
                if let Some(status_msg) = line.strip_prefix("Status: ") {
                    let new_status = match status_msg {
                        "Waiting for league match to start" => Some(PatcherStatus::WaitingForGame),
                        "Found League" => Some(PatcherStatus::FoundGame),
                        "Scanning" | "Wait initialized" | "Saving" | "Wait patchable" => Some(PatcherStatus::Scanning),
                        "Patching" => Some(PatcherStatus::Patching),
                        "Waiting for exit" => Some(PatcherStatus::InGame),
                        "League exited" => Some(PatcherStatus::GameExited),
                        _ => None,
                    };
                    if let Some(status) = new_status {
                        if let Ok(mut s) = state_arc.lock() {
                            if s.patcher_gen == gen {
                                s.patcher_status = status;
                            }
                        }
                    }
                }
            }
        }
    });

    let stderr_log = log_path.clone();
    let stderr_thread = std::thread::spawn(move || {
        if let Some(err) = stderr {
            let reader = BufReader::new(err);
            for line in reader.lines().map_while(Result::ok) {
                eprintln!("[zushi] mod-tools err: {}", line);
                diagnostic_log(&stderr_log, format!("stderr: {}", line));
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
            if !exit_status.success() {
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
                eprintln!("[zushi] mod-tools runoverlay exited: {}", detail);
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
