# Road network — GIS export spec (for Callan / Solio GIS)

The in-app sat-nav follows road *centrelines*. The current build ships a
network digitized off the georeferenced poster (traced centrelines,
back-projected to GPS — `src/data/roads.ts`); the authoritative GIS road
vectors supersede it cleanly via the importer below. This document is the
exact contract.

## What to export

A single **GeoJSON** file (`FeatureCollection`), **EPSG:4326 / WGS84** lon,lat
(the GeoJSON default — do **not** re-project to UTM or Web Mercator).

- One **`LineString`** feature per road segment, following the road centreline.
- Curves matter: keep the real vertices (bends, river follows). Density of ~1
  vertex per 20–50 m is ideal; we simplify on import if needed.
- Where two roads meet, the lines should **share an endpoint** (snap/node at
  junctions). If the export isn't noded at intersections we can node it on
  import, but clean junctions give better turn-by-turn directions.

### Per-feature properties (optional but valued)

| property   | values                                   | used for                          |
|------------|------------------------------------------|-----------------------------------|
| `name`     | e.g. "Rhino Gate Road"                    | turn-by-turn ("Turn left onto …") |
| `surface`  | `graded` \| `dirt` \| `4x4`               | routing cost + the guest label    |
| `oneway`   | `true` \| `false` (default false)         | direction of travel               |
| `gate`     | `true` on segments that pass a gate       | access notes                      |

Anything missing is fine — unknown surface defaults to `dirt`, no name → the
step just says "Continue".

## Accuracy note

Coordinates must be true GPS (same datum as a phone's GPS, WGS84). Export from
the authoritative GIS layer. (The interim in-app network is traced from the
poster *through its verified georeference*, so it is GPS-consistent — but the
GIS layer remains the ground truth and wins the moment it is imported.)

## What happens on our side — running the importer

`tools/roads/import_gis_roads.py` reads the GeoJSON, nodes the lines into a
routing graph (junction nodes + edges carrying the real curved geometry),
binds the well-known POI node ids (gate, lodge, orphanage, …) to the nearest
graph nodes so tours keep routing, and emits `src/data/roads.gis.ts` in the
same shape as `roads.ts`. The app (`src/data/roadSource.ts`) automatically
prefers `roads.gis.ts` when it exists and falls back to the traced network
otherwise — no other code changes needed.

When Callan's file arrives:

```sh
# from the repo root — plain Python 3, no dependencies
python3 tools/roads/import_gis_roads.py path/to/solio_roads.geojson
npm run build
```

Check the importer's output: every POI should report `poi '<id>' -> node …`.
A `WARNING: no network node within 800 m of POI '<id>'` means the export does
not reach that POI — routes to it will fail; either the export is missing that
spur or the POI needs a connector (the `--poi-radius` flag loosens the match).
Verify by rendering the imported network over the basemap and confirming it
sits on the drawn roads, then delete `src/data/roads.gis.ts` if you need to
fall back to the traced network.

A representative sample export lives at `tools/roads/sample/sample_roads.geojson`
(four named, surfaced centrelines that share endpoints). It is used to exercise
the pipeline end-to-end and is NOT the live network — do not import it except
for testing.

## Minimal example

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "properties": { "name": "Rhino Gate Road", "surface": "graded" },
      "geometry": {
        "type": "LineString",
        "coordinates": [[36.9820, -0.0905], [36.9788, -0.0946], [36.9761, -0.0990]]
      }
    }
  ]
}
```
