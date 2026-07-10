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
// Expected tile count, stored at save time so verification can compare the
// NAMED cache's contents against the full pyramid — even offline.
const COUNT_KEY = "solio-tiles-count";

/** True once the full pyramid has been pulled for the current tile version. */
export function tilesAlreadyCached(): boolean {
  try {
    return localStorage.getItem(CACHED_KEY) === TILE_CACHE_TAG;
  } catch {
    return false;
  }
}

function markCached(count: number) {
  try {
    localStorage.setItem(CACHED_KEY, TILE_CACHE_TAG);
    localStorage.setItem(COUNT_KEY, String(count));
  } catch {
    /* private mode / storage disabled — harmless, we just re-run next visit */
  }
}

/** Forget the "saved" flag so the next check re-pulls the pyramid. */
export function invalidateTileCache() {
  try {
    localStorage.removeItem(CACHED_KEY);
    localStorage.removeItem(COUNT_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Confirm the saved tiles are STILL in Cache Storage. iOS may evict the cache
 * under storage pressure without touching the localStorage flag, so a naive
 * "saved" flag can lie. We count the tiles actually present in the NAMED tile
 * cache against the full expected pyramid (works offline — Cache Storage is
 * local).
 *
 * FAIL CLOSED (audit 2026-07-10): if we can't check, or the count falls
 * short, report false — an honest "map not saved, re-download" beats a guest
 * discovering a dead map in the reserve. The re-download is cheap when the
 * cache is actually fine: already-cached tiles are counted, not re-fetched.
 */
export async function verifyTilesCached(): Promise<boolean> {
  if (!tilesAlreadyCached()) return false;
  if (typeof caches === "undefined") return false;
  try {
    const cache = await caches.open(TILE_CACHE_TAG);
    let expected = 0;
    try {
      expected = Number(localStorage.getItem(COUNT_KEY) || "0");
    } catch {
      expected = 0;
    }
    if (!expected) {
      // Upgrading install (flag predates COUNT_KEY): trust the cached
      // manifest's count — still offline-capable.
      const m = await cache.match("tiles-manifest.json").catch(() => null);
      const mm = m ?? (await caches.match("tiles-manifest.json").catch(() => null));
      if (!mm) return false;
      expected = ((await mm.clone().json()) as Manifest).count;
      if (!expected) return false;
    }
    const keys = await cache.keys();
    const tiles = keys.filter((k) => new URL(k.url).pathname.includes("/tiles/")).length;
    return tiles >= expected;
  } catch {
    return false;
  }
}

/**
 * Retire superseded tile caches. The service worker's activate step
 * deliberately KEEPS old solio-tiles-* caches so a mid-upgrade guest still
 * has a working map; they are deleted here, only after the new pyramid is
 * fully saved and verified.
 */
async function cleanupOldTileCaches() {
  try {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith("solio-tiles-") && k !== TILE_CACHE_TAG)
        .map((k) => caches.delete(k)),
    );
  } catch {
    /* old caches linger harmlessly until the next successful save */
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
  markCached(total);
  await cleanupOldTileCaches();
  return { saved: true, aborted: false, done: total, total };
}
