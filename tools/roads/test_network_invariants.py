#!/usr/bin/env python3
"""Regression guard for the road-network pipeline. Regenerates the safe-mode
network into a temp file and asserts every invariant that has bitten us:

    python3 tools/roads/test_network_invariants.py     # exit 0 = all pass

Run after ANY change to import_gis_roads.py, the trace, connectors or
blockers, BEFORE committing a regenerated src/data/roads.gis.ts.
(The 2026-07-10 audit found 1,182 duplicate edges that lived in the shipped
network for weeks — checks 4 and 5 exist so that never happens again.)
"""
from __future__ import annotations

import math, re, subprocess, sys, tempfile
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
from measure_network import dist_m, load, poi_ids, dijkstra  # noqa: E402

failures: list[str] = []


def check(name: str, ok: bool, detail: str) -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: {detail}")
    if not ok:
        failures.append(name)


def segs_cross(p1, p2, p3, p4) -> bool:
    def o(a, b, c):
        v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        return 0 if abs(v) < 1e-18 else (1 if v > 0 else -1)
    return o(p1, p2, p3) != o(p1, p2, p4) and o(p3, p4, p1) != o(p3, p4, p2)


def main() -> None:
    out = Path(tempfile.mkstemp(suffix=".ts")[1])
    proc = subprocess.run(
        [sys.executable, str(HERE / "import_gis_roads.py"),
         str(HERE / "poster_roads.geojson"),
         "--connectors", str(HERE / "connectors.bridges.geojson"),
         "--block", str(HERE / "blockers.open.geojson"),
         "--block", str(HERE / "blockers.permanent.geojson"),
         "--out", str(out)],
        capture_output=True, text=True, cwd=ROOT)
    check("importer runs", proc.returncode == 0, f"exit {proc.returncode}")
    if proc.returncode != 0:
        print(proc.stdout[-2000:], proc.stderr[-2000:])
        sys.exit(1)

    nodes, adj = load(out)
    src = out.read_text()
    edges = []
    for m in re.finditer(r'\{\s*a: "([^"]+)",\s*b: "([^"]+)",(.*?)\n  \},', src, re.S):
        via = [(float(x), float(y)) for x, y in re.findall(r"\{ x: ([\d.]+), y: ([\d.]+) \}", m.group(3))]
        edges.append((m.group(1), m.group(2), via))

    # 1. POI binding: 9/10, only the airstrip may be unbound
    pois = poi_ids()
    missing = [p for p in pois if p not in nodes]
    check("POI binding", missing == ["airstrip"], f"{len(pois)-len(missing)}/{len(pois)} bound, missing={missing}")

    # 2. size bands (update deliberately when the network genuinely changes)
    check("node count", 330 <= len(nodes) <= 400, f"{len(nodes)} nodes")
    check("edge count", 420 <= len(edges) <= 480, f"{len(edges)} edges")

    # 3. total length
    from measure_network import px_world  # noqa: E402
    def edge_pts(a, b, via):
        return [nodes[a], *[px_world(x, y) for x, y in via], nodes[b]]
    total = sum(sum(dist_m(p, q) for p, q in zip(pts, pts[1:]))
                for pts in (edge_pts(*e) for e in edges))
    check("total length", 195_000 <= total <= 220_000, f"{total/1000:.1f} km")

    # 4. zero exact/reversed duplicate geometries
    keys = Counter()
    for a, b, via in edges:
        k = (a, b, tuple(via))
        keys[min(k, (b, a, tuple(reversed(via))))] += 1
    surplus = sum(n - 1 for n in keys.values() if n > 1)
    check("no exact duplicates", surplus == 0, f"{surplus} surplus copies")

    # 5. zero same-endpoint corridor duplicates (geometry within 15 m end-to-end).
    # The predicate is the IMPORTER's, not a copy: this check used to reimplement it, and the
    # copy compared each pair in arbitrary order rather than longer-against-shorter. A via-less
    # edge is just its two endpoints, which for a same-endpoints pair sit exactly on the other
    # edge — so it read as a duplicate of any road joining those nodes, and the g212/g293 loop
    # tripped it the moment the S06 cut produced one (D90). Same bug, same cause, as the
    # traversal predicate: two implementations of one rule.
    from import_gis_roads import within_corridor, CORRIDOR_TOL_M  # noqa: E402

    def edge_len_m(pts):
        return sum(dist_m(p, q) for p, q in zip(pts, pts[1:]))

    by_pair: dict[frozenset, list] = {}
    for a, b, via in edges:
        if a != b:
            by_pair.setdefault(frozenset((a, b)), []).append(edge_pts(a, b, via))
    corridor = 0
    for group in by_pair.values():
        group = sorted(group, key=edge_len_m)      # shortest first — as the importer keeps it
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                if within_corridor(group[j], group[i], CORRIDOR_TOL_M):
                    corridor += 1
    check("no corridor duplicates", corridor == 0, f"{corridor} same-corridor pairs")

    # 6. Blockers. Three failures were possible here and all three were live (D87 F5/F6):
    #
    #  (a) VACUOUS PASS. The checks read the same file the importer used as --block, so
    #      emptying it removed the blocking AND the expectation together — all ten checks
    #      passed on a graph that crossed the old S18 blocker. A guard that dies with its
    #      own spec is not a guard. Fixed by asserting the INVENTORY against the manifest.
    #  (b) BLIND PREDICATE. `segs_cross` is strict intersection: an edge exactly OVERLAPPING
    #      a blocker, or running COLLINEARLY through it, returned False — precisely the
    #      node-pair and healed-seam cases the importer handles. Fixed with a distance
    #      predicate, which catches overlap, collinear and endpoint-touch alike.
    #  (c) UNCHECKED SHIP. The test regenerated a network and never compared it to the one
    #      actually committed, so a stale or hand-edited roads.gis.ts passed.
    import json

    # THE predicate — imported from the importer, not reimplemented. Reimplementing it is
    # how this went wrong three times: every version of mine passed live data while
    # misclassifying fixtures (vertex-only distance missed a long edge passing through;
    # endpoint-touch scored as a crossing; "reaches both ends" flagged a U-shaped road that
    # goes the long way round). The test must ask the same question the importer answered.
    from import_gis_roads import realises_blocker

    def traverses(pts, cs) -> bool:
        return realises_blocker(pts, cs)

    def blocker_leaks(fname: str, reason: str | None = None) -> int:
        n = 0
        for f in json.load(open(HERE / fname))["features"]:
            if reason and f["properties"].get("reason") != reason:
                continue
            cs = [tuple(c) for c in f["geometry"]["coordinates"]]
            for a, b, via in edges:
                if traverses(edge_pts(a, b, via), cs):
                    n += 1
        return n

    # (a) INVENTORY, from the manifest — this is what makes the checks non-vacuous.
    man = json.loads((HERE / "crossing_decisions.json").read_text())["sites"]
    joins = json.load(open(HERE.parent / "gis" / "Solio_Joins_Best_Guess.geojson"))["features"]
    from build_blockers import blocked  # noqa: E402  — one definition of "is this cut"
    want: dict[str, int] = {}
    for jf in joins:
        sid = jf["properties"].get("site")
        if sid in man and blocked(man[sid]):
            want[sid] = want.get(sid, 0) + 1
    got: dict[str, int] = {}
    for fname in ("blockers.open.geojson", "blockers.permanent.geojson"):
        for f in json.load(open(HERE / fname))["features"]:
            sid = f["properties"]["site"]
            got[sid] = got.get(sid, 0) + 1
    check("blocker inventory matches manifest", got == want and bool(want),
          f"{sum(got.values())} joins across {sorted(got)}"
          + ("" if got == want else f" — EXPECTED {want}"))

    # Every site the manifest says is cut must actually be blocked, and none other.
    cut_sites = {s for s, v in man.items() if blocked(v)}
    check("cut sites match manifest", set(got) == cut_sites,
          f"blocked={sorted(got)} manifest={sorted(cut_sites)}")

    unconf = blocker_leaks("blockers.open.geojson")
    check("safe mode holds", unconf == 0, f"{unconf} edges traverse an unanswered crossing")

    # (b2) WHICH connectors are in the graph — by name, against an allow-list. Blockers are a
    # policy on PLACES and reach only as far as their geometry: none of the eight S20 blockers
    # comes within 44 m of `jw-bridge`, the parked Marriotts private crossing, so re-adding it
    # to connectors.bridges.geojson imported clean, cut gate->jw from 6.64 to 6.43 km through
    # the private drive, and left this entire suite green (D90 F1). The importer now refuses a
    # line marked `access=private`; this catches the one that arrives unmarked.
    ALLOWED_CONNECTORS = {"tharua-bridge", "browns-bridge"}
    active = set(re.search(r"active connectors: (.*)", proc.stdout).group(1).split())
    check("only allow-listed connectors are in the graph", active == ALLOWED_CONNECTORS,
          f"active={sorted(active)}" + ("" if active == ALLOWED_CONNECTORS
                                        else f" — EXPECTED {sorted(ALLOWED_CONNECTORS)}"))

    # (b3) ...and the refusal itself works. Import the real parked jw-bridge and require the
    # importer to reject it. Without this, the guard above is a claim, not a fact.
    with tempfile.TemporaryDirectory() as td:
        evil = Path(td) / "evil.geojson"
        bridges = json.load(open(HERE / "connectors.bridges.geojson"))
        parked = json.load(open(HERE / "connectors.unconfirmed.geojson"))
        bridges["features"].extend(parked["features"])
        evil.write_text(json.dumps(bridges))
        p2 = subprocess.run(
            [sys.executable, str(HERE / "import_gis_roads.py"), str(HERE / "poster_roads.geojson"),
             "--connectors", str(evil), "--out", str(Path(td) / "o.ts")],
            capture_output=True, text=True, cwd=ROOT)
        refused = p2.returncode != 0 and "jw-bridge" in (p2.stdout + p2.stderr)
        check("importer refuses the parked private crossing", refused,
              "re-adding jw-bridge to the connectors is rejected"
              if refused else f"IMPORTED A PRIVATE CROSSING — exit {p2.returncode}")

    # Guests must never be routed over the Marriotts private CROSSINGS (D80).
    # Deliberately narrow wording: this proves no edge traverses S18/S20, NOT that
    # the whole private drive is unreachable — we have no geometry for the drive
    # itself, and JW Marriott is a guest POI that must stay reachable. Do not
    # rename this to "private access closed"; it would claim more than it checks.
    priv = blocker_leaks("blockers.permanent.geojson", "private-access")
    check("private crossings not traversed", priv == 0,
          f"{priv} edges traverse the Marriotts private crossings")

    # (c) the SHIPPED file, not just a regenerable one
    shipped = (ROOT / "src/data/roads.gis.ts").read_text()
    check("shipped network is the generated one", shipped == src,
          "src/data/roads.gis.ts matches this build"
          if shipped == src else "src/data/roads.gis.ts DIFFERS — stale or hand-edited")

    # 6b. The predicate itself, on fixtures. Without these the traversal test is
    # unfalsifiable: FOUR attempts at this predicate passed against live data while
    # misclassifying fixtures — vertex-only distance missed a long edge passing through,
    # endpoint-touch was scored as a crossing, `pts[len//2]` read a 2-point join's END as
    # its middle, and "a point of the road is near each end" read a road STOPPING at a
    # 30 m join as spanning it. Live data never happened to hit any of them. The network
    # sha is identical across all four, which is exactly why the sha proves nothing here.
    #
    # Fixtures are built in a local METRE frame, because every rule below is about metres
    # and degrees-of-longitude hide the arithmetic. Blocker: a 100 m join, W to E.
    from import_gis_roads import M_PER_DEG_LNG, M_PER_DEG_LAT  # noqa: E402
    LNG0, LAT0 = 36.90, -0.20

    def P(x, y):
        return (LNG0 + x / M_PER_DEG_LNG, LAT0 + y / M_PER_DEG_LAT)

    def L(*xy):
        return [P(x, y) for x, y in xy]

    blk = L((-50, 0), (50, 0))
    fixtures = [
        # --- must cut: the road really does realise the join ---
        ("connector end-to-end on the join", L((-50, 0), (50, 0)), True),
        ("collinear through", L((-150, 0), (150, 0)), True),
        ("healed seam inside a long edge", L((-200, 0), (-50, 0), (50, 0), (200, 0)), True),
        ("proper X crossing", L((0, -40), (0, 40)), True),
        ("reaches both ends via INTERNAL vertices", L((-50, -100), (-50, 0), (0, 12.5), (50, 0), (50, -100)), True),
        # --- must not cut: adjacency, detours, near misses ---
        ("ends at one end (adjacency)", L((-200, -3), (-50, 0)), False),
        ("harmless parallel road", L((-50, 90), (50, 90)), False),
        ("touches an end (orientation A)", L((-50, 60), (-50, 0)), False),
        ("touches an end (orientation B) — same line reversed", L((-50, 0), (-50, 60)), False),
        ("ends at the join's MIDPOINT", L((0, 60), (0, 0)), False),
        ("long way round: U-shape reaching both ends", L((-50, 0), (-50, -500), (50, -500), (50, 0)), False),
        # --- tolerance boundaries: the rules must bite where they say they do ---
        ("reach at 40.0 m — inside pair_tol", L((-50, 40.0), (50, 40.0)), True),
        ("reach at 40.1 m — outside pair_tol", L((-50, 40.1), (50, 40.1)), False),
    ]
    bad = [n for n, e, want in fixtures if traverses(e, blk) != want]
    check("traversal predicate fixtures", not bad,
          f"{len(fixtures) - len(bad)}/{len(fixtures)} correct"
          + (f" — MISCLASSIFIED {bad}" if bad else ""))

    # 6c. A road ending at a join SHORTER than pair_tol. Live S18 is 30.7 m and the
    # tolerance is 40 m, so "near both ends" is satisfiable by a single point: the 557 m
    # road g354->g192 that merely stops there scored as spanning it, with an along-road
    # span of 0.0 m. The live private-crossing check caught this one — fixture it so the
    # next rewrite cannot reintroduce it quietly.
    short_join = L((0, 0), (0, 30.7))
    long_road = L((0, 0), (300, -40), (557, -40))
    check("road ending at a join shorter than the tolerance is not a span",
          not traverses(long_road, short_join),
          "557 m road stopping at a 30.7 m join does not realise it")

    # 7. every bound POI reachable from the gate
    dist = dijkstra(adj, "gate")
    unreachable = [p for p in pois if p in nodes and p != "gate" and math.isinf(dist.get(p, float("inf")))]
    check("all POIs reachable", not unreachable, f"unreachable={unreachable}")

    out.unlink()
    if failures:
        print(f"\n{len(failures)} invariant(s) FAILED: {', '.join(failures)}")
        sys.exit(1)
    print("\nall network invariants hold")


if __name__ == "__main__":
    main()
