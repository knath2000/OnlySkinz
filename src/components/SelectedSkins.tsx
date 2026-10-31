import { useState, useEffect, useMemo } from "react";
import { Layers, Check, X } from "lucide-react";
import { lookupChromaInfo, ensureChromaInfo, ensureSkinIds } from "../hooks/useSkinData";
import { useCatalogVersion } from "../lib/catalog";
import { SkinThumb, ChampAvatar } from "./SkinMedia";
import type { DownloadedSkin, SkinSelection } from "../types";

interface SelectedSkinsProps {
  downloads: DownloadedSkin[];
  patcherActive: boolean;
  selection: SkinSelection;
  onSelectionChange: (selection: SkinSelection) => void;
}

function useChromaReady(): boolean {
  // Re-resolve chroma info when the catalog is refreshed.
  const version = useCatalogVersion();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancelled = false;
    // lookupChromaInfo needs both the skin-id index and the chroma map.
    Promise.all([ensureSkinIds(), ensureChromaInfo()])
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

export default function SelectedSkins({
  downloads,
  patcherActive,
  selection,
  onSelectionChange,
}: SelectedSkinsProps) {
  const chromaReady = useChromaReady();
  const [search, setSearch] = useState("");

  const deselect = (championName: string, skinName: string) => {
    if (patcherActive) return;
    const remaining = (selection[championName] ?? []).filter((n) => n !== skinName);
    const next = { ...selection };
    if (remaining.length > 0) next[championName] = remaining;
    else delete next[championName];
    onSelectionChange(next);
  };

  const clearAll = () => {
    if (patcherActive) return;
    onSelectionChange({});
  };

  const entries = useMemo(() => {
    void chromaReady; // re-render once Community Dragon chroma data lands
    const out: {
      championName: string;
      skinName: string;
      dl: DownloadedSkin | null;
      chroma: ReturnType<typeof lookupChromaInfo>;
    }[] = [];
    for (const [championName, skinNames] of Object.entries(selection)) {
      for (const skinName of skinNames) {
        const dl =
          downloads.find((d) => d.champion_name === championName && d.skin_name === skinName) ??
          null;
        out.push({ championName, skinName, dl, chroma: lookupChromaInfo(skinName) });
      }
    }
    return out;
  }, [selection, downloads, chromaReady]);

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
          <span className="text-ink-muted text-sm select-none">0 selected</span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div className="bg-charcoal-300 flex h-12 w-12 items-center justify-center rounded-full">
            <Layers size={20} strokeWidth={1.5} className="text-ink-muted" />
          </div>
          <div>
            <p className="text-ink-secondary text-sm">No skins selected yet</p>
            <p className="text-ink-muted mt-1 text-xs">Pick skins in My Skins to see them here</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="border-border flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <span className="text-ink-muted text-sm tabular-nums select-none">
          {entries.length} selected
        </span>

        <div className="relative max-w-64 flex-1">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter selection"
            className="bg-charcoal-500 border-border text-ink placeholder:text-ink-muted focus:border-gold-500/60 w-full rounded-sm border px-3 py-1.5 text-sm transition-colors focus:outline-none"
          />
        </div>

        <button
          onClick={clearAll}
          disabled={patcherActive}
          className="border-border text-ink-secondary hover:text-error hover:border-error/40 ml-auto flex cursor-pointer items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition-colors disabled:pointer-events-none disabled:opacity-30"
        >
          <X size={13} strokeWidth={2} />
          Clear all
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 && (
          <div className="text-ink-muted flex h-32 items-center justify-center text-sm">
            No selections match "{search}"
          </div>
        )}

        <div className="flex flex-col">
          {filtered.map(({ championName, skinName, dl, chroma }) => {
            const swatch = chroma
              ? chroma.colors[1]
                ? `linear-gradient(135deg, ${chroma.colors[0]} 0% 50%, ${chroma.colors[1]} 50% 100%)`
                : chroma.colors[0]
              : undefined;

            return (
              <div
                key={`${championName}::${skinName}`}
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

                <div className="ring-gold-400 ring-offset-charcoal-400 relative h-24 w-32 shrink-0 overflow-hidden rounded ring-2 ring-offset-1">
                  <SkinThumb championName={championName} skinName={skinName} />

                  <div className="bg-gold-400 absolute top-1 right-1 flex h-5 w-5 items-center justify-center rounded-full border border-white/30 shadow-sm">
                    <Check size={11} strokeWidth={3} className="text-charcoal-600" />
                  </div>

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
                      Not downloaded — deselect or download it again
                    </span>
                  )}

                  <button
                    onClick={() => deselect(championName, skinName)}
                    disabled={patcherActive}
                    className="border-border text-ink-secondary hover:text-error hover:border-error/40 flex w-fit cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors disabled:pointer-events-none disabled:opacity-30"
                  >
                    <X size={12} strokeWidth={2} />
                    Deselect
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
