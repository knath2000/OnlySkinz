const DEFAULT_TTL = 24 * 60 * 60 * 1000; // 24 hours
// Catalog metadata (champions, skin ids, chromas) changes when Riot ships a
// patch, so it is revalidated more aggressively than the rate-limited repo tree.
export const CATALOG_TTL = 6 * 60 * 60 * 1000; // 6 hours

interface CacheEntry<T> {
  data: T;
  timestamp: number;
}

export function getCached<T>(key: string, ttl = DEFAULT_TTL): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    // Keep expired entries so getStale() can serve them as a fallback when
    // the network is down or rate-limited.
    if (Date.now() - entry.timestamp > ttl) return null;
    return entry.data;
  } catch {
    return null;
  }
}

/** Returns cached data regardless of age. Use as a fallback when a fetch fails. */
export function getStale<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry: CacheEntry<T> = JSON.parse(raw);
    return entry.data;
  } catch {
    return null;
  }
}

export function setCache<T>(key: string, data: T): void {
  try {
    const entry: CacheEntry<T> = { data, timestamp: Date.now() };
    localStorage.setItem(key, JSON.stringify(entry));
  } catch {
    // localStorage full or unavailable - ignore
  }
}

/** Age of a cache entry in ms, or null if absent/unreadable. Ignores TTL. */
export function getCacheAge(key: string): number | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry: CacheEntry<unknown> = JSON.parse(raw);
    return Date.now() - entry.timestamp;
  } catch {
    return null;
  }
}
