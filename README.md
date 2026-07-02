# Solio Game Reserve — Companion App (Proof of Concept)

A working proof of concept: reserve guests see themselves on Solio's own
illustrated map, navigate the tracks with turn-by-turn guidance, follow
self-guided drives and log wildlife sightings. Built to demonstrate
feasibility for management — **the road network and tour content are
illustrative placeholders; the basemap is Callan's real georeferenced poster.**

## Run it

```bash
cd solio-poc
npm install
npm run dev      # open the printed localhost URL
# or: npm run build && npm run preview
```

On a desktop the app is presented inside a **phone frame** alongside a short
pitch panel (ideal for screen-sharing with management). On a phone or narrow
window it goes full-screen as the real guest app would. A branded **welcome
screen** sets the scene on first load.

## What it demonstrates

1. **You-are-here on the reserve's own map.** The straightened, true-north
   poster is georeferenced from its GeoTIFF (EPSG:3857 affine): real lng/lat
   is projected onto the artwork's pixel grid, so the live GPS dot lands on
   the right drawn feature. Works fully offline — the whole app builds to a
   single self-contained HTML file.
2. **On-reserve navigation.** A demo road graph links the real POIs; A* finds
   the shortest drive and produces turn-by-turn directions, with a live
   "Drive" simulation and ETA. Real GIS road vectors would drop straight in.
3. **Self-guided drives.** Curated multi-stop tours with commentary at each
   stop.
4. **Wildlife sightings.** Guests pin what they saw at their location (stored
   on-device; a production build would sync to rangers).

### The critical design decision — rhino location security

Live rhino positions are exactly what poachers want, so this app carries
**no rhino tracking of any kind** — no rhino positions, no rhino proximity,
and rhino is deliberately not a loggable sighting species, so guests can
never pin a rhino's precise location. Any operational tracking belongs on
ranger systems behind authentication, never on guest devices.

## How the demo maps to a real build

| Demo | Production |
|------|-----------|
| Poster georeference baked at export (`tools/basemap/export_truenorth.py`) | Same pipeline, re-run when the artwork is updated |
| Demo road graph (`data/roads.ts`, straight-line links) | Roads digitised from GIS vectors, or GPS-recorded by driving them |
| Simulated "Demo drive" | Device GPS (already wired — "Use my GPS" toggle) |
| Sightings in localStorage | Synced to a ranger backend with role-based access |

**The key point:** the POIs are digitised on the real georeferenced map, so
swapping in real road vectors or a backend changes no coordinate work.

## Project structure

```
src/
  lib/
    geo.ts        distance, bearing, formatting (WGS84)
    georef.ts     least-squares affine georeferencing (pixel <-> GPS)
    routing.ts    road graph + A* + turn-by-turn step builder
    sim.ts        position simulation along a path
    sightings.ts  guest sightings log (localStorage)
  data/
    reserve.ts    authored pixel space, corner control points, georeference
    roads.ts      network nodes + named edges (demo)
    pois.ts       visitor destinations (digitised on the real map)
    tours.ts      self-guided drives
  components/
    ReserveMap.tsx   MapLibre GL map: georeferenced poster + overlays
  App.tsx          state, navigation, tours, sightings, controls
tools/basemap/
  export_truenorth.py  GeoTIFF -> app basemap (jpg + georeference json)
```

## Stack

React + TypeScript + Vite + MapLibre GL. No backend — georeferencing,
routing and rendering are self-contained and offline-capable, which keeps
the PoC dependency-light and the concepts transparent.
