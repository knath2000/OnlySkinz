import { useState, useEffect, useCallback } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { Swords, Layers, Package, Settings as SettingsIcon, Star, ListChecks } from "lucide-react";
import { useGamePath } from "./hooks/useGamePath";
import { usePatcher } from "./hooks/usePatcher";
import { useDownloads } from "./hooks/useDownloads";
import { useCustoms } from "./hooks/useCustoms";
import { ensureChampions } from "./hooks/useChampions";
import {
  ensureSkinIds,
  ensureRepoZips,
  ensureChromaInfo,
  lookupChromaInfo,
  getSkinsForChampion,
  skinDownloadUrl,
} from "./hooks/useSkinData";
import { useVersionCheck } from "./hooks/useVersionCheck";
import { getChampSelectChampion } from "./lib/commands";
import StatusBar from "./components/StatusBar";
import DownloadBar from "./components/DownloadBar";
import GamePathSelector from "./components/GamePathSelector";
import ChampionGrid from "./components/ChampionGrid";
import ChampionDetail from "./components/ChampionDetail";
import MySkins from "./components/MySkins";
import SelectedSkins from "./components/SelectedSkins";
import Customs from "./components/Customs";
import Settings from "./components/Settings";
import Toast from "./components/Toast";
import UpdateBanner from "./components/UpdateBanner";
import type { Champion } from "./types";
import logo from "./assets/icon.png";

type View = "champions" | "my-skins" | "selected" | "customs" | "settings";

const GOD_MODE_KEY = "zushi_god_mode";
const GOD_LAST_KEY = "zushi_god_last_skin";

// Base-skin name shared by a skin and all of its chromas, so GOD mode can avoid
// re-applying the same skin group two games in a row (e.g. "Mecha Aatrox" and
// "Mecha Aatrox (Obsidian)").
function skinGroupName(skinName: string): string {
  return lookupChromaInfo(skinName)?.parentName ?? skinName;
}

const NAV_ITEMS: { id: View; label: string; icon: typeof Swords }[] = [
  { id: "champions", label: "Champions", icon: Swords },
  { id: "my-skins", label: "My Skins", icon: Layers },
  { id: "selected", label: "Selected", icon: ListChecks },
  { id: "customs", label: "Customs", icon: Package },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

function App() {
  const { gamePath, detectedPath, status, selectPath, confirmSetup, checkPath } = useGamePath();
  const patcher = usePatcher();
  const dl = useDownloads();
  const customs = useCustoms();
  const update = useVersionCheck();
  const [view, setView] = useState<View>("champions");
  const [selectedChampion, setSelectedChampion] = useState<Champion | null>(null);
  const [skinSelection, setSkinSelection] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem("zushi_skin_selection");
      if (raw) return JSON.parse(raw) as Record<string, string>;
    } catch {}
    return {};
  });
  const [appVersion, setAppVersion] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [godMode, setGodMode] = useState(() => localStorage.getItem(GOD_MODE_KEY) === "1");

  useEffect(() => {
    getVersion()
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  // Show window once webview is ready
  useEffect(() => {
    const win = getCurrentWebviewWindow();
    win.show();
    win.setAlwaysOnTop(true).then(() => {
      win.setFocus();
      setTimeout(() => win.setAlwaysOnTop(false), 100);
    });
  }, []);

  // Preload caches
  useEffect(() => {
    ensureChampions().catch(() => {});
    ensureSkinIds().catch(() => {});
    ensureRepoZips().catch(() => {});
    ensureChromaInfo().catch(() => {});
  }, []);

  // Surface patcher errors as toast
  useEffect(() => {
    if (patcher.error) setToastMessage(patcher.error);
  }, [patcher.error]);

  // Surface customs errors as toast
  useEffect(() => {
    if (customs.error) setToastMessage(customs.error);
  }, [customs.error]);

  function handleNavClick(id: View): void {
    setView(id);
    if (id !== "champions") setSelectedChampion(null);
  }

  const handleApply = useCallback(async () => {
    // Default behaviour: apply every selected skin plus enabled customs.
    const applyAll = () => {
      const skinPaths: string[] = [];
      for (const [championName, skinName] of Object.entries(skinSelection)) {
        const skin = dl.downloads.find(
          (d) => d.champion_name === championName && d.skin_name === skinName
        );
        if (skin) skinPaths.push(skin.zip_path);
      }
      const allPaths = [...skinPaths, ...customs.enabledPaths];
      if (allPaths.length > 0) patcher.apply(allPaths);
    };

    // If the League client is in champ select, apply only the champion that
    // was picked there instead of every selected skin.
    let championId: number | null = null;
    try {
      championId = await getChampSelectChampion();
    } catch {
      championId = null;
    }
    if (championId == null) {
      applyAll();
      return;
    }

    let champion: Champion | undefined;
    try {
      champion = (await ensureChampions()).find((c) => c.key === String(championId));
    } catch {
      champion = undefined;
    }

    // GOD mode: ignore the manual selection and draw a random downloaded skin
    // (or chroma) for the picked champion, never repeating the same skin group
    // (base skin + any of its chromas) two games in a row.
    if (godMode) {
      if (!champion) {
        applyAll();
        return;
      }
      const candidates = dl.downloads.filter((d) => d.champion_name === champion.name);
      if (candidates.length === 0) {
        setToastMessage(`GOD mode: no downloaded skins for ${champion.name}.`);
        return;
      }

      // lookupChromaInfo needs both caches to resolve chromas to their base skin.
      await Promise.all([ensureSkinIds(), ensureChromaInfo()]).catch(() => {});

      let history: Record<string, string> = {};
      try {
        history = JSON.parse(localStorage.getItem(GOD_LAST_KEY) ?? "{}");
      } catch {}
      const lastRaw = history[champion.name];
      const lastGroup = lastRaw ? skinGroupName(lastRaw) : undefined;
      const pool = candidates.filter((c) => skinGroupName(c.skin_name) !== lastGroup);
      const source = pool.length > 0 ? pool : candidates;
      const pick = source[Math.floor(Math.random() * source.length)];
      history[champion.name] = skinGroupName(pick.skin_name);
      localStorage.setItem(GOD_LAST_KEY, JSON.stringify(history));

      setToastMessage(`GOD mode: applied "${pick.skin_name}" for ${champion.name}.`);
      patcher.apply([pick.zip_path, ...customs.enabledPaths]);
      return;
    }

    const skinName = champion ? skinSelection[champion.name] : undefined;
    if (!champion || !skinName) {
      applyAll();
      return;
    }

    const skin = dl.downloads.find(
      (d) => d.champion_name === champion.name && d.skin_name === skinName
    );
    if (!skin) {
      setToastMessage(`${champion.name} picked, but "${skinName}" isn't downloaded.`);
      applyAll();
      return;
    }

    setToastMessage(`Champ select: applied "${skinName}" for ${champion.name}.`);
    patcher.apply([skin.zip_path, ...customs.enabledPaths]);
  }, [skinSelection, dl.downloads, customs.enabledPaths, patcher, godMode]);

  useEffect(() => {
    localStorage.setItem("zushi_skin_selection", JSON.stringify(skinSelection));
  }, [skinSelection]);

  const skinCount = Object.keys(skinSelection).length;

  const handleDownloadAll = useCallback(async () => {
    const [champions, skinIds] = await Promise.all([
      ensureChampions(),
      ensureSkinIds(),
      ensureRepoZips(),
      ensureChromaInfo(),
    ]).then(([champions, skinIds]) => [champions, skinIds] as const);

    const items = champions.flatMap((champion) =>
      getSkinsForChampion(champion, skinIds)
        .filter((skin) => !dl.isDownloaded(skin.championName, skin.name))
        .flatMap((skin) => {
          const url = skinDownloadUrl(skin);
          return url ? [{ url, championName: skin.championName, skinName: skin.name }] : [];
        })
    );

    await dl.downloadMultiple(items);
  }, [dl]);

  function renderContent() {
    if (view === "settings") {
      return (
        <div className="flex-1 overflow-y-auto">
          <Settings
            gamePath={gamePath}
            onPathChange={selectPath}
            patcherActive={patcher.isActive}
            godMode={godMode}
            onGodModeChange={(on) => {
              setGodMode(on);
              localStorage.setItem(GOD_MODE_KEY, on ? "1" : "0");
            }}
            onTestInjector={patcher.testInjector}
            onSkinsCleared={async () => {
              setSkinSelection({});
              await dl.refresh();
            }}
            onCustomsCleared={customs.refresh}
          />
        </div>
      );
    }

    if (view === "customs") {
      return (
        <Customs
          customs={customs.customs}
          patcherActive={patcher.isActive}
          onAdd={customs.addCustom}
          onRemove={customs.remove}
          onToggle={customs.toggle}
        />
      );
    }

    if (view === "my-skins") {
      return (
        <MySkins
          downloads={dl.downloads}
          patcherActive={patcher.isActive}
          selection={skinSelection}
          onSelectionChange={setSkinSelection}
          onDelete={dl.deleteSkin}
        />
      );
    }

    if (view === "selected") {
      return (
        <SelectedSkins
          downloads={dl.downloads}
          patcherActive={patcher.isActive}
          selection={skinSelection}
          onSelectionChange={setSkinSelection}
        />
      );
    }

    if (selectedChampion) {
      return (
        <ChampionDetail
          champion={selectedChampion}
          onBack={() => setSelectedChampion(null)}
          isDownloaded={dl.isDownloaded}
          downloading={dl.downloading}
          onDownload={dl.download}
          onDownloadAll={dl.downloadMultiple}
        />
      );
    }

    return (
      <ChampionGrid
        onSelect={setSelectedChampion}
        onDownloadAll={handleDownloadAll}
        downloading={dl.downloading}
      />
    );
  }

  return (
    <div className="bg-charcoal-400 relative flex h-screen">
      <aside className="border-border flex w-50 shrink-0 flex-col border-r">
        <div className="flex items-end gap-2.5 px-4 py-4 select-none">
          <img src={logo} alt="Zushi" className="h-9 w-9" />
          <span className="font-logo text-gold-400 text-4xl leading-6 uppercase">Zushi</span>
        </div>

        <div className="border-border mx-3 border-b" />

        <nav className="flex flex-col gap-1 p-3 select-none">
          {NAV_ITEMS.map(({ id, label, icon: Icon }) => {
            const active = view === id;
            return (
              <button
                key={id}
                onClick={() => handleNavClick(id)}
                className={[
                  "flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-charcoal-200 text-gold-400"
                    : "text-ink-muted hover:text-ink hover:bg-charcoal-300",
                ].join(" ")}
              >
                <Icon size={16} strokeWidth={1.5} />
                {label}
              </button>
            );
          })}
        </nav>

        <div className="mt-auto">
          <button
            onClick={() =>
              invoke("open_url", { url: "https://github.com/Mouadzz/zushi" }).catch(() => {})
            }
            className="text-ink-muted hover:text-gold-400 mx-2 mb-2 flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-2 text-sm transition-colors"
          >
            <Star
              size={16}
              strokeWidth={1.5}
              fill="currentColor"
              className="text-gold-400 shrink-0"
            />
            <span className="whitespace-nowrap">Star Zushi on GitHub</span>
          </button>

          {update.updateAvailable && update.latestVersion ? (
            <UpdateBanner version={update.latestVersion} releasesUrl={update.releasesUrl} />
          ) : (
            <div className="px-4 pb-4 select-none">
              <span className="text-ink-muted text-xs">{appVersion ? `v${appVersion}` : ""}</span>
            </div>
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex flex-1 flex-col overflow-hidden">{renderContent()}</main>

        <DownloadBar downloading={dl.downloading} />

        <StatusBar
          patcherStatus={patcher.status}
          skinCount={skinCount}
          customCount={customs.enabledCount}
          godMode={godMode}
          onApply={handleApply}
          onStop={patcher.stop}
        />
      </div>

      {(toastMessage || dl.error) && (
        <Toast
          key={toastMessage ?? dl.error ?? ""}
          message={toastMessage ?? dl.error ?? ""}
          onClose={() => {
            setToastMessage(null);
            dl.clearError();
            customs.clearError();
          }}
        />
      )}

      {status !== "game-detected" && (
        <div className="bg-charcoal-400 absolute inset-0 z-50">
          <GamePathSelector
            onConfirm={confirmSetup}
            onSelect={selectPath}
            onCheck={checkPath}
            detectedPath={detectedPath}
            status={status}
          />
        </div>
      )}
    </div>
  );
}

export default App;
