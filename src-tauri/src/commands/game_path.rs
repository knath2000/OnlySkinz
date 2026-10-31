use crate::state::{AppState, AppStatus};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};

const DEFAULT_GAME_PATH: &str = "/Applications/League of Legends.app/Contents/LoL/Game";

/// File under the app data dir remembering the install the user last chose, so
/// startup reuses it instead of re-browsing on every launch.
const GAME_PATH_FILE: &str = "game_path";

/// Check if a directory is a valid League game folder by looking for LeagueofLegends.app.
fn is_valid_game_dir(path: &str) -> bool {
    let app_path = Path::new(path).join("LeagueofLegends.app");
    app_path.exists()
}

/// Try multiple path suffixes to find the Game directory.
fn resolve_game_path(raw: &str) -> Option<String> {
    if raw.is_empty() {
        return None;
    }

    let candidates = [
        format!("{}/Contents/LoL/Game", raw),
        raw.to_string(),
        format!("{}/Game", raw),
    ];

    for candidate in &candidates {
        if is_valid_game_dir(candidate) {
            return Path::new(candidate)
                .canonicalize()
                .ok()
                .map(|p| p.to_string_lossy().to_string());
        }
    }

    None
}

fn game_path_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    fs::create_dir_all(&dir).ok();
    Some(dir.join(GAME_PATH_FILE))
}

fn read_saved_game_path(app: &AppHandle) -> Option<String> {
    let file = game_path_file(app)?;
    fs::read_to_string(file)
        .ok()
        .and_then(|c| c.lines().next().map(|l| l.trim().to_string()))
        .filter(|l| !l.is_empty())
}

fn write_saved_game_path(app: &AppHandle, path: &str) {
    if let Some(file) = game_path_file(app) {
        let _ = fs::write(file, format!("{}\n", path));
    }
}

#[tauri::command]
pub fn detect_game_path(
    app: AppHandle,
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<Option<String>, String> {
    // Prefer the install the user last chose, then fall back to the conventional
    // default. If neither resolves, the UI asks for a manual selection.
    let resolved = read_saved_game_path(&app)
        .and_then(|path| resolve_game_path(&path))
        .or_else(|| resolve_game_path(DEFAULT_GAME_PATH));

    if let Some(path) = resolved {
        // Drop any overlay left over from a previous session that no longer
        // matches this install, so it cannot be served to the game.
        crate::commands::patcher::sweep_stale_overlay_for(&app, &path);

        let mut app_state = state.lock().map_err(|e| e.to_string())?;
        app_state.game_path = Some(path.clone());
        app_state.status = AppStatus::GameDetected;
        return Ok(Some(path));
    }

    let mut app_state = state.lock().map_err(|e| e.to_string())?;
    app_state.status = AppStatus::GameNotFound;
    Ok(None)
}

#[tauri::command]
pub fn validate_game_path(path: String) -> Result<Option<String>, String> {
    Ok(resolve_game_path(&path))
}

#[tauri::command]
pub fn set_game_path(
    app: AppHandle,
    path: String,
    state: State<'_, Arc<Mutex<AppState>>>,
) -> Result<(), String> {
    let validated = resolve_game_path(&path)
        .ok_or_else(|| "Invalid game path: LeagueofLegends.app not found".to_string())?;

    // Remember the choice so the next launch can reuse it without re-browsing.
    write_saved_game_path(&app, &validated);

    // The user may have just switched installs; an overlay built for the old one
    // must not survive.
    crate::commands::patcher::sweep_stale_overlay_for(&app, &validated);

    let mut app_state = state.lock().map_err(|e| e.to_string())?;
    app_state.game_path = Some(validated);
    app_state.status = AppStatus::GameDetected;
    Ok(())
}

#[tauri::command]
pub fn get_game_path(state: State<'_, Arc<Mutex<AppState>>>) -> Result<Option<String>, String> {
    let app_state = state.lock().map_err(|e| e.to_string())?;
    Ok(app_state.game_path.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_accepts_app_root_game_dir_and_rejects_invalid() {
        let root = std::env::temp_dir().join("onlyskinz-gamepath-test");
        let _ = fs::remove_dir_all(&root);
        let game = root.join("Contents").join("LoL").join("Game");
        fs::create_dir_all(game.join("LeagueofLegends.app")).unwrap();

        let expected = game.canonicalize().unwrap().to_string_lossy().to_string();
        let app_root = root.to_string_lossy().to_string();
        let game_dir = game.to_string_lossy().to_string();

        // The .app root and the Game dir itself both resolve to the Game dir.
        assert_eq!(resolve_game_path(&app_root).as_deref(), Some(expected.as_str()));
        assert_eq!(resolve_game_path(&game_dir).as_deref(), Some(expected.as_str()));

        assert_eq!(resolve_game_path(""), None);
        assert_eq!(resolve_game_path("/does/not/exist"), None);
    }
}
