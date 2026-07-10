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
- **28 undrawn sublines (33.7 km) excluded** — real management tracks perhaps, but
  not on the guest map; guests would see a route line crossing road-less terrain.
  ⚠ ambiguity — Callan to confirm any that should be guest-drivable.
  (Corrected from "34/~48 km": the first count mixed 0-based and 1-based subline
  ids, letting fence lines contaminate the undrawn set. Now ties exactly:
  16 fence 25.3 + 8 perimeter 1.3 + 28 undrawn 33.7 + 105 drawn 103.4 = 163.7 km
  = the layer's Shape_Length.)
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

## Joins regrade + fixes-file expansion (2026-07-09 evening, post dual-model audit)
Audits (fresh-context Fable + Codex `gpt-5.6-sol`) flagged that the HIGH grade
overclaimed ("drives pass straight through" was only points-within-45 m) and that
the 34 undrawn sublines were never put to Callan. Both fixed with data:

1. **True crossing test** added to `Solio_Joins_Best_Guess.geojson`: GPX points
   sequenced per track by DateTime (gaps ≤180 s / ≤400 m), giving 16,305 real
   drive segments; `gpx_crossings` = segments intersecting the join, and for
   river joins `river_cross_events_150m` = drive segments crossing the RIVER
   layer within 150 m of the join (robust to the ±59 m GPS noise). 56 recorded
   river-crossing events total.
2. **Regrade on that evidence**: river joins with a recorded crossing → HIGH +
   `crossing_confirmed=true` (22: 19 kept, 3 upgraded from LOW); river joins
   without → downgraded/kept at MEDIUM (5 downgraded from HIGH). New totals
   HIGH 62 / MEDIUM 35 / LOW 111; Callan confirm list = 25 unconfirmed river
   joins (`on_river=true AND crossing_confirmed=false`). Notes regenerated to
   state exactly what the evidence is.
2b. **Site clustering** (James: "surely there's not 60+ bridges?" — correct): the
   river is drawn double-banked so one physical crossing needs several joins.
   Single-link clustering at 250 m: 47 river joins → **22 physical crossing
   sites** (`site` S01–S22 north→south, `site_confirmed`); the poster names only
   6 as bridges, the rest are drifts/culverts. **15/22 sites proven** by a
   recorded crossing — Tharua (S01) and Browns (S07: its own join is MEDIUM but
   a drive crosses the same site) both proven. **7 unconfirmed sites = the real
   Callan ask**: S05, S06, S16, S18, S20 (crossing W of JW Marriott — the manual
   jw-bridge connector, artwork-only), S21, S22 (orphanage/gate corner, outside
   GPX coverage).
3. **`Solio_Roads_Suggested_Fixes.geojson` recategorised**: the 8 drawn-perimeter
   fence lines relabelled `check_perimeter` (support recomputed per subline,
   `drawn_on_map`/`map_support_pct` added); **28 `confirm_undrawn` features added**
   (sublines with poster support ≤0.24 that aren't in the fence set — 33.7 km;
   an earlier batch said 34/45.5 km but had an 0/1-based subline id mix-up that
   let fence lines leak in — caught by re-rendering map 1 and fixed).
3b. **Bridge↔site mapping verified against the artwork icons** (crops at each
   circled bridge marker): Martins = S10 (proven), Browns = **S06 (UNCONFIRMED)**,
   Waterbuck ≈ S21 (unconfirmed), Middle + Kifaru traced continuously (no site).
   The manual connector labelled "browns-bridge" is actually a separate crossing
   at S07 (proven), ~880 m E of the real Browns icon; "tharua-bridge" sits at S01,
   a proven crossing just S of the drawn Tharua icon (itself traced continuously).
   Labels in `connectors.bridges.geojson` are therefore MISNOMERS — geometry is
   fine, names are not. `site_name` added to the joins file for S01/S06/S10/S21.
4. GPX export reproducibility re-verified: `export_layers.sh` flags (`-dim XY`)
   give sha256 `acb943ed…` matching MANIFEST.sha256.

⚠ Consequence for the app: v2 currently routes over ALL 208 joins, including the
25 unconfirmed river crossings (Browns/JW among them). The "safe mode" build
(routable = confirmed crossings + dry-land joins only) is designed but NOT built.

## Known trade-offs / follow-ups
- Emitted file ~530 KB (v1: 69 KB) — bundle 1.53 MB (was 1.25 MB). Needs a
  degree-2 chain-merge pass in the importer before any production ship.
- Geometry accuracy = artwork accuracy (±30–56 m at validated points).
- `tools/roads/connectors.gpx.geojson` kept only as a record — NOT applied.
