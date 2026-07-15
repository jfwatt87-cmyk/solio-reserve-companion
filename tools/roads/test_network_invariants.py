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
         "--block", str(HERE / "blockers.unconfirmed-crossings.geojson"),
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

    # 5. zero same-endpoint corridor duplicates (geometry within 15 m end-to-end)
    def seg_pt(p, a, b):
        ax, ay = a; bx, by = b; px_, py_ = p
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px_ - ax) * dx + (py_ - ay) * dy) / L2))
        return math.hypot(px_ - (ax + t * dx), py_ - (ay + t * dy))
    M = 111_320.0 * math.cos(math.radians(-0.1975)), 110_574.0
    def metres(pt):
        return (pt[0] * M[0], pt[1] * M[1])
    by_pair: dict[frozenset, list] = {}
    for a, b, via in edges:
        if a != b:
            by_pair.setdefault(frozenset((a, b)), []).append([metres(p) for p in edge_pts(a, b, via)])
    corridor = 0
    for group in by_pair.values():
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                gi, gj = group[i], group[j]
                if all(min(seg_pt(p, gj[k], gj[k + 1]) for k in range(len(gj) - 1)) <= 15
                       for p in gi):
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

    from export_v2_geojson import seg_point_m  # point-to-SEGMENT; shared, so it cannot drift

    BLOCK_M = 15.0

    def _near(pt, pts) -> bool:
        """Distance from a point to the POLYLINE — not to its vertices. Vertex-only
        distance misses a long simplified edge that passes straight through with no
        vertex there, which is exactly how a leak would hide."""
        return min(seg_point_m(pt, pts[k], pts[k + 1]) for k in range(len(pts) - 1)) < BLOCK_M

    def _crosses_properly(p1, p2, p3, p4) -> bool:
        """Transversal intersection ONLY — no endpoint-touch, no collinear degeneracy.
        Plain `segs_cross` returns True when an edge merely ENDS on the join, which
        every road that legitimately stops at the river does (`jw`'s own approach)."""
        def o(a, b, c):
            v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
            return 0 if abs(v) < 1e-18 else (1 if v > 0 else -1)
        o1, o2, o3, o4 = o(p1, p2, p3), o(p1, p2, p4), o(p3, p4, p1), o(p3, p4, p2)
        if 0 in (o1, o2, o3, o4):
            return False
        return o1 != o2 and o3 != o4

    def traverses(pts, cs) -> bool:
        """Does this edge REALISE the blocked join — get you from one side to the other?

        A join line spans the gap between two road ends A and B. An edge realises it if
        it reaches BOTH ends (the node-pair connector and healed-seam cases — invisible
        to strict intersection, D87 F6), or crosses the line transversally (driving over
        the river). Merely touching one end is ADJACENCY: expected, correct, not a leak.
        Every road that stops at the water does it.
        """
        if _near(cs[0], pts) and _near(cs[-1], pts):
            return True
        return any(_crosses_properly(pts[k], pts[k + 1], cs[i], cs[i + 1])
                   for k in range(len(pts) - 1) for i in range(len(cs) - 1))

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
    want: dict[str, int] = {}
    for jf in joins:
        sid = jf["properties"].get("site")
        if sid in man and man[sid]["status"] != "confirmed":
            want[sid] = want.get(sid, 0) + 1
    got: dict[str, int] = {}
    for fname in ("blockers.unconfirmed-crossings.geojson", "blockers.permanent.geojson"):
        for f in json.load(open(HERE / fname))["features"]:
            sid = f["properties"]["site"]
            got[sid] = got.get(sid, 0) + 1
    check("blocker inventory matches manifest", got == want and bool(want),
          f"{sum(got.values())} joins across {sorted(got)}"
          + ("" if got == want else f" — EXPECTED {want}"))

    # Every site the manifest says is cut must actually be blocked, and none other.
    cut_sites = {s for s, v in man.items() if v["status"] != "confirmed"}
    check("cut sites match manifest", set(got) == cut_sites,
          f"blocked={sorted(got)} manifest={sorted(cut_sites)}")

    unconf = blocker_leaks("blockers.unconfirmed-crossings.geojson")
    check("safe mode holds", unconf == 0, f"{unconf} edges traverse an unconfirmed crossing")

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
    # unfalsifiable: my first two attempts BOTH passed against live data while
    # misclassifying fixtures — vertex-only distance missed a long edge passing
    # through, and endpoint-touch was scored as a crossing. Live data simply never
    # happened to hit either. Fixtures are the only reason we know it works.
    blk = [(36.0, -0.20), (36.001, -0.20)]
    fixtures = [
        ("exact overlap (node-pair connector)", [(36.0, -0.20), (36.001, -0.20)], True),
        ("collinear through", [(35.999, -0.20), (36.002, -0.20)], True),
        ("healed seam inside a long edge", [(35.99, -0.20), (36.0005, -0.20), (36.01, -0.20)], True),
        ("proper X crossing", [(36.0005, -0.201), (36.0005, -0.199)], True),
        ("ends at one end (adjacency)", [(36.0, -0.20), (36.0, -0.199)], False),
        ("harmless parallel road", [(36.0, -0.2009), (36.001, -0.2009)], False),
    ]
    bad = [n for n, e, want in fixtures if traverses(e, blk) != want]
    check("traversal predicate fixtures", not bad,
          f"{len(fixtures) - len(bad)}/{len(fixtures)} correct"
          + (f" — MISCLASSIFIED {bad}" if bad else ""))

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
