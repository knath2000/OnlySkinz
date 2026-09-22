import { useState } from "react";
import { splashUrl, findChampionByName, championAvatar } from "../hooks/useChampions";
import { lookupSplashNum } from "../hooks/useSkinData";

export function SkinThumb({ championName, skinName }: { championName: string; skinName: string }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const champ = findChampionByName(championName);
  const num = lookupSplashNum(skinName);

  if (!champ || num === null || failed) {
    return <div className="bg-charcoal-600 h-full w-full" />;
  }

  return (
    <>
      {!loaded && (
        <div className="from-charcoal-600 via-charcoal-400 to-charcoal-600 animate-shimmer absolute inset-0 bg-linear-to-r bg-size-[200%_100%]" />
      )}
      <img
        src={splashUrl(champ.id, num)}
        alt={skinName}
        className={[
          "h-full w-full object-cover object-[center_20%]",
          loaded ? "opacity-100" : "opacity-0",
        ].join(" ")}
        loading="lazy"
        draggable={false}
        onLoad={() => setLoaded(true)}
        onError={() => setFailed(true)}
      />
    </>
  );
}

export function ChampAvatar({ championName }: { championName: string }) {
  const [failed, setFailed] = useState(false);
  const champ = findChampionByName(championName);

  if (!champ || failed) {
    return (
      <div className="bg-charcoal-500 text-ink-muted flex h-8 w-8 items-center justify-center rounded text-[10px]">
        {championName.charAt(0)}
      </div>
    );
  }

  return (
    <img
      src={championAvatar(champ.id)}
      alt={championName}
      className="h-8 w-8 rounded object-cover"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}
