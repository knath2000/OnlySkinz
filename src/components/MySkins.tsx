import { useState, useEffect, useMemo } from "react";
import { Layers, Check, Info, X, Search, Star } from "lucide-react";
import { lookupChromaInfo, ensureChromaInfo } from "../hooks/useSkinData";
import { SkinThumb, ChampAvatar } from "./SkinMedia";
import { favoriteKey } from "../lib/favorites";
import type { DownloadedSkin, SkinSelection } from "../types";

function useChromaReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    ensureChromaInfo()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  return ready;
}

// base is null when the user only owns chromas of this base.
type DownloadGroup = {
  base: DownloadedSkin | null;
  baseSkinName: string;
  chromas: { dl: DownloadedSkin; colors: string[] }[];
};

interface MySkinsProps {
  downloads: DownloadedSkin[];
  patcherActive: boolean;
  selection: SkinSelection;
  onSelectionChange: (selection: SkinSelection) => void;
  onDelete: (championName: string, skinName: string) => Promise<void>;
  favorites: Set<string>;
  onToggleFavorite: (championName: string, skinName: string) => void;
}

export default function MySkins({
  downloads,
  patcherActive,
  selection,
  onSelectionChange,
  onDelete,
  favorites,
  onToggleFavorite,
}: MySkinsProps) {
  const chromaReady = useChromaReady(); // re-render once Community Dragon chroma data lands

  const toggleSkin = (championName: string, skinName: string) => {
    if (patcherActive) return;
    const current = selection[championName] ?? [];
    const next = { ...selection };
    if (current.includes(skinName)) {
      const remaining = current.filter((n) => n !== skinName);
      if (remaining.length > 0) next[championName] = remaining;
      else delete next[championName];
    } else {
      next[championName] = [...current, skinName];
    }
    onSelectionChange(next);
  };

  // Removes the given skins from a champion's selection (dropping the champion
  // entry entirely once nothing is left).
  const deselectSkins = (championName: string, skinNames: string[]) => {
    const current = selection[championName] ?? [];
    const remaining = current.filter((n) => !skinNames.includes(n));
    if (remaining.length === current.length) return;
    const next = { ...selection };
    if (remaining.length > 0) next[championName] = remaining;
    else delete next[championName];
    onSelectionChange(next);
  };

  const handleDelete = async (championName: string, skinName: string) => {
    if (patcherActive) return;
    // Also deselect if this skin was selected
    deselectSkins(championName, [skinName]);
    await onDelete(championName, skinName);
  };

  const handleDeleteGroup = async (championName: string, skinNames: string[]) => {
    if (patcherActive || skinNames.length === 0) return;
    deselectSkins(championName, skinNames);
    await Promise.all(skinNames.map((n) => onDelete(championName, n)));
  };

  const selectedCount = Object.values(selection).reduce((n, names) => n + names.length, 0);
  const [search, setSearch] = useState("");

  // Grouping scans the ~9k skin database per skin, so memoize it on downloads
  // (and chroma readiness) instead of rebuilding on every search/selection render.
  const grouped = useMemo(() => {
    void chromaReady; // recompute once Community Dragon chroma data lands
    const map = new Map<string, DownloadGroup[]>();
    for (const skin of downloads) {
      const champGroups = map.get(skin.champion_name) ?? [];
      const chromaInfo = lookupChromaInfo(skin.skin_name);
      if (chromaInfo) {
        let g = champGroups.find((g) => g.baseSkinName === chromaInfo.parentName);
        if (!g) {
          g = { base: null, baseSkinName: chromaInfo.parentName, chromas: [] };
          champGroups.push(g);
        }
        g.chromas.push({ dl: skin, colors: chromaInfo.colors });
      } else {
        let g = champGroups.find((g) => g.baseSkinName === skin.skin_name);
        if (!g) {
          g = { base: skin, baseSkinName: skin.skin_name, chromas: [] };
          champGroups.push(g);
        } else {
          g.base = skin;
        }
      }
      map.set(skin.champion_name, champGroups);
    }
    return map;
  }, [downloads, chromaReady]);

  const filteredEntries = useMemo(() => {
    const entries = [...grouped.entries()];
    const query = search.trim().toLowerCase();
    return query ? entries.filter(([champion]) => champion.toLowerCase().includes(query)) : entries;
  }, [grouped, search]);

  if (downloads.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-border flex shrink-0 items-center border-b px-4 py-3">
          <span className="text-ink-muted text-sm select-none">0 skins</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="bg-charcoal-300 flex h-12 w-12 items-center justify-center rounded-full">
            <Layers size={20} strokeWidth={1.5} className="text-ink-muted" />
          </div>
          <div>
            <p className="text-ink-secondary text-sm">No skins downloaded yet</p>
            <p className="text-ink-muted mt-1 text-xs">
              Browse champions and download skins to get started
            </p>
          </div>
        </div>
      </div>
    );
  }

  let baseSkinCount = 0;
  for (const groups of grouped.values()) baseSkinCount += groups.length;

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <span className="text-ink-muted text-sm tabular-nums select-none">
          {baseSkinCount} {baseSkinCount === 1 ? "skin" : "skins"}
        </span>

        <div className="relative max-w-64 flex-1">
          <Search
            size={14}
            strokeWidth={1.5}
            className="text-ink-muted pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2"
          />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by champion"
            className="bg-charcoal-500 border-border text-ink placeholder:text-ink-muted focus:border-gold-500/60 w-full rounded-sm border py-1.5 pr-3 pl-8 text-sm transition-colors focus:outline-none"
          />
        </div>

        {selectedCount > 0 && (
          <span className="text-gold-400 ml-auto text-sm font-medium tabular-nums select-none">
            {selectedCount} selected
          </span>
        )}
      </div>

      <div className="bg-gold-400/8 border-gold-400/15 mx-4 mt-3 mb-1 flex items-start gap-2.5 rounded-lg border px-3 py-2.5">
        <Info size={14} strokeWidth={1.5} className="text-gold-400 mt-0.5 shrink-0" />
        <p className="text-ink-secondary text-xs leading-relaxed">
          <span className="text-gold-400 font-medium">Keep the default skin</span> selected in
          champion select. If you use a skin you already own, it will override your patched one.
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col">
          {filteredEntries.length === 0 && (
            <div className="text-ink-muted flex h-32 items-center justify-center text-sm">
              No champions match "{search}"
            </div>
          )}
          {filteredEntries.map(([champion, groups]) => {
            const selectedSkins = selection[champion] ?? [];
            const selectedSet = new Set(selectedSkins);
            const baseCount = groups.length;
            return (
              <div
                key={champion}
                className="cv-row border-border flex items-start gap-3 border-b px-4 py-3"
              >
                <div className="flex w-32 shrink-0 items-center gap-2.5 pt-0.5">
                  <ChampAvatar championName={champion} />
                  <div className="min-w-0">
                    <p className="text-ink truncate text-xs font-medium">{champion}</p>
                    <p className="text-ink-muted truncate text-[10px]">
                      {baseCount} {baseCount === 1 ? "skin" : "skins"}
                    </p>
                  </div>
                </div>

                <div className="flex min-w-0 flex-1 flex-wrap gap-2">
                  {groups.map((group) => {
                    const baseSelected = selectedSet.has(group.baseSkinName);
                    const selectedChroma = group.chromas.find((c) =>
                      selectedSet.has(c.dl.skin_name)
                    );
                    const anySelected = baseSelected || !!selectedChroma;
                    const baseClickable = !patcherActive && group.base !== null;
                    const baseFav = group.base
                      ? favorites.has(
                          favoriteKey(group.base.champion_name, group.base.skin_name)
                        )
                      : false;

                    const hasChromas = group.chromas.length > 0;
                    return (
                      <div
                        key={group.baseSkinName}
                        className={
                          hasChromas
                            ? "bg-charcoal-500/70 border-charcoal-300/25 rounded-md border p-1.5"
                            : ""
                        }
                      >
                        <div className="relative">
                          <button
                            onClick={() => {
                              if (!baseClickable || !group.base) return;
                              toggleSkin(group.base.champion_name, group.base.skin_name);
                            }}
                            disabled={!baseClickable}
                            className={[
                              "relative h-24 w-32 overflow-hidden rounded transition-all",
                              patcherActive
                                ? "cursor-default opacity-50"
                                : group.base
                                  ? "cursor-pointer"
                                  : "cursor-default",
                              anySelected
                                ? "ring-gold-400 ring-offset-charcoal-400 ring-2 ring-offset-1"
                                : "ring-charcoal-50/20 hover:ring-charcoal-50/40 ring-1",
                              !group.base && "opacity-70",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            title={
                              group.base
                                ? group.baseSkinName
                                : `${group.baseSkinName} (base not downloaded)`
                            }
                          >
                            <SkinThumb championName={champion} skinName={group.baseSkinName} />

                            {baseSelected && (
                              <div className="bg-gold-400 absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full border border-white/30 shadow-sm">
                                <Check size={11} strokeWidth={3} className="text-charcoal-600" />
                              </div>
                            )}
                            {!baseSelected && selectedChroma && (
                              <div
                                className="absolute top-1 right-1 h-5 w-5 rounded-full border-2 border-white shadow-sm"
                                style={{
                                  background: selectedChroma.colors[1]
                                    ? `linear-gradient(135deg, ${selectedChroma.colors[0]} 0% 50%, ${selectedChroma.colors[1]} 50% 100%)`
                                    : (selectedChroma.colors[0] ?? "var(--color-gold-400)"),
                                }}
                                title={`Chroma: ${selectedChroma.dl.skin_name}`}
                              />
                            )}

                            <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 via-black/40 to-transparent px-1.5 pt-4 pb-1">
                              <p className="line-clamp-2 pr-6 text-[10px] leading-tight text-white/90">
                                {group.baseSkinName}
                              </p>
                            </div>
                          </button>

                          {group.base && (
                            <button
                              onClick={() =>
                                onToggleFavorite(
                                  group.base!.champion_name,
                                  group.base!.skin_name
                                )
                              }
                              className="bg-charcoal-500/80 hover:bg-charcoal-500 absolute right-1 bottom-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full shadow transition-colors"
                              title={baseFav ? "Remove from favorites" : "Add to favorites"}
                            >
                              <Star
                                size={11}
                                strokeWidth={2}
                                fill={baseFav ? "currentColor" : "none"}
                                className={baseFav ? "text-gold-400" : "text-white/80"}
                              />
                            </button>
                          )}

                          {!patcherActive && group.base && (
                            <button
                              onClick={() => {
                                const names: string[] = [];
                                if (group.base) names.push(group.base.skin_name);
                                for (const c of group.chromas) names.push(c.dl.skin_name);
                                handleDeleteGroup(champion, names);
                              }}
                              className="bg-charcoal-500 hover:bg-error text-ink-muted absolute top-1 left-1 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full shadow transition-colors hover:text-white"
                              title={
                                group.chromas.length > 0
                                  ? `Delete skin and ${group.chromas.length} chroma${group.chromas.length === 1 ? "" : "s"}`
                                  : "Delete skin"
                              }
                            >
                              <X size={10} strokeWidth={2.5} />
                            </button>
                          )}
                        </div>

                        {group.chromas.length > 0 && (
                          <div className="mt-1 flex w-32 flex-wrap items-start gap-x-1.5 gap-y-1">
                            {group.chromas.map((c) => {
                              const isSel = selectedSet.has(c.dl.skin_name);
                              const isFav = favorites.has(
                                favoriteKey(c.dl.champion_name, c.dl.skin_name)
                              );
                              const bg = c.colors[1]
                                ? `linear-gradient(135deg, ${c.colors[0]} 0% 50%, ${c.colors[1]} 50% 100%)`
                                : (c.colors[0] ?? undefined);
                              return (
                                <div
                                  key={c.dl.skin_name}
                                  className="flex flex-col items-center gap-0.5"
                                >
                                  <button
                                    onClick={() => toggleSkin(c.dl.champion_name, c.dl.skin_name)}
                                    onContextMenu={(e) => {
                                      e.preventDefault();
                                      handleDelete(c.dl.champion_name, c.dl.skin_name);
                                    }}
                                    disabled={patcherActive}
                                    title={`${c.dl.skin_name}\n(right-click to delete)`}
                                    className={[
                                      "ring-offset-charcoal-400 relative h-4 w-4 shrink-0 rounded-sm transition-all",
                                      patcherActive
                                        ? "cursor-default opacity-50"
                                        : "cursor-pointer",
                                      isSel
                                        ? "ring-gold-400 ring-2 ring-offset-1"
                                        : "ring-charcoal-50/30 hover:ring-charcoal-50/60 ring-1",
                                    ].join(" ")}
                                    style={{
                                      background: bg ?? "var(--color-charcoal-300, #3a3a3a)",
                                    }}
                                  >
                                    {isSel && (
                                      <Check
                                        size={9}
                                        strokeWidth={3}
                                        className="absolute inset-0 m-auto text-white drop-shadow"
                                      />
                                    )}
                                  </button>

                                  <button
                                    onClick={() =>
                                      onToggleFavorite(c.dl.champion_name, c.dl.skin_name)
                                    }
                                    className="flex h-3 w-4 cursor-pointer items-center justify-center"
                                    title={
                                      isFav ? "Remove from favorites" : "Add to favorites"
                                    }
                                  >
                                    <Star
                                      size={10}
                                      strokeWidth={2}
                                      fill={isFav ? "currentColor" : "none"}
                                      className={
                                        isFav
                                          ? "text-gold-400"
                                          : "text-ink-muted hover:text-gold-400"
                                      }
                                    />
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
