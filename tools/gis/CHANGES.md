# Road network v2 — change log vs Callan's delivered data (2026-07-09)

Branch `fix/road-connectivity`. Production still runs the v1 GIS import with
navigation OFF (`NAV_ENABLED=false`). Nothing here is deployed.

**Restore path:** `backups/2026-07-09-pre-connectivity/roads.gis.ts` (v1 shipped file),
or `git checkout main -- src/data/roads.gis.ts`. Originals in `tools/gis/SOURCES.md`.

## What v2 is
`src/data/roads.gis.ts` regenerated from the **poster artwork trace**, not from
`Solio_Reserve_Roads`:

1. **Traced the complete drawn network** off `solio-truenorth.jpg`
   (`tools/roads/trace_poster_roads.py`): grey-road mask (calibrated; salt-pan
   blue tint excluded) → morphological close → Zhang–Suen skeleton → graph →
   component/spur filtering. ~2,980 nodes after import noding.
2. **205 automatic heals** (≤20 px, plus ≤40 px only across drawn water) where
   markers/text/rivers broke the drawn line — every heal logged in
   `tools/roads/poster_trace_heals.json`. These are bridge decks and icon gaps.
3. **3 manual bridge connectors** (`tools/roads/connectors.bridges.geojson`),
   each verified visually against the artwork (drawn crossing exists) and by a
   cut-finder (joining them recovers the direct drawn route):
   - JW crossing (west of "12"): gate→jw 10.1 → 6.5 km
   - Tharua Bridge ("1"): kingfisher→east routes halved (14.4 → 6.2 km)
   - Browns Bridge ("2"): yellowthorn→choroa 7.1 → 5.9 km
4. **POIs bound by the importer** as before; 9/10 bind (airstrip has no drawn or
   digitised access track — unroutable, unchanged from v1, on Callan's list).

## What this implicitly changes vs Callan's roads layer
- **16 bare-fence sublines (~25 km) excluded** — they are the fence, not drawn as
  roads on the guest map (poster support ≤0.24).
- **34 undrawn sublines (~48 km) excluded** — real management tracks perhaps, but
  not on the guest map; guests would see a route line crossing road-less terrain.
  ⚠ ambiguity — Callan to confirm any that should be guest-drivable.
- **8 drawn perimeter stretches kept** (they're in the artwork, hence traced).
- **Missing corridors recovered** (orphanage/gate river roads, Rhino Gate access,
  west inside-fence track) — drawn on the poster, absent from the GIS layer.

## Deliberately NOT done
- GPX-derived connectors (reverted earlier same day): survey too noisy (±59 m).
- Any road not visible in the artwork and not in Callan's data. Nothing invented.

## Results (measured)
| metric | v1 (GIS import, was live) | v2 (artwork trace) |
|---|---|---|
| avg POI-pair detour ratio | 2.06 | **1.52** |
| worst pair | 7.6× (naribo↔rhinogate) | **2.7×** |
| gate→orphanage (Callan's example) | 11.03 km | **2.42 km** |
| gate→jw | 6.46 km (via fence road) | **6.47 km (via drawn roads)** |
| connected components | 1 (fence-dependent) | 1 (no fence) |
| POIs routable | 9/10 | 9/10 (airstrip pending Callan) |

## Known trade-offs / follow-ups
- Emitted file ~530 KB (v1: 69 KB) — bundle 1.53 MB (was 1.25 MB). Needs a
  degree-2 chain-merge pass in the importer before any production ship.
- Geometry accuracy = artwork accuracy (±30–56 m at validated points).
- `tools/roads/connectors.gpx.geojson` kept only as a record — NOT applied.
