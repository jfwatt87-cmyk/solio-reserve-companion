/* Solio Reserve Companion — offline service worker.

   TWO caches with independent lifetimes:
   - SHELL_CACHE: the app itself (index.html, manifest, icons). Bump per release.
   - TILE_CACHE:  the ~12 MB basemap tile pyramid + tiles-manifest.json. Bump ONLY
     when the tile pyramid itself changes. Must equal TILE_CACHE_TAG in
     src/lib/precache.ts — the prebuild step (tools/gen-tile-manifest.mjs) fails
     the build if they ever diverge.

   Why split: bumping the shell version must never wipe a guest's saved map.
   activate only deletes caches that belong to neither name, so a shell release
   leaves the tiles untouched, and a tile release (both bumped) re-pulls cleanly. */
const SHELL_CACHE = "solio-shell-v9";
const TILE_CACHE = "solio-tiles-v4";

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

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      for (const asset of SHELL_ASSETS) {
        const resp = await fetch(asset, { cache: "no-cache" });
        if (!resp.ok) throw new Error(`shell precache ${asset}: ${resp.status}`);
        // Cloudflare 308s ./index.html -> ./ — a stored *redirected* response
        // is rejected when replayed for an offline navigation, so re-wrap it.
        await cache.put(
          asset,
          resp.redirected
            ? new Response(await resp.blob(), {
                status: resp.status,
                statusText: resp.statusText,
                headers: resp.headers,
              })
            : resp,
        );
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
          keys.filter((k) => k !== SHELL_CACHE && k !== TILE_CACHE).map((k) => caches.delete(k)),
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

  // Navigations: network first (fresh releases), cached app shell when offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(SHELL_CACHE).then((c) => c.put("./index.html", copy));
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
            caches.open(TILE_CACHE).then((c) => c.put(req, copy));
            return resp;
          }
          return caches.match(req).then((r) => r || resp);
        })
        .catch(() => caches.match(req)),
    );
    return;
  }

  // Tiles: cache-first (the precache loop fills TILE_CACHE; panning tops it up).
  // Guard content-type so an SPA-fallback HTML page can never be cached as a tile.
  if (isTile(url)) {
    e.respondWith(
      caches.match(req).then(
        (cached) =>
          cached ||
          fetch(req).then((resp) => {
            const type = resp.headers.get("content-type") || "";
            if (resp.ok && resp.type === "basic" && type.startsWith("image/")) {
              const copy = resp.clone();
              caches.open(TILE_CACHE).then((c) => c.put(req, copy));
            }
            return resp;
          }),
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
          caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      }).catch(() => cached),
    ),
  );
});
