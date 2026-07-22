/* Solio Reserve Companion — offline service worker.

   TWO cache families with independent lifetimes:
   - SHELL_CACHE: the app itself (index.html, manifest, icons). Bump per release.
   - TILE_CACHE:  the ~12 MB basemap tile pyramid + tiles-manifest.json. Bump ONLY
     when the tile pyramid itself changes. Must equal TILE_CACHE_TAG in
     src/lib/precache.ts — the prebuild step (tools/gen-tile-manifest.mjs) fails
     the build if they ever diverge, and fails if tile bytes change without a bump.

   Staged tile upgrades (audit 2026-07-10): activate NEVER deletes an old
   solio-tiles-* cache — a guest's known-good map must survive until the new
   pyramid is fully downloaded and verified. Old tile caches are retired by
   precache.ts AFTER it marks the new version saved. Tile reads fall back to
   older tile caches so the map keeps working mid-upgrade.

   Redirect hygiene: Cloudflare 308s ./index.html -> ./ ; a stored *redirected*
   response is rejected when replayed for a navigation, so every cached
   navigation response is normalised (re-wrapped) before it enters the cache. */
const SHELL_CACHE = "solio-shell-v13";
const TILE_CACHE = "solio-tiles-v5";
const TILE_PREFIX = "solio-tiles-";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

const isTile = (url) => url.pathname.includes("/tiles/");
const isManifest = (url) => url.pathname.endsWith("/tiles-manifest.json");

/** Strip the redirected flag (and any other replay poison) off a response. */
async function normalised(resp) {
  if (!resp.redirected) return resp;
  const body = await resp.blob();
  return new Response(body, { status: resp.status, statusText: resp.statusText, headers: resp.headers });
}

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      for (const asset of SHELL_ASSETS) {
        const resp = await fetch(asset, { cache: "no-cache" });
        if (!resp.ok) throw new Error(`shell precache ${asset}: ${resp.status}`);
        await cache.put(asset, await normalised(resp));
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && !k.startsWith(TILE_PREFIX))
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // nav-auth.json is an authorization heartbeat (src/lib/navAuth.ts): it must
  // NEVER be answered from a cache, or a stale "enabled" could outlive its
  // revocation. Untouched here, it goes straight to the network; offline, the
  // fetch fails and the app's stored verdict expires on its own TTL.
  if (url.pathname.endsWith("/nav-auth.json")) return;

  // Navigations: network first (fresh releases), cached app shell when offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            e.waitUntil(
              caches
                .open(SHELL_CACHE)
                .then(async (c) => c.put("./index.html", await normalised(copy)))
                .catch(() => {}),
            );
          }
          return resp;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./"))),
    );
    return;
  }

  // tiles-manifest.json: network first so a tile release is seen immediately,
  // falling back to the cached copy offline. Never let an HTML error page in.
  if (isManifest(url)) {
    e.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp.ok && (resp.headers.get("content-type") || "").includes("json")) {
            const copy = resp.clone();
            e.waitUntil(caches.open(TILE_CACHE).then((c) => c.put(req, copy)).catch(() => {}));
            return resp;
          }
          return caches.match(req).then((r) => r || resp);
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // Tiles: cache-first — current tile cache, then ANY older tile cache (keeps
  // the map alive mid-upgrade), then network. Guard content-type so an
  // SPA-fallback HTML page can never be cached as a tile.
  if (isTile(url)) {
    e.respondWith(
      caches
        .open(TILE_CACHE)
        .then((c) => c.match(req))
        .then(
          (hit) =>
            hit ||
            caches.match(req).then(
              (older) =>
                older ||
                fetch(req).then((resp) => {
                  const type = resp.headers.get("content-type") || "";
                  // Never cache query-keyed tile requests (the precacher's
                  // cache-busting fetches) — only canonical URLs may enter the
                  // cache, so strays can't mask or shadow real entries.
                  if (resp.ok && resp.type === "basic" && type.startsWith("image/") && !url.search) {
                    const copy = resp.clone();
                    e.waitUntil(caches.open(TILE_CACHE).then((c) => c.put(req, copy)).catch(() => {}));
                  }
                  return resp;
                }),
            ),
        ),
    );
    return;
  }

  // Other same-origin assets: cache-first into the shell cache. Never cache an
  // HTML body under a non-navigation URL (that's an error/SPA-fallback page).
  e.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((resp) => {
        const type = resp.headers.get("content-type") || "";
        if (resp.ok && resp.type === "basic" && !type.includes("text/html")) {
          const copy = resp.clone();
          e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.put(req, copy)).catch(() => {}));
        }
        return resp;
      }).catch(() => cached),
    ),
  );
});
