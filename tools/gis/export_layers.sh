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

# Layers we currently ingest or keep as source assets. This list matches
# layers/MANIFEST.sha256 — keep the two in sync so `shasum -c` stays meaningful.
LAYERS=(
  Solio_Reserve_Roads                 # -> import_gis_roads.py  -> src/data/roads.gis.ts
  Boundary_Solio_Game_reserve         # -> import_boundary.py   -> src/data/boundary.ts
  River_Solio_Game_Reserve            # crossing-evidence checks (joins grading)
  Solio_Game_Reserve_Dams             # source asset (not yet consumed)
  Solio_Game_Reserve_Water_Holes      # source asset (empty layer, kept for the record)
  Solio_Game_Reserve_Perimitter_Road  # source asset (drawn as a polygon, not a line)
)

for L in "${LAYERS[@]}"; do
  echo "-> $L"
  ogr2ogr -f GeoJSON -t_srs EPSG:4326 -dim XY "$OUT/$L.geojson" "$GDB" "$L"
done

# ⚠ SENSITIVE, exported only on request: the raw staff GPX survey (timestamped
# drive diary + named wildlife tracks). It is gitignored and must NEVER be
# committed or shared — used locally for evidence checks only.
if [ "${3:-}" = "--with-gpx" ]; then
  echo "-> SolioMappingedited_GPXtoFeatures (SENSITIVE — do not commit)"
  ogr2ogr -f GeoJSON -t_srs EPSG:4326 -dim XY "$OUT/SolioMappingedited_GPXtoFeatures.geojson" "$GDB" SolioMappingedited_GPXtoFeatures
fi
echo "done: $OUT"
