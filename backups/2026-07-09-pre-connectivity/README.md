# Backup — pre road-connectivity fix (2026-07-09)

Untouched snapshot taken before the road-connectivity / POI-binding work on
branch `fix/road-connectivity`. Production at this point is tagged
`release-20260709-fdb37a6-navoff` (navigation held, NAV_ENABLED=false).

- roads.gis.ts / roads.ts / pois.ts / boundary.ts — the shipped data files as-is.
- Solio_Reserve_Roads.source.geojson — the roads layer exported fresh from
  Callan's `Solio_Game_Reserve.gdb` via ogr2ogr (EPSG:4326), the importer's input.

Restore any file by copying it back over src/data/, or `git checkout main -- <path>`.
