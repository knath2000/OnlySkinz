import { useState, useEffect, useMemo } from "react";
import { Star, Check, Search } from "lucide-react";
import { lookupChromaInfo, ensureChromaInfo } from "../hooks/useSkinData";
import { useCatalogVersion } from "../lib/catalog";
import { SkinThumb, ChampAvatar } from "./SkinMedia";
import { parseFavoriteKey } from "../lib/favorites";
import type { DownloadedSkin, SkinSelection } from "../types";

function useChromaReady(): boolean {
  // Re-resolve chroma info when the catalog is refreshed.
  const version = useCatalogVersion();
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
  }, [version]);
  return ready;
}

interface FavoritesProps {
  downloads: DownloadedSkin[];
  patcherActive: boolean;
  selection: SkinSelection;
  onSelectionChange: (selection: SkinSelection) => void;
  favorites: Set<string>;
  onToggleFavorite: (championName: string, skinName: string) => void;
}

export default function Favorites({
  downloads,
  patcherActive,
  selection,
  onSelectionChange,
  favorites,
  onToggleFavorite,
}: FavoritesProps) {
  const chromaReady = useChromaReady();
  const [search, setSearch] = useState("");

  const toggleSelect = (championName: string, skinName: string) => {
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

  const entries = useMemo(() => {
    void chromaReady; // re-render once Community Dragon chroma data lands
    return [...favorites]
      .map((key) => {
        const { championName, skinName } = parseFavoriteKey(key);
        const dl =
          downloads.find((d) => d.champion_name === championName && d.skin_name === skinName) ??
          null;
        return { key, championName, skinName, dl, chroma: lookupChromaInfo(skinName) };
      })
      .sort(
        (a, b) =>
          a.championName.localeCompare(b.championName) || a.skinName.localeCompare(b.skinName)
      );
  }, [favorites, downloads, chromaReady]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return entries;
    return entries.filter(
      (e) =>
        e.championName.toLowerCase().includes(query) || e.skinName.toLowerCase().includes(query)
    );
  }, [entries, search]);

  if (entries.length === 0) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-border flex shrink-0 items-center border-b px-4 py-3">
          <span className="text-ink-muted text-sm select-none">0 favorites</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="bg-charcoal-300 flex h-12 w-12 items-center justify-center rounded-full">
            <Star size={20} strokeWidth={1.5} className="text-ink-muted" />
          </div>
          <div>
            <p className="text-ink-secondary text-sm">No favorites yet</p>
            <p className="text-ink-muted mt-1 text-xs">Star skins in My Skins to pin them here</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <span className="text-ink-muted text-sm tabular-nums select-none">
          {entries.length} {entries.length === 1 ? "favorite" : "favorites"}
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
            placeholder="Filter favorites"
            className="bg-charcoal-500 border-border text-ink placeholder:text-ink-muted focus:border-gold-500/60 w-full rounded-sm border py-1.5 pr-3 pl-8 text-sm transition-colors focus:outline-none"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="text-ink-muted flex h-32 items-center justify-center text-sm">
            No favorites match "{search}"
          </div>
        )}

        <div className="flex flex-col">
          {filtered.map(({ key, championName, skinName, dl, chroma }) => {
            const isSelected = (selection[championName] ?? []).includes(skinName);
            const swatch = chroma
              ? chroma.colors[1]
                ? `linear-gradient(135deg, ${chroma.colors[0]} 0% 50%, ${chroma.colors[1]} 50% 100%)`
                : chroma.colors[0]
              : undefined;

            return (
              <div
                key={key}
                className="cv-row border-border flex items-center gap-3 border-b px-4 py-3"
              >
                <div className="flex w-40 shrink-0 items-center gap-2.5">
                  <ChampAvatar championName={championName} />
                  <div className="min-w-0">
                    <p className="text-ink truncate text-xs font-medium">{championName}</p>
                    <p className="text-ink-muted truncate text-[10px]">
                      {chroma ? "Chroma" : "Skin"}
                    </p>
                  </div>
                </div>

                <div
                  className={[
                    "ring-offset-charcoal-400 relative h-24 w-32 shrink-0 overflow-hidden rounded ring-2 ring-offset-1",
                    isSelected ? "ring-gold-400" : "ring-charcoal-50/20",
                    !dl && "opacity-50",
                  ].join(" ")}
                >
                  <SkinThumb championName={championName} skinName={skinName} />

                  {isSelected && (
                    <div className="bg-gold-400 absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full border border-white/30 shadow-sm">
                      <Check size={11} strokeWidth={3} className="text-charcoal-600" />
                    </div>
                  )}

                  <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 via-black/40 to-transparent px-1.5 pt-4 pb-1">
                    <p className="line-clamp-2 text-[10px] leading-tight text-white/90">
                      {skinName}
                    </p>
                  </div>
                </div>

                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <div className="flex items-center gap-2">
                    {chroma && swatch && (
                      <span
                        className="ring-charcoal-50/30 inline-block h-4 w-4 shrink-0 rounded-sm ring-1"
                        style={{ background: swatch }}
                        title={skinName}
                      />
                    )}
                    <span className="text-ink truncate text-sm">{skinName}</span>
                  </div>

                  {!dl && (
                    <span className="text-ink-muted text-[11px]">
                      Not downloaded — download it again to apply
                    </span>
                  )}

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => toggleSelect(championName, skinName)}
                      disabled={patcherActive || !dl}
                      className={[
                        "flex w-fit cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-30",
                        isSelected
                          ? "border-gold-400/40 text-gold-400 hover:border-gold-400"
                          : "border-border text-ink-secondary hover:text-ink hover:border-ink-muted",
                      ].join(" ")}
                    >
                      <Check size={12} strokeWidth={2} />
                      {isSelected ? "Selected" : "Select"}
                    </button>

                    <button
                      onClick={() => onToggleFavorite(championName, skinName)}
                      className="border-border text-ink-secondary hover:border-gold-400 hover:text-gold-400 flex w-fit cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors"
                    >
                      <Star
                        size={12}
                        strokeWidth={2}
                        fill="currentColor"
                        className="text-gold-400"
                      />
                      Unfavorite
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
