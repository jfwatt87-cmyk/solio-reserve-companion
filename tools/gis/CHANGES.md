# Road network v2 — change log vs Callan's delivered data (2026-07-09)

**Header corrected 2026-07-14** — it said "branch `fix/road-connectivity`, production still runs
the v1 GIS import, nothing here is deployed". All three were stale: the work landed on `main`
(D76), and production has run the safe-mode v2 network since then. Navigation remains OFF
(`NAV_ENABLED=false`), and with `SHOW_ROADS=false` too, `roads.gis.ts` is **inert in the shipped
app** — neither drawn nor routed over. Roads releases are therefore not guest-visible; they exist
so the data is true on the day nav flips on.

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

## SAFE MODE shipped as the branch network (2026-07-10)
`src/data/roads.gis.ts` is now the **evidence-gated** build: the app cannot
route over ANY unconfirmed river crossing.

- Importer gained `--block` (cuts every graph realisation of a blocked join:
  node-pair connectors, healed seams inside longer edges via span removal, and
  proper crossings) + degree-2 **chain-merge** with Douglas-Peucker (6 m) and
  parallel-edge dedupe + a spatial grid making the noding pass ~0.4 s (was
  10+ min; two of my own bugs fixed on the way: grid cluster tie-breaking must
  be lowest-index to match the old semantics, and a merge/span-cut runaway).
- Blockers = `tools/roads/blockers.unconfirmed-crossings.geojson` (the 22
  joins at the 7 unconfirmed sites). 8 realisations cut; S20's only crossing
  was the manual jw connector, now parked in
  `tools/roads/connectors.unconfirmed.geojson` (re-add when Callan confirms);
  the remaining blocker joins were never in the trace at all.
- **Measured cost of safety ~= zero**: avg detour 1.52->1.53, no POI pair lost,
  gate->orphanage unchanged 2.42 km; worst regressions ~+20% on three
  kingfisher pairs. (`tools/roads/measure_network.py` compares two builds.)
- File 530 KB -> **358 KB** (bundle 1.53 -> 1.42 MB); the routing graph + demo
  patrol now build LAZILY (guest launches don't pay for routing at all).
- Regenerate with:
  `python3 tools/roads/import_gis_roads.py tools/roads/poster_roads.geojson \
     --connectors tools/roads/connectors.bridges.geojson \
     --block tools/roads/blockers.unconfirmed-crossings.geojson`

## Callan's site answers applied — blockers 22 -> 19 (2026-07-14)
Callan replied on WhatsApp to the 7-site confirm pass, answering 6. **Only the
three his reply settles outright are unblocked**; the rest stay cut, because he
told us *what each place is*, which is not always the same as *you can drive it*.

| Site | Callan's words | Applied |
|------|----------------|---------|
| S06 | "Crossing" | ~~**unblocked** — crossing confirmed.~~ **RE-BLOCKED 2026-07-15 (D90 F2).** "Crossing" confirms the crossing EXISTS; it says nothing about whether guests may drive it, and nobody asked. `crossing_exists=true, guest_routable="unknown"` → cut. Name NOT confirmed either: the "Browns Bridge" guess is dropped, not proven (he never said Browns). |
| S16 | "Part of the Mount Kenya River Road" | **unblocked** |
| S21 | "Orphanage Road - Looks good" | **unblocked** — and our "likely Waterbuck Bridge" guess was WRONG. Waterbuck is now unlocated. |
| S18, S20 | "Marriotts Private Road - May be a good idea to restrict access here" | **stays blocked.** Crossings are real (`site_confirmed=true`, `access=private`) but he's asking to keep guests off, so confirming them must not silently route guests down a private road. `guest_routable=false`. Needs a firm yes/no — "may be a good idea" is a suggestion. The parked `jw-bridge` connector stays parked. |
| S05 | "Dam" | **stays blocked.** A dam is not a bridge; whether the road crosses the wall is still open. |
| S22 | *(no answer)* | stays blocked, untouched. |

- Per-join `confidence` deliberately **unchanged**. Callan confirmed each SITE is
  real — not which of our candidate join lines is the actual centreline (S20
  alone has 8). Site truth and join-geometry truth are different claims.
- Each remaining blocker now carries `still_blocked_because` so the reason
  survives without this file.
- ~~**Result: safe mode's cost is now nil.** The three ~+20% kingfisher regressions
  above are exactly what S06/S16/S21 recovered: kingfisher->naribo 9.18 -> 7.58 km,
  kingfisher->yellowthorn 7.33 -> 6.18 km, rhinogate->kingfisher 10.95 -> 9.36 km.
  Avg detour 1.52 -> **1.49**.~~
  **RETRACTED 2026-07-15 (D90 F2).** Those recoveries were bought by unblocking S06 on an
  over-read, and S16/S21 contributed nothing. With S06 re-blocked pending an answer, all
  three regressions are back and safe mode's cost is **15/36 POI pairs, worst case
  +1.60 km**. Nothing becomes unreachable. That cost is real and is the reason to ask
  Callan — it was never a reason to assume his answer.
  gate->orphanage holds at 2.43 km. `tsc --noEmit` clean.
- Not deployed. `NAV_ENABLED` remains `false`.

## Marriotts private road CLOSED to guests — blockers split (2026-07-14)
Callan proposed restricting access at S18/S20; James agreed. **The network output
is byte-identical (sha `a8b66226…`) — those joins were already cut.** What changed
is *why*, and whether it survives:

- **The bug this fixes:** S18/S20 were sitting in
  `blockers.unconfirmed-crossings.geojson`, a file that means "data gap — re-add
  once Callan confirms". Callan has now *confirmed* both. Left there, the next
  person to clear the unconfirmed list would have obediently unblocked a private
  road and started routing guests past JW. A standing access decision cannot live
  in a file whose whole semantic is "temporary".
- **New file `tools/roads/blockers.permanent.geojson`** (11 joins, S18+S20) —
  policy, permanent, `reason=private-access`. Unconfirmed list drops to **8**
  (S05×5, S22×3) and now contains only genuine data gaps. 19 blocked either way.
- `connectors.unconfirmed.geojson`'s parked `jw-bridge` note said *"re-add when
  Callan confirms S20"* — now inverted to **DO NOT RE-ADD**, since the trigger it
  named has fired and the correct response is the opposite of what it advised.
- **Invariant split in two:** "safe mode holds" (unconfirmed) and **"private
  access closed"** (policy). They fail for different reasons and must not share a
  verdict — one is expected to clear when Callan answers, the other never is.
  `test_network_invariants.py` passes both blocker files to the importer.
- Regenerate (BOTH `--block` files now — dropping the second silently reopens the
  private road):
  `python3 tools/roads/import_gis_roads.py tools/roads/poster_roads.geojson \
     --connectors tools/roads/connectors.bridges.geojson \
     --block tools/roads/blockers.unconfirmed-crossings.geojson \
     --block tools/roads/blockers.permanent.geojson`

## S05 resolved — Kingfisher Dam, not a crossing (2026-07-14)
Asked whether the road crosses the dam wall, Callan said: *"Yeah - you can drive to a sort of
view point/pick nic spot"* and *"I'd say the road is pretty accurate on the map"*.

- **"drive TO", not "drive ACROSS"** — a destination, not a through-route. The leading "Yeah"
  is the trap: banked as a yes, it would have routed guests over a dam wall.
- ~~**Measured, independently of the wording:** opening S05 changes **zero POI routes** … the
  crossing is not load-bearing — **blocking it is free**.~~
  **RETRACTED 2026-07-15 (D87 F2) — this claim was never established.** The experiment's extra
  node-pair lands in a component that gets pruned, so the identical SHA proved nothing; a
  plausible real connection moves 8/36 pairs (gate→Kingfisher 16.18→14.65 km). S05 stays cut on
  Callan's words, NOT on a cost argument. Do not repeat the claim.
- S05 sits 314 m from the **Kingfisher Dam** POI, which already routes fine (gate→16.18 km).
  Guests can already reach the dam; only the river hop is cut.
- **Stays in `blockers.unconfirmed-crossings.geojson`, NOT moved to private-access.** The
  distinction matters: if someone ever confirms a real crossing here, unblocking is the RIGHT
  response — the opposite of S18/S20. Tagged `ask_status=resolved` so nobody spends another ask.
- Network sha unchanged `a8b66226…`; all 10 invariants pass.

## Known trade-offs / follow-ups
- Emitted file ~530 KB (v1: 69 KB) — bundle 1.53 MB (was 1.25 MB). Needs a
  degree-2 chain-merge pass in the importer before any production ship.
- Geometry accuracy = artwork accuracy (±30–56 m at validated points).
- `tools/roads/connectors.gpx.geojson` kept only as a record — NOT applied.


## D87 remediation — the 15 Jul review (2026-07-15)
gpt-5.6-sol reviewed the 14 Jul work (`f271601..fb6554f`) and returned 7 findings.
**All accepted.** Verdict: *"I would not sign this off as-is."* Everything above this
section that contradicts what follows is **superseded** — counts, filenames and the
`no_crossing`/`private_no_guest_routing` statuses in particular. The authority is now
`tools/roads/crossing_decisions.json`, and `test_decision_consistency.py` fails if any
file drifts from it.

**What was wrong, and it was the same mistake three times — a conclusion outran its
evidence and was then written into a file as fact:**

- **F1 — S16/S21 were unblocked on an over-read.** "Part of the Mount Kenya River Road"
  and "Orphanage Road, looks good" NAME ROADS. Neither says the river join we inferred
  is a real, guest-drivable crossing. That is the rule stated 200 lines above in this
  very file — broken within the hour, on the next site. **Reblocked.** Measured cost:
  **zero POI pairs**, so there was never anything to gain. ~~S06 ("Crossing") speaks to
  drivability and alone recovers all three Kingfisher detours.~~ **CORRECTED 2026-07-15
  (D90 F2): "Crossing" speaks to TOPOLOGY, not drivability.** It is the same over-read this
  very finding is about, made in the sentence that describes the over-read. S06 alone does
  recover all three Kingfisher detours — that part is measured and true — but a route
  benefit is not permission. S06 is now cut pending an answer.
- **F2 — "opening S05 costs zero routes" is RETRACTED.** The experiment's extra node-pair
  lands in a component that gets pruned, so the identical SHA proved nothing; a plausible
  real connection moves 8/36 pairs. S05 stays cut, but as **unconfirmed + likely_endpoint**,
  not "permanent / no-crossing" — "I believe it's an end point" is hedged, and we do not
  launder a hedge into a fact.
- **F3/F4 — the client export asserted a falsehood.** It tagged ROAD EDGES by proximity to
  a crossing JOIN LINE — different objects — so it smeared a 15 m river-hop across whole
  ~600 m merged edges and declared *"the app will not route a guest onto it"* about edge
  204, which is **JW Marriott's only access road**. It also could not describe S05/S22 at
  all: an exporter iterating surviving edges can never label a crossing that was cut.
  **Fix:** roads carry NO access field (we have no Marriotts corridor geometry, so no such
  claim is substantiable), and blocked crossings get their own layer,
  `Solio_Roads_V2_WGS84_crossings.geojson`, where the claim is true.
- **F5/F6 — the invariants were theatre.** Emptying the blocker files made all ten checks
  PASS on a graph that crossed the old S18 blocker: the same file was both the blocking
  input and the expectation. `segs_cross` also missed an edge laid exactly ALONG a blocker
  — the node-pair connector case the importer explicitly handles. And nothing checked that
  the SHIPPED `roads.gis.ts` was the file being tested.
  **Fix:** inventory asserted against the manifest (emptying a blocker file now FAILS),
  shipped-file equality asserted, and a traversal predicate that is *spans-both-ends OR
  proper crossing* — adjacency is not a leak, since every road that stops at the river
  touches a join. Six fixtures pin it: my first two attempts both passed live data while
  misclassifying fixtures.
  **SUPERSEDED 2026-07-15 (D90 F3)** — see below; that predicate was wrong too, and the
  six fixtures did not pin it.

---

## 2026-07-15 — review round 3 (D90). Verdict: *do not sign off*.

Third adversarial review of this pipeline; third round that found real defects, this time in
round 2's fixes. Full spec: `Solio Vault/Roads Review — Findings & Remediation Spec`.

- **F1 (CRITICAL) — the parked private crossing bypassed every blocker.** `jw-bridge`, the
  Marriotts crossing, sits in `connectors.unconfirmed.geojson` marked `access=private`,
  `guest_routable=false`, "DO NOT RE-ADD for guest routing". The only thing keeping it out
  was that nobody passes that file to `--connectors` — and its predecessor note actively
  invited re-adding it ("when Callan confirms S20"; he has). Copied into
  `connectors.bridges.geojson` it imported **clean**: none of the eight S20 blockers reaches
  it (nearest endpoint 44.5 m > the 40 m tolerance; nearest midpoint 53.3 m > 12 m), the whole
  suite stayed green, gate→jw dropped 6.64 → 6.43 km **through the private drive**, and the
  exporter stripped `access` and shipped it to Callan as ordinary road.
  **Fix:** access policy is now IDENTITY, not proximity. `load_lines` refuses any line whose
  own properties say guests may not drive it — whatever file it is in, no override flag. An
  allow-list pins the active connector set by name for the one that arrives unmarked. A
  regression imports the real `jw-bridge` and proves it is rejected.
- **F2 (HIGH) — the "two axes" were one axis, and S06 was still promoted beyond evidence.**
  D89 named `crossing_exists` and `guest_routable` and then derived both from one `status`,
  so only three combinations existed and `load_manifest` rejected the rest. The case we
  actually had — *the crossing is real; nobody has asked whether guests may use it* — was
  **unrepresentable**, so it was rounded up to `confirmed`. Writing `routable_basis:
  inference` beside `guest_routable: true` labelled the guess without stopping the app acting
  on it. `routable_basis` was free text: setting S06 to `recorded-drive`, with zero recorded
  crossings, passed everything.
  **Fix:** both axes are stored, tri-state (`true|false|"unknown"`), neither derived. Cut
  unless `guest_routable is true`. `recorded-drive` is checked against the joins evidence.
  **S06 is re-blocked** at a measured cost of 15/36 POI pairs (worst +1.60 km, nothing
  unreachable), pending one question: *may guests drive through S06?*
- **F3 (HIGH) — the predicate was wrong for the fourth time, and the cutter never used it.**
  Despite the "ONE definition" comment, `cut_blocked_edges` reimplemented the rules with its
  own hard-coded 12 and 40: changing the cutter's tolerance to 11 left the suite green. The
  predicate itself was orientation-dependent (a segment touching a blocker end scored as a
  crossing written one way and not the other), read a road ending at a join's midpoint as a
  seam, missed a road connecting both ends via internal vertices, and accepted a 1.1 km
  U-shaped detour as a crossing.
  **Fix:** one `classify_blocker`, used by the cutter and the test, with one set of
  constants. Strict orientation-invariant straddle; seams require ≥90% along-join coverage;
  spanning requires the road to actually cover the join (≥50% of its length) and not wander
  (≤2.5×). 13 fixtures + boundary cases, including one live-data catch: a 557 m road *ending*
  at 30.7 m S18 scored as spanning it, because "near both ends" is satisfiable by a single
  point whenever the join is shorter than the 40 m tolerance. **The network is unchanged by
  every one of these fixes** — the bugs were real, the guarantee was false, the road data
  never happened to hit them.
- **F4 (MEDIUM) — the guards trusted the file they were checking.** `canonical_joins` reads
  geometry and evidence from the very file it then compares against, so those fields were
  canonical by definition: corrupting S06's geometry, or replacing its evidence with the
  fabrication *"recorded drive proves guests crossed here"*, passed. Setting `site` to `null`
  passed with "21 sites governed". The `assert` guarding the stale/evidence overlap is
  stripped by `python -O`.
  **Fix:** evidence is hashed against **git** (`f271601`, the last commit before decision text
  touched the file) — the one reference in this repo that cannot be edited to agree with a
  mistake. The inventory asserts exactly S01..S22. The assert is now a raise.
- **F5 (LOW) — duplicate JSON keys and stale prose.** A second top-level `description` reading
  "All crossings are confirmed safe" compared equal, because `json.loads` keeps the last of a
  duplicated key. **Fix:** duplicate keys raise; exports compare byte-for-byte.

Round 3 also confirmed, independently: the D89 evidence restore from `f271601` was exact
(all 208 notes, verified by hash); `fb6554f` was indeed already polluted; blocking S06 does
change 15/36 pairs; and the narrow name "private crossings not traversed" is honest.

**Current state (authoritative):**
- Cut pending an answer (`blockers.open.geojson`, renamed from `blockers.unconfirmed-crossings`
  — it now holds a crossing we know exists):
  - `crossing-unconfirmed` — **S05, S16, S21, S22** (10 joins): no established crossing.
  - `permission-unknown` — **S06** (1 join): crossing is real; nobody has asked about guests.
- Permanent (cut, never reopens): **S18/S20** `private-access` — 11 joins.
- Routable: the 15 sites proven by recorded drives. **No site is routable on words alone.**
- Network `03b6b66e…`; 450 edges; 207.9 km. Emitted TS is ~88 KB, chain-merged.
- Regenerate: `python3 tools/roads/build_blockers.py` then the importer with **both**
  `--block` files, then `export_v2_geojson.py`. `npm run test:roads` runs invariants +
  consistency (30 checks) and must pass before committing.
- Not deployed. `NAV_ENABLED` remains `false`, so no guest is routed anywhere by any of this.
