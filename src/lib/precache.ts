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

const CACHED_KEY = "solio-tiles-cached";
// A handful of tile URLs saved at cache-completion time so we can later verify,
// even offline, that the Cache Storage entries still exist (iOS can evict them
// under storage pressure while leaving this flag behind — see verifyTilesCached).
const SAMPLE_KEY = "solio-tiles-sample";

/** True once the full pyramid has been pulled for the current tile version. */
export function tilesAlreadyCached(): boolean {
  try {
    return localStorage.getItem(CACHED_KEY) === TILE_CACHE_TAG;
  } catch {
    return false;
  }
}

function markCached() {
  try {
    localStorage.setItem(CACHED_KEY, TILE_CACHE_TAG);
  } catch {
    /* private mode / storage disabled — harmless, we just re-run next visit */
  }
}

/** Forget the "saved" flag so the next check re-pulls the pyramid. */
export function invalidateTileCache() {
  try {
    localStorage.removeItem(CACHED_KEY);
    localStorage.removeItem(SAMPLE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** Persist a spread of tile URLs to probe later (low + high zoom). */
function saveSample(urls: string[]) {
  const n = Math.min(10, urls.length);
  const step = Math.max(1, Math.floor(urls.length / n));
  const sample: string[] = [];
  for (let i = 0; i < urls.length && sample.length < n; i += step) sample.push(urls[i]);
  // always include the very last (highest-zoom) tile — the first to be evicted
  if (urls.length) sample[sample.length - 1] = urls[urls.length - 1];
  try {
    localStorage.setItem(SAMPLE_KEY, JSON.stringify(sample));
  } catch {
    /* storage disabled — verification just trusts the flag */
  }
}

/**
 * Confirm the saved tiles are STILL in Cache Storage. iOS may evict the cache
 * under storage pressure without touching this localStorage flag, so a naive
 * "saved" flag can lie. We probe a stored sample of tile URLs (works offline —
 * Cache Storage is local). Returns true if the map can be trusted offline.
 *
 * Conservative: if we can't check (no Cache API / no sample / probe error) we
 * return true rather than needlessly nuke a good cache.
 */
export async function verifyTilesCached(): Promise<boolean> {
  if (!tilesAlreadyCached()) return false;
  if (typeof caches === "undefined") return true;
  let sample: string[] = [];
  try {
    sample = JSON.parse(localStorage.getItem(SAMPLE_KEY) || "[]");
  } catch {
    return true;
  }
  if (!Array.isArray(sample) || sample.length === 0) return true;
  try {
    for (const url of sample) {
      const hit = await caches.match(url);
      if (!hit) return false;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Ask the browser to mark this origin's storage persistent, which exempts it
 * from eviction. WebKit grants this heuristically, favouring Home Screen web
 * apps. Best-effort — the result is advisory, never block on it.
 */
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
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
    saveSample(urls);
    markCached();
  }
}
