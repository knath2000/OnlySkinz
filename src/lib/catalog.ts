import { useSyncExternalStore } from "react";

type Listener = () => void;

const listeners = new Set<Listener>();
let version = 0;

/** Subscribe to catalog refreshes. Returns an unsubscribe function. */
export function subscribeCatalog(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number {
  return version;
}

/**
 * Notify subscribers that the catalog changed. Bumps the version counter, so
 * every `useCatalogVersion()` consumer re-renders against the new data.
 */
export function notifyCatalog(): void {
  version += 1;
  for (const listener of listeners) listener();
}

/** Re-renders the calling component whenever the catalog is refreshed. */
export function useCatalogVersion(): number {
  return useSyncExternalStore(subscribeCatalog, getSnapshot, getSnapshot);
}
