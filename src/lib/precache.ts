/* Proactive offline tile precache.
 *
 * Phase 1's headline promise is "works with no signal". The service worker caches
 * tiles as they're viewed, but a guest who scans at the gate (signal) and drives
 * into a dead zone only has the tiles they happened to pan across. The whole
 * pyramid is ~14 MB — small enough to pull down in the background after first
 * load, so the entire reserve is available offline.
 *
 * Mechanism: we simply fetch() each tile from the page. The service worker's
 * fetch handler intercepts same-origin GETs and puts them in its cache, so a
 * plain fetch loop populates the offline store with no SW messaging. Low zooms
 * come first; the heavy z16 layer is best-effort, so an iOS cache-quota eviction
 * still leaves usable coverage (the spec's z11–14 fallback).
 */

export type PrecacheProgress = { done: number; total: number };
type Manifest = { count: number; bytes: number; byZoom: Record<string, string[]> };

// Bump alongside sw.js CACHE when the tiles change, so phones re-pull the pyramid.
export const TILE_CACHE_TAG = "solio-tiles-v4";

/** True once the full pyramid has been pulled for the current tile version. */
export function tilesAlreadyCached(): boolean {
  try {
    return localStorage.getItem("solio-tiles-cached") === TILE_CACHE_TAG;
  } catch {
    return false;
  }
}

function markCached() {
  try {
    localStorage.setItem("solio-tiles-cached", TILE_CACHE_TAG);
  } catch {
    /* private mode / storage disabled — harmless, we just re-run next visit */
  }
}

/**
 * Pull the whole tile pyramid into the SW cache. Resolves when every tile has
 * been attempted (failures are swallowed — a missing tile must never break the
 * app). `onProgress` fires roughly every 15 tiles. Aborts cleanly via `signal`.
 */
export async function precacheTiles(
  base: string,
  onProgress: (p: PrecacheProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(base + "tiles-manifest.json", { cache: "no-cache" });
  if (!res.ok) throw new Error("tile manifest unavailable");
  const manifest = (await res.json()) as Manifest;

  // Low zooms first (whole-reserve overview survives even if z16 gets evicted).
  const urls: string[] = [];
  for (const z of Object.keys(manifest.byZoom).sort((a, b) => Number(a) - Number(b))) {
    for (const u of manifest.byZoom[z]) urls.push(base + u);
  }

  const total = urls.length;
  let done = 0;
  let cursor = 0;
  const CONCURRENCY = 6;

  async function worker() {
    while (cursor < urls.length) {
      if (signal?.aborted) return;
      const url = urls[cursor++];
      try {
        await fetch(url); // SW intercepts + caches; response body ignored
      } catch {
        /* offline / transient — skip, the on-view handler catches it later */
      }
      done++;
      if (done % 15 === 0 || done === total) onProgress({ done, total });
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  if (!signal?.aborted) {
    onProgress({ done: total, total });
    markCached();
  }
}
