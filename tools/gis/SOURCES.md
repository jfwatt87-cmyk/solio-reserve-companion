# Source material inventory — roads deep-dive (2026-07-09)

Originals are UNTOUCHED. Everything below is derived from them reproducibly.

## Originals (as delivered by Callan)
- `../../..​/Solio gdb/Solio_Game_Reserve.gdb` — Esri File Geodatabase (canonical).
- `../../..​/SOLIO_MAP_FINAL.tif` — 97 MB basemap GeoTIFF (sha256 b7f5c80a1da8fc01…).
- `src/assets/solio-truenorth.jpg` (4202×6774) + `solio-truenorth.json` (merc2px georef)
  — the straightened poster the app's tiles are cut from. **Display truth.**

## Deterministic exports (tools/gis/layers/, via export_layers.sh; sha256 in MANIFEST.sha256)
| layer | verdict after assessment |
|---|---|
| `Solio_Reserve_Roads` | ONE unclassified MultiLineString, 157 sublines, ~164 km. **Mixed quality**: 99 lines (89 km) match drawn roads; 8 (1.3 km) drawn perimeter; **16 (25 km) bare fence**; **34 (48 km) not drawn on the guest map**; missing whole drawn corridors (orphanage/gate, Rhino Gate access, west inside-fence track) |
| `Boundary_Solio_Game_reserve` | authoritative fence line (47 verts) — used for classification + geofence |
| `Solio_Game_Reserve_Perimitter_Road` | polygon ring ~46.2 km, median 12 m from fence — perimeter road concept exists along the fence |
| `River_Solio_Game_Reserve` | 46 lines, 52 km — used to sanity-check bridge crossings |
| `SolioMappingedited_GPXtoFeatures` | 17,055 GPS points. **Rough survey, NOT survey-grade**: median 59 m off roads, 40% within 30 m; coverage lat −0.2524..−0.1375 (excludes orphanage corner). Good for "a vehicle went ~here", useless for centrelines |
| Dams / Water_Holes | small polygon assets, not yet consumed |

## Cross-validation verdict (GIS roads vs poster artwork)
The **poster artwork is the most complete and self-consistent road source we hold**
(and it is what guests see). Callan's roads layer disagrees with his own artwork in
both directions (fence lines that aren't roads; drawn corridors that are missing).
Hence the v2 network is **traced from the artwork** (`tools/roads/trace_poster_roads.py`)
through the deployment georeference — poster-true and GPS-true to the artwork's
validated ±30–56 m. Callan's repaired GIS remains the intended long-term source.
