import { useState, useEffect, useCallback } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getGameUpdateStatus } from "../lib/commands";
import type { GameUpdateStatus } from "../types";

// Game.ok is cheap to read, but the game only changes on a patch, so a slow
// poll plus a re-check when the window regains focus is enough to catch one
// promptly without busy-looping.
const POLL_MS = 60_000;

export function useGameUpdate() {
  const [status, setStatus] = useState<GameUpdateStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await getGameUpdateStatus());
    } catch {
      // No game path yet (or the command failed) — treat as "unknown".
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    const win = getCurrentWebviewWindow();
    const unlisten = win.onFocusChanged(({ payload: focused }) => {
      if (focused) refresh();
    });
    return () => {
      clearInterval(id);
      unlisten.then((off) => off()).catch(() => {});
    };
  }, [refresh]);

  // A stale on-disk overlay is the same user-facing situation as a detected
  // build change: skins were applied against a build the game no longer is.
  const leagueUpdated = Boolean(status?.league_updated || status?.overlay_stale);

  return { status, leagueUpdated, refresh };
}
