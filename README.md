# Solio Reserve Companion

A companion app for guests of **Solio Game Reserve** (Laikipia, Kenya): the
reserve's own hand-drawn map, georeferenced so a live GPS dot lands on the
right drawn feature, with on-reserve turn-by-turn navigation, self-guided
game drives — all working **fully
offline** once loaded.

Technically it is a **React + TypeScript + Vite + MapLibre GL** progressive
web app (PWA). It runs today in any browser and installs to a phone's home
screen; the plan is to wrap the same codebase with **Capacitor** and ship it
to the App Store and Play Store in the funded phase (see [Roadmap](#roadmap)).

**Live demo:** https://jfwatt87-cmyk.github.io/solio-reserve-companion/

---

## ⚠️ The hard constraint: rhino location security

Solio is a rhino sanctuary. **Precise live rhino (or other sensitive animal)
positions must never reach a guest device.** This is the one rule that
overrides every feature decision in this codebase:

- The app carries **no rhino tracking of any kind** — no positions, no
  proximity hints, no heat maps.
- No animal-location data exists in the app at all — guests can never pin a rhino's precise
  location themselves.
- The Phase 2 backend schema (`supabase/`) enforces this **at the database
  layer**: guests and guides have *no row-level-security policy at all* on
  `rhino_sightings`, so the data is unreachable by their credentials — not
  merely hidden in the UI.

Any operational animal tracking belongs on ranger systems behind
authentication. If you inherit this project, keep this constraint intact in
every future feature. When in doubt, leave the data off the guest device.

---

## Quick start

```bash
npm install
npm run dev        # Vite dev server — open the printed localhost URL
npm run build      # type-check (tsc -b) + production build to dist/
npm run preview    # serve the production build locally
```

Geolocation requires HTTPS or localhost. To try real GPS on a phone against
a dev build, serve from a laptop and browse to it over the same Wi-Fi (or
just use the live demo URL above).

On a desktop the app presents inside a phone frame with a pitch panel
(handy for screen-sharing); on a phone or narrow window it goes full-screen.
Useful URL params: `?skipWelcome` (skip the welcome screen), `?tab=drives`
(open a specific tab).

## Deployment

Push to `main` and GitHub Actions builds and publishes `dist/` to **GitHub
Pages** (`.github/workflows/deploy.yml`). There is no server component today —
the app is static files.

The production build is unusual in a good way:

- `vite-plugin-singlefile` inlines all JS, CSS and fonts into **one
  self-contained `index.html`** (~1.2 MB, ~380 KB gzipped).
- The basemap ships alongside it as a **raster tile pyramid**
  (`public/tiles/{z}/{x}/{y}.jpg`, ~14 MB, zooms 11–16) copied verbatim into
  `dist/tiles/`.
- A service worker (`public/sw.js`) precaches the app shell and caches each
  map tile the first time it is viewed, so visited areas keep working with no
  signal — which is most of the reserve.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| UI | React 18 + TypeScript 5 | mainstream, easy to hire for |
| Build | Vite 5 (+ `vite-plugin-singlefile`) | fast, single-file offline output |
| Map | MapLibre GL 4 | open-source vector/raster GL map, no API keys, no per-load fees |
| Fonts | `@fontsource/fraunces` (self-hosted) | works offline, no CDN |
| Tooling (Python) | Pillow, rasterio, pyproj, OpenCV, numpy | basemap/GIS pipeline in `tools/` (not needed to run the app) |
| Backend (Phase 2, authored not deployed) | Supabase (Postgres + RLS + Realtime + PostGIS) | see `supabase/` |

No API keys, no paid services, no telemetry. `npm install` is the only setup.

## Project structure

```
solio-poc/
  index.html                 PWA shell (manifest, icons, meta)
  vite.config.ts             single-file build config
  src/
    main.tsx                 entry (StrictMode + ErrorBoundary)
    App.tsx                  app state: tabs, sim/GPS source, navigation,
                             tours, welcome screen, phone frame
    components/
      ReserveMap.tsx         the MapLibre map: raster-tile basemap pinned to
                             its display box + all GPS-aligned overlays
      ErrorBoundary.tsx
    lib/
      georef.ts              least-squares affine georeference (pixel <-> GPS)
      geo.ts                 WGS84 distance / bearing / path projection helpers
      routing.ts             road graph + A* + alternatives + turn-by-turn
      sim.ts                 pose along a path (the demo drive)
    data/
      reserve.ts             the pixel coordinate system + corner ground
                             control points (read from Callan's GeoTIFF)
      roads.ts               road network traced off the georeferenced poster
      roadSource.ts          selector — auto-prefers roads.gis.ts if generated
      pois.ts                visitor destinations (digitised on the real map)
      tours.ts               self-guided drives (stops + commentary)
    assets/
      solio-truenorth.jpg/.json   exported basemap + its georeference
      tiles-meta.json             tile-pyramid metadata (bounds, zooms)
  public/
    tiles/{z}/{x}/{y}.jpg    the raster tile pyramid (~14 MB)
    sw.js                    offline service worker
    manifest.webmanifest, icons
  tools/
    basemap/                 poster -> basemap pipeline (Python; see below)
    roads/                   GIS road importer + the export spec for Solio
      GIS_ROADS_SPEC.md      exactly what to ask a GIS person to export
      import_gis_roads.py    GeoJSON roads -> src/data/roads.gis.ts
  supabase/
    migrations/              Phase 2 schema: RBAC, RLS, geofence (authored,
                             NOT yet run against a live project)
    tests/rbac_test.sql      policy assertions
  prototype/                 the original Leaflet tile proof (superseded)
  .github/workflows/deploy.yml   CI -> GitHub Pages
```

## How the map works

The basemap is **Solio's own illustrated poster**, georeferenced from the
GeoTIFF supplied by reserve management (Callan), so it is both beautiful *and*
GPS-exact. The pipeline (all in `tools/basemap/`, Python):

1. **`export_truenorth.py`** — reads the compass-corrected, true-north
   GeoTIFF and exports the app basemap: a web-friendly JPEG
   (`src/assets/solio-truenorth.jpg`) plus a JSON sidecar
   (`solio-truenorth.json`) holding the image's four WGS84 corners and its
   EPSG:3857 affine transform. It also does two raster clean-ups (corner
   wedge-fill, a small residual de-skew) — both performed *rigidly and
   composed back into the geotransform*, so GPS accuracy is preserved
   exactly. (`compose.py` and `clean_base.py` are earlier/auxiliary raster
   steps: levelling marginal text and producing a reserve-only clean base.)

2. **`make_tiles.py`** — slices that poster into a standard **XYZ raster tile
   pyramid** (`public/tiles/`, zooms 11–16, 256 px JPEG tiles). Why tiles: the
   poster is 28.5 MP, which as a single MapLibre image source would exceed
   most phone GPUs' 4096 px texture limit and be slow to decode. Tiles load
   only what is visible, stay crisp at deep zoom, and are mobile-safe. The
   script reproduces the app's display placement *exactly*, so a tile shows
   the same poster pixel in the same place the full image would — every
   overlay still lands on its drawn feature.

3. **In the app** — `ReserveMap.tsx` adds the pyramid as a MapLibre raster
   source pinned to that same display box (`src/assets/tiles-meta.json`
   carries bounds/zooms). Overlays (POIs, routes, the GPS dot) are
   authored either directly in lng/lat or in the poster's pixel space and
   lifted to lng/lat through the shared affine georeference
   (`src/lib/georef.ts`, control points in `src/data/reserve.ts` — taken from
   the GeoTIFF's own corner coordinates). One transform, used everywhere, is
   what keeps everything aligned.

> **Do not casually edit** `tools/basemap/export_truenorth.py`,
> `tools/basemap/make_tiles.py`, `src/lib/georef.ts` or the control points in
> `src/data/reserve.ts`. The display box, the tile cutter and the georeference
> are kept in exact agreement by construction; a "small fix" in one place
> silently shifts every overlay. If the artwork is ever updated, re-run the
> pipeline end-to-end and verify the GPS dot against known ground features.

## The routing engine

On-reserve sat-nav runs **entirely on-device** — no routing service, no
connectivity needed. See `src/lib/routing.ts`:

- **The network** (`src/data/roads.ts`) is road *centrelines* traced off the
  georeferenced poster and back-projected to GPS, so it is GPS-consistent
  with the basemap. Nodes are junctions/destinations; edges carry the real
  curved geometry and a surface class (`graded` / `dirt` / `4x4`).
- **A\* search** finds the lowest-cost drive, where rougher surfaces cost
  more (dirt ×1.3, 4x4 ×1.95) so routing prefers good roads when sensible —
  while the distance shown to the guest is always the true length.
- **Alternatives** use the penalty method: find the best route, multiply the
  cost of its edges, search again. Alternatives are kept only if they are not
  much longer than the best (≤1.8×) and genuinely distinct (<75 % overlap) —
  e.g. the two sides of a loop.
- **Turn-by-turn** steps are built by grouping consecutive edges on the same
  road and classifying the turn angle at each transition ("Turn left onto
  Naribo Track — dirt track, 1.2 km").
- **Live re-routing**: while navigating, if the position (real GPS or the
  demo "Detour") strays more than 60 m from the active route, the app
  recomputes from where you actually are (debounced to every 2.5 s).
- **Drive modes**: a simulated demo drive rides the route at game-drive pace
  (`src/lib/sim.ts`), or the "Use my GPS" toggle navigates against the real
  device position (`watchPosition` in `App.tsx`).

**Swapping in Solio's authoritative GIS roads** is designed to be a data
change, not a code change: `tools/roads/GIS_ROADS_SPEC.md` is the exact
export contract to hand to a GIS person, `tools/roads/import_gis_roads.py`
converts their GeoJSON into `src/data/roads.gis.ts`, and
`src/data/roadSource.ts` automatically prefers that file when it exists.

## Backend (Phase 2 — authored, not yet deployed)

`supabase/migrations/` contains the reviewed schema for the funded phase's
live vehicle tracking with role-based access (guest / guide / ranger /
manager): row-level security on every table, roles resolved via a
`SECURITY DEFINER` helper in a private schema (never from user-editable
metadata), opt-in tracking consent with immutable consent events, a PostGIS
geofence so guests are only tracked inside the reserve, data-retention jobs,
and — the hard rule again — **no guest/guide policy on rhino data at all**.
`supabase/tests/rbac_test.sql` asserts the policies. None of this is wired
into the app yet; it ships when Phase 2 is funded.

## Roadmap

**Phase 1 — Foundation & guest map (now).**
Everything in this repo: georeferenced basemap as offline tiles, GPS
self-location, traced road network with turn-by-turn navigation and
alternatives, self-guided drives,
PWA install + offline, GitHub Pages deployment. Real GIS boundary / roads /
rivers / POIs from Solio drop in via the importers as they arrive.

**Phase 2 — Live tracking, native app, stores (Marriott / donor-funded).**
Supabase backend goes live (the schema above): opt-in vehicle tracking with
guest/guide/ranger/manager roles, server-side geofence, ranger visibility of
guest vehicles. The PWA is wrapped with **Capacitor** and shipped to the
App Store and Play Store as one app with role-based access.

**Phase 3 — Sightings network & road intelligence.**
Guest sightings sync to rangers and integrate with **EarthRanger**
(sensitive species always excluded on the guest side, enforced server-side);
road-condition alerts (washouts, closures) pushed onto the map and respected
by routing.

## Ownership

**Solio Game Reserve owns all of this** — the code, the map artwork and
georeference work, the tile pyramid, the traced road network, and all data.
There is no vendor lock-in by design: the stack is entirely open-source
(React, Vite, MapLibre, Supabase/Postgres), there are no API keys or paid
services, and any competent web developer can pick this repo up with
`npm install && npm run dev`.

## Contact

James Watt — [email removed — contact via WhatsApp]
