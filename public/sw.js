/* Solio Reserve Companion — offline service worker.
   Precache the app shell and serve it cache-first, falling back to the cached
   shell for navigations. The basemap ships as raster tiles (tiles/{z}/{x}/{y}.jpg);
   they are same-origin, so the asset handler below caches each tile the first time
   it is viewed — visited areas then work offline. Bump CACHE on each release. */
const CACHE = "solio-pwa-v7";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(ASSETS);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  // Navigations: network first (fresh releases), cached app shell when offline.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then((resp) => {
          if (resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE).then((c) => c.put("./index.html", copy));
          }
          return resp;
        })
        .catch(() => caches.match("./index.html").then((r) => r || caches.match("./"))),
    );
    return;
  }
  // Same-origin assets: cache-first, then network (and cache it).
  e.respondWith(
    caches.match(req).then((cached) =>
      cached ||
      fetch(req).then((resp) => {
        if (resp.ok && resp.type === "basic") {
          const copy = resp.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return resp;
      }).catch(() => cached),
    ),
  );
});
