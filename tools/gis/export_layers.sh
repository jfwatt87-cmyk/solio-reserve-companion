#!/usr/bin/env bash
# Reproducibly export the layers we use from Callan's File Geodatabase to
# WGS84 (EPSG:4326) GeoJSON. Requires GDAL/ogr2ogr (`brew install gdal`).
#
#   tools/gis/export_layers.sh "/path/to/Solio_Game_Reserve.gdb" [outdir]
#
# The .gdb layers are in EPSG:3857 (Web Mercator); -t_srs EPSG:4326 reprojects
# them to the lon,lat the importers expect. Curve geometries are linearized.
set -euo pipefail

GDB="${1:?usage: export_layers.sh <path-to.gdb> [outdir]}"
OUT="${2:-$(dirname "$0")/layers}"
mkdir -p "$OUT"

# layers we currently ingest or keep as source assets
LAYERS=(
  Solio_Reserve_Roads                 # -> import_gis_roads.py  -> src/data/roads.gis.ts
  Boundary_Solio_Game_reserve         # -> import_boundary.py   -> src/data/boundary.ts
  River_Solio_Game_Reserve            # source asset (not yet consumed)
  Solio_Game_Reserve_Forest           # source asset (not yet consumed)
  Solio_Game_Reserve_Plains           # source asset (not yet consumed)
  Solio_Game_Reserve_Swamps           # source asset (not yet consumed)
  Solio_Game_Reserve_Dams             # source asset (not yet consumed)
  Solio_Game_Reserve_Perimitter_Road  # source asset (drawn as a polygon, not a line)
)

for L in "${LAYERS[@]}"; do
  echo "-> $L"
  ogr2ogr -f GeoJSON -t_srs EPSG:4326 -dim XY "$OUT/$L.geojson" "$GDB" "$L"
done
echo "done: $OUT"
