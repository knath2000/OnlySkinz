const FAVORITES_KEY = "onlyskinz_favorites";

/// Stable identity for a favorited skin. Champion names never contain "/", so
/// the first slash separates the champion from the skin name.
export function favoriteKey(championName: string, skinName: string): string {
  return `${championName}/${skinName}`;
}

export function parseFavoriteKey(key: string): { championName: string; skinName: string } {
  const slash = key.indexOf("/");
  if (slash < 0) return { championName: key, skinName: "" };
  return {
    championName: key.slice(0, slash),
    skinName: key.slice(slash + 1),
  };
}

export function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((v): v is string => typeof v === "string"));
  } catch {
    return new Set();
  }
}

export function saveFavorites(favorites: Set<string>): void {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...favorites]));
}