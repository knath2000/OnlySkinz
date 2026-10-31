# Skin Catalog Auto-Update and Refresh

Session date: 2026-10-30

How OnlySkinz discovers new League of Legends champions and skins, and what was
changed so they show up automatically instead of waiting on a 24h cache and an
app restart.

## The problem

The app bundles **no skin catalog**. Every champion, skin, and chroma is fetched
at runtime from external network sources and cached in `localStorage` (24h TTL)
plus **module-level in-memory caches that never expired for the life of the
session**. There was also no way for a user to force a refresh.

That meant:

- A **new champion** appeared automatically (the champion list comes live from
  Riot DDragon), but only after the 24h cache expired and the app restarted.
- A **new skin** appeared only if the third-party repo
  [`Alban1911/LeagueSkins`](https://github.com/Alban1911/LeagueSkins) had been
  updated with both a `skin_ids.json` entry and the matching `.fantome` file —
  and again only after the 24h cache expired plus a restart.

## Data sources

| What | Source | Code |
|------|--------|------|
| Champion list | Riot DDragon `versions.json` → `cdn/{ver}/data/en_US/champion.json` | `src/hooks/useChampions.ts` |
| Skin IDs (the catalog) | `Alban1911/LeagueSkins` → `resources/en/skin_ids.json` | `src/hooks/useSkinData.ts` |
| Download availability | GitHub tree API for that repo, scanning `skins/**/*.fantome` \| `.zip` | `src/hooks/useSkinData.ts` |
| Chroma info | CommunityDragon `.../v1/skins.json` | `src/hooks/useSkinData.ts` |
| Splash / avatar art | DDragon CDN | `src/hooks/useChampions.ts` |

The app does **not** enumerate skins from Riot's own data. `getSkinsForChampion`
builds the skin list from `skin_ids.json`, and a skin is only downloadable if a
matching `.fantome`/`.zip` exists in the community repo. The app version is
irrelevant to new skins — it only matters for injector compatibility
(`mod-tools` `wad_verify`), because nothing about skins is bundled.

## Change 1 — CommunityDragon fallback enumeration

`ensureSkinCatalog()` (`src/hooks/useSkinData.ts`) builds a per-champion
`[id, name][]` index from CommunityDragon `v1/skins.json`, including nested
chromas and skipping the default skin (num 0) and its chromas — the same rules
`getSkinsForChampion` already applied.

`getSkinsForChampion` **tops up** the repo entries with CommunityDragon IDs the
repo doesn't list yet. Repo names win (so existing downloads and selections keep
resolving); CD-only skins have no repo file, so they render as the existing
greyed **"Not available"** card until the repo catches up.

- Cached under `onlyskinz:cd_catalog_v1` (6h TTL) with a `getStale` fallback.
- A shared `fetchCdSkins()` promise means chroma info and the fallback catalog
  download the (~6 MB) `skins.json` only once.

**Verified 2026-10-30:** the CommunityDragon catalog is currently a *strict
subset* of the repo (entries in CD but not repo = 0), so this is a pure safety
net that activates only during the window where the repo lags a new release.

## Change 2 — Cache revalidation and manual refresh

### TTLs

`src/lib/cache.ts` gains `getCacheAge()` and `CATALOG_TTL` (6h). Champions,
skin IDs, and chromas now revalidate on the 6h TTL. The **rate-limited** GitHub
repo tree keeps the 24h default (unauthenticated GitHub API allows 60 req/hr).

### Pub/sub

`src/lib/catalog.ts` (new) is a tiny store: `subscribeCatalog()`,
`notifyCatalog()`, and `useCatalogVersion()` (via React's
`useSyncExternalStore`). Components that read module caches re-render when the
catalog is refreshed.

### Forced refresh

Every loader (`ensureChampions`, `ensureSkinIds`, `ensureRepoZips`,
`ensureChromaInfo`, `ensureSkinCatalog`) accepts a `force` flag that bypasses all
caches. `refreshCatalog()` calls them all with `force`, using `Promise.allSettled`
so one failure doesn't block the rest, then calls `notifyCatalog()`. An in-flight
guard dedupes overlapping refreshes.

### Failure safety

A refresh **never deletes the persisted cache first**. Each loader falls back to
`getStale()` on error, so a failed refresh (offline, GitHub rate limit) keeps the
previous data instead of emptying the app. (An early implementation removed the
cache before refetching; that would have wiped the repo tree on a failed
refresh — fixed before shipping.)

### When refreshes happen

- On app launch: expired caches refetch via the normal loaders.
- Every 30 minutes and on window focus, TTL-gated, so at most ~one refresh per
  6h and a bounded number of repo API calls (`src/App.tsx`).
- On demand: **Settings → Skin Catalog → Refresh** (`src/components/Settings.tsx`),
  which also shows a relative "Updated Xh ago" label via `getCatalogAgeMs()`.

## Files

- `src/hooks/useSkinData.ts` — fallback catalog, `force` loaders,
  `refreshCatalog`, `getCatalogAgeMs`.
- `src/hooks/useChampions.ts` — `force` loader, catalog-version reactivity.
- `src/lib/cache.ts` — `CATALOG_TTL`, `getCacheAge`.
- `src/lib/catalog.ts` — new pub/sub + `useCatalogVersion`.
- `src/App.tsx` — preload `ensureSkinCatalog`, revalidation interval + focus.
- `src/components/Settings.tsx` — Skin Catalog refresh section.
- `src/components/{MySkins,Favorites,SelectedSkins}.tsx` — re-resolve chroma info
  on refresh.

## Verification

- `npx tsc --noEmit` clean.
- `npm run build` (`tsc && vite build`) passes.

## Edge cases

- **Repo is a superset of CD** → the fallback adds nothing in steady state, so
  there is no behavioural change until a new skin lands.
- **CD-only skin** → visible but not downloadable; no download button, no broken
  URL.
- **New champion with no repo entries** → the local folder name falls back to the
  DDragon champion name (existing behaviour).
- **Failed refresh** → previous persisted data is retained.
- **Offline / rate-limited** → stale data is served, silently.

## Net effect

New champions appear automatically from DDragon. New skins become **visible** as
soon as CommunityDragon has them (even before the community repo), become
**downloadable** once the repo ships the `.fantome`, and are picked up
automatically within 6h — or instantly via the Refresh button / focus
revalidation — instead of needing a 24h wait plus a restart.
