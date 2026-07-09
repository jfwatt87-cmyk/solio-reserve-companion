# Solio GIS layers — status

Callan's File Geodatabase `Solio_Game_Reserve.gdb` (delivered 2026-07-09,
alongside `SOLIO_MAP_FINAL.tif` and the `.aprx` project). Layers are EPSG:3857;
`tools/gis/export_layers.sh` reprojects them to WGS84 GeoJSON with GDAL.

| gdb layer | geometry | features | status |
|---|---|---|---|
| `Solio_Reserve_Roads` | MultiLineString | 157 sub-lines, ~164 km | **INGESTED** → `src/data/roads.gis.ts` via `tools/roads/import_gis_roads.py`. No name/surface attrs. |
| `Boundary_Solio_Game_reserve` | MultiPolygon | 1 (47 verts) | **INGESTED** → `src/data/boundary.ts` via `tools/gis/import_boundary.py`. Powers `insideReserve()`; optional outline (`SHOW_BOUNDARY`, default off). |
| `River_Solio_Game_Reserve` | MultiLineString | 4410 verts | Source asset only. Already drawn on the poster; not bundled (weight). |
| `Solio_Game_Reserve_Forest` | MultiPolygon | 18 | Source asset only (poster draws it). |
| `Solio_Game_Reserve_Plains` | MultiPolygon | 10 | Source asset only. |
| `Solio_Game_Reserve_Swamps` | MultiPolygon | 11 | Source asset only. |
| `Solio_Game_Reserve_Dams` | MultiPolygon | 4 | Source asset only. |
| `Solio_Game_Reserve_Perimitter_Road` | MultiPolygon | 1 | Source asset. NB drawn as an area, not a centreline. |
| `SolioMappingedited_GPXtoFeatures` | Point | 17055 | Raw GPX survey track (source of the roads). Not a POI layer. |
| `Links`, `Water_Holes`, `Points_Of_Interest`, `POIs_ExportFeatures` | — | 0 | Empty in this export. |

## Notes / follow-ups for Callan

- **Airstrip access track missing** — the roads layer's nearest road to the
  airstrip is 877 m away (the main gate junction), so the airstrip does not
  bind to the network. Ask for the airstrip spur in the next export.
- **Road names / surfaces** — the roads carry no `name`/`surface` attributes,
  so turn-by-turn says "Continue" and every road defaults to "dirt". Tagging
  them in GIS (see `tools/roads/GIS_ROADS_SPEC.md`) would enrich directions.
- **Georeference check** — the poster-derived POI pixels land within ~30–56 m
  of the true GIS boundary at the edges (gates sit ~30 m outside, on the fence
  line). That validates the poster georeference; it also means any geofence use
  of `insideReserve()` needs a ~100–150 m buffer so guests at a gate still read
  as "inside".

## Regenerating

```sh
brew install gdal   # once
tools/gis/export_layers.sh "/path/to/Solio_Game_Reserve.gdb"
python3 tools/roads/import_gis_roads.py tools/gis/layers/Solio_Reserve_Roads.geojson
python3 tools/gis/import_boundary.py   tools/gis/layers/Boundary_Solio_Game_reserve.geojson
npm run build
```
