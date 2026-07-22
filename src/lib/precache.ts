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
type Manifest = {
  /** Tile cache tag this manifest was generated for. precacheTiles refuses a
   *  manifest whose tag differs from TILE_CACHE_TAG — a previous release's
   *  cached manifest must never drive (or verify) this release's precache. */
  tag?: string;
  count: number;
  bytes: number;
  byZoom: Record<string, string[]>;
  /** sha-256 (first 16 hex) per tile path — lets the precacher verify bytes
   *  end-to-end. Behaviourally REQUIRED: a tile without a digest counts as
   *  FAILED (fail closed), so a stale digest-less manifest can never disable
   *  verification. Optional in the type only because old cached manifests
   *  genuinely lack the field. */
  digests?: Record<string, string>;
};

// The Cache Storage bucket the tiles live in. MUST equal TILE_CACHE in
// public/sw.js — the prebuild step fails the build if they diverge. Bump both
// ONLY when the tile pyramid changes, so phones re-pull it.
export const TILE_CACHE_TAG = "solio-tiles-v5";

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
    // Canonical entries only — query-keyed strays from cache-busted fetches
    // must not inflate the count and fake offline-readiness.
    const tiles = keys.filter((k) => {
      const u = new URL(k.url);
      return u.pathname.includes("/tiles/") && !u.search;
    }).length;
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
  // Release-bind the manifest: digests alone are not enough — on a future
  // upgrade a controlling older SW could serve ITS digest-bearing manifest
  // (network-first fetch failed), and the old pyramid would verify cleanly
  // against the old digests. Wrong tag = stale manifest = no precache.
  if (manifest.tag !== TILE_CACHE_TAG) throw new Error("tile manifest is for another release");

  // Low zooms first (whole-reserve overview survives even if z16 gets evicted).
  const urls: string[] = [];
  for (const z of Object.keys(manifest.byZoom).sort((a, b) => Number(a) - Number(b))) {
    for (const u of manifest.byZoom[z]) urls.push(base + u);
  }

  const total = urls.length;
  const cache = await caches.open(TILE_CACHE_TAG);
  let done = 0;
  const report = () => onProgress({ done, total });

  // Expected digest for a tile URL (manifest paths are relative to `base`).
  const expectedDigest = (url: string): string | undefined =>
    manifest.digests?.[url.startsWith(base) ? url.slice(base.length) : url];

  async function sha256hex16(buf: ArrayBuffer): Promise<string> {
    const h = await crypto.subtle.digest("SHA-256", buf);
    return Array.from(new Uint8Array(h))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, 16);
  }

  async function fetchInto(url: string): Promise<boolean> {
    const want = expectedDigest(url);
    // Fail CLOSED: this release ships a digest for every tile. No digest means
    // we are working from a stale manifest (the network-first manifest fetch
    // failed and a previous SW generation served its cached copy) — verifying
    // nothing would silently reopen the stale-tile-promotion hole, so the tile
    // counts as FAILED and the pyramid is not marked saved.
    if (!want) return false;
    // Already cached (previous partial run / panned-over tile): trust it only
    // if the bytes match this release's digest — the service worker's
    // older-cache fallback means a same-URL hit can be a previous generation.
    const hit = await cache.match(url);
    if (hit) {
      if ((await sha256hex16(await hit.clone().arrayBuffer())) === want) return true;
      await cache.delete(url);
    }
    // First try the plain URL; if the bytes are stale (an older SW generation
    // answered from its cache), retry with a cache-busting query no SW cache
    // can hold — the nonce makes every retry URL unique, so a bad response a
    // SW cached under an earlier busted URL can never satisfy a later attempt.
    // Always store under the canonical URL so runtime lookups hit.
    const nonce = () =>
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    for (const attempt of [url, `${url}?v=${want}&r=${nonce()}`]) {
      const resp = await fetch(attempt, { cache: "no-cache", signal });
      const type = resp.headers.get("content-type") || "";
      // Only a real image may enter the cache — an SPA-fallback/error page that
      // returns 200 text/html must count as a FAILURE, not a saved tile.
      if (!resp.ok || !type.startsWith("image/")) return false;
      const buf = await resp.arrayBuffer();
      if ((await sha256hex16(buf)) !== want) continue; // stale bytes
      await cache.put(url, new Response(buf, { headers: { "content-type": type } }));
      return true;
    }
    return false;
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

  // Abort-aware sleep: an abort mid-backoff must end the run promptly, not
  // after the timer expires.
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });

  let pending = urls;
  for (let attempt = 0; attempt < 3 && pending.length > 0; attempt++) {
    if (signal?.aborted) break;
    if (attempt > 0) await sleep(1500 * attempt);
    pending = await pass(pending);
  }

  if (signal?.aborted) return { saved: false, aborted: true, done, total };
  if (pending.length > 0) return { saved: false, aborted: false, done, total };

  // Belt and braces: the flag is only persisted if Cache Storage holds every
  // CANONICAL tile of this release. Checking the expected URL set (not a key
  // count) means query-keyed strays a service worker wrote for cache-busted
  // fetches can never mask a missing canonical entry. Abort is honoured here
  // too — the contract is "abort stops promptly", including this scan.
  for (const url of urls) {
    if (signal?.aborted) return { saved: false, aborted: true, done, total };
    if (!(await cache.match(url))) return { saved: false, aborted: false, done, total };
  }
  // The last match() above may have resolved after an abort — honour it before
  // persisting the flag, or a cancelled run can still report saved: true.
  if (signal?.aborted) return { saved: false, aborted: true, done, total };

  report();
  markCached(total);
  await cleanupOldTileCaches();
  return { saved: true, aborted: false, done: total, total };
}
