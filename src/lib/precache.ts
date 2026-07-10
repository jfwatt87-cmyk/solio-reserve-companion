/* Proactive offline tile precache.
 *
 * Phase 1's headline promise is "works with no signal". The service worker caches
 * tiles as they're viewed, but a guest who scans at the gate (signal) and drives
 * into a dead zone only has the tiles they happened to pan across. The whole
 * pyramid is ~12 MB — small enough to pull down in the background after first
 * load, so the entire reserve is available offline.
 *
 * Honesty contract: "saved" is only ever declared after every tile fetch
 * SUCCEEDED (failures are retried, then reported) AND Cache Storage actually
 * contains the pyramid. A guest must never see "works offline" over a cache
 * with holes.
 */

export type PrecacheProgress = { done: number; total: number };
export type PrecacheResult = {
  /** Every tile is verified present in Cache Storage. */
  saved: boolean;
  /** The run was cancelled via the AbortSignal (saved is false). */
  aborted: boolean;
  done: number;
  total: number;
};
type Manifest = { count: number; bytes: number; byZoom: Record<string, string[]> };

// The Cache Storage bucket the tiles live in. MUST equal TILE_CACHE in
// public/sw.js — the prebuild step fails the build if they diverge. Bump both
// ONLY when the tile pyramid changes, so phones re-pull it.
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
 * Pull the whole tile pyramid into Cache Storage, writing each verified image
 * response into TILE_CACHE ourselves (we do not rely on the service worker's
 * fetch handler for correctness — it merely also serves these entries later).
 *
 * - Failed tiles are queued and retried (2 extra passes) before giving up.
 * - `saved: true` (and the persistent flag) only after zero outstanding
 *   failures AND a Cache Storage count check.
 * - Abort stops promptly (the signal is passed to fetch) and reports
 *   `aborted: true`; the caller decides how to resume.
 * - Never throws for per-tile problems; throws only if the manifest itself is
 *   unavailable or Cache Storage is unusable.
 */
export async function precacheTiles(
  base: string,
  onProgress: (p: PrecacheProgress) => void,
  signal?: AbortSignal,
): Promise<PrecacheResult> {
  const res = await fetch(base + "tiles-manifest.json", { cache: "no-cache", signal });
  if (!res.ok) throw new Error("tile manifest unavailable");
  const manifest = (await res.json()) as Manifest;

  // Low zooms first (whole-reserve overview survives even if z16 gets evicted).
  const urls: string[] = [];
  for (const z of Object.keys(manifest.byZoom).sort((a, b) => Number(a) - Number(b))) {
    for (const u of manifest.byZoom[z]) urls.push(base + u);
  }

  const total = urls.length;
  const cache = await caches.open(TILE_CACHE_TAG);
  let done = 0;
  const report = () => onProgress({ done, total });

  async function fetchInto(url: string): Promise<boolean> {
    // Already cached (previous partial run / panned-over tile): count it, skip.
    if (await cache.match(url)) return true;
    const resp = await fetch(url, { cache: "no-cache", signal });
    const type = resp.headers.get("content-type") || "";
    // Only a real image may enter the cache — an SPA-fallback/error page that
    // returns 200 text/html must count as a FAILURE, not a saved tile.
    if (!resp.ok || !type.startsWith("image/")) return false;
    await cache.put(url, resp);
    return true;
  }

  async function pass(list: string[]): Promise<string[]> {
    const failed: string[] = [];
    let cursor = 0;
    const CONCURRENCY = 6;
    async function worker() {
      while (cursor < list.length) {
        if (signal?.aborted) return;
        const url = list[cursor++];
        let ok = false;
        try {
          ok = await fetchInto(url);
        } catch (err) {
          if ((err as Error).name === "AbortError") return;
          ok = false;
        }
        if (ok) {
          done++;
          if (done % 15 === 0 || done === total) report();
        } else {
          failed.push(url);
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    return failed;
  }

  let pending = urls;
  for (let attempt = 0; attempt < 3 && pending.length > 0; attempt++) {
    if (signal?.aborted) break;
    if (attempt > 0) await new Promise((r) => setTimeout(r, 1500 * attempt));
    pending = await pass(pending);
  }

  if (signal?.aborted) return { saved: false, aborted: true, done, total };
  if (pending.length > 0) return { saved: false, aborted: false, done, total };

  // Belt and braces: the flag is only persisted if Cache Storage really holds
  // the pyramid (>= because the manifest itself may share the cache).
  const keys = await cache.keys();
  const tileKeys = keys.filter((k) => new URL(k.url).pathname.includes("/tiles/")).length;
  if (tileKeys < total) return { saved: false, aborted: false, done, total };

  report();
  saveSample(urls);
  markCached();
  return { saved: true, aborted: false, done: total, total };
}
