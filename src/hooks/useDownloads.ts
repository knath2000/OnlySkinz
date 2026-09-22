import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  listDownloadedSkins,
  downloadSkin as downloadSkinCmd,
  downloadMultipleSkins,
  deleteDownloadedSkin as deleteCmd,
  clearAllSkins as clearAllCmd,
} from "../lib/commands";
import type { DownloadedSkin } from "../types";

interface QueueItem {
  url: string;
  championName: string;
  skinName: string;
}

interface DownloadProgress {
  current: number;
  total: number;
  skinName: string;
}

export function useDownloads() {
  const [downloads, setDownloads] = useState<DownloadedSkin[]>([]);
  const [downloading, setDownloading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cacheSize, setCacheSize] = useState(0);
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const list = await listDownloadedSkins();
      setDownloads(list);
      // The list already stats every zip, so total from it instead of walking
      // the whole skins tree again.
      setCacheSize(list.reduce((sum, d) => sum + d.size, 0));
    } catch {}
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Set of "champion/skin" keys so per-card lookups are O(1) instead of scanning
  // the whole download list (ChampionDetail calls this for every skin + chroma).
  const downloadKeys = useMemo(
    () => new Set(downloads.map((d) => `${d.champion_name}/${d.skin_name}`)),
    [downloads]
  );

  const isDownloaded = useCallback(
    (championName: string, skinName: string): boolean => {
      return downloadKeys.has(`${championName}/${skinName}`);
    },
    [downloadKeys]
  );

  const download = useCallback(
    async (url: string, championName: string, skinName: string) => {
      if (busy.current) return;
      busy.current = true;
      const key = `${championName}/${skinName}`;
      setDownloading(key);
      setError(null);
      try {
        await downloadSkinCmd(url, championName, skinName);
      } catch (err) {
        setError(String(err));
      }
      setDownloading(null);
      busy.current = false;
      await refresh();
    },
    [refresh]
  );

  const downloadMultiple = useCallback(
    async (items: QueueItem[]) => {
      if (busy.current || items.length === 0) return;
      busy.current = true;
      setDownloading("batch");
      setError(null);

      const unlisten = await listen<DownloadProgress>("download-progress", (event) => {
        setDownloading(
          `${event.payload.skinName} (${event.payload.current}/${event.payload.total})`
        );
      });

      try {
        await downloadMultipleSkins(items);
      } catch (err) {
        setError(String(err));
      }

      unlisten();
      setDownloading(null);
      busy.current = false;
      await refresh();
    },
    [refresh]
  );

  const deleteSkin = useCallback(
    async (championName: string, skinName: string) => {
      setError(null);
      try {
        await deleteCmd(championName, skinName);
        await refresh();
      } catch (err) {
        setError(String(err));
      }
    },
    [refresh]
  );

  const clearAll = useCallback(async () => {
    setError(null);
    try {
      await clearAllCmd();
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }, [refresh]);

  const clearError = useCallback(() => setError(null), []);

  return {
    downloads,
    downloading,
    error,
    cacheSize,
    isDownloaded,
    download,
    downloadMultiple,
    deleteSkin,
    clearAll,
    clearError,
    refresh,
  };
}
