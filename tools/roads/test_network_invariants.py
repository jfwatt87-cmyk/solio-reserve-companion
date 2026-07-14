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

    # 6. zero edges crossing a blocker. Two separate checks on purpose: one is a
    #    data gap we expect to clear when Callan answers, the other is a standing
    #    access decision that must NEVER clear. A failure in each means a
    #    different thing, so they must not share a verdict.
    import json

    def blocker_leaks(fname: str, reason: str | None = None) -> int:
        n = 0
        for f in json.load(open(HERE / fname))["features"]:
            if reason and f["properties"].get("reason") != reason:
                continue
            cs = [tuple(c) for c in f["geometry"]["coordinates"]]
            for a, b, via in edges:
                pts = edge_pts(a, b, via)
                if any(segs_cross(pts[k], pts[k + 1], cs[m2], cs[m2 + 1])
                       for k in range(len(pts) - 1) for m2 in range(len(cs) - 1)):
                    n += 1
        return n

    unconf = blocker_leaks("blockers.unconfirmed-crossings.geojson")
    check("safe mode holds", unconf == 0, f"{unconf} edges cross an unconfirmed crossing")

    # Guests must never be routed over the Marriotts private CROSSINGS (D80).
    # Deliberately narrow wording: this proves no edge traverses S18/S20, NOT that
    # the whole private drive is unreachable — we have no geometry for the drive
    # itself, and JW Marriott is a guest POI that must stay reachable. Do not
    # rename this to "private access closed"; it would claim more than it checks.
    priv = blocker_leaks("blockers.permanent.geojson", "private-access")
    check("private crossings not traversed", priv == 0,
          f"{priv} edges cross the Marriotts private crossings")

    # S05 Kingfisher Dam: Callan confirmed it's an end point, so there is no
    # crossing to route over. Separate from the private check — same outcome,
    # different fact, and a failure here would mean something quite different.
    nox = blocker_leaks("blockers.permanent.geojson", "no-crossing")
    check("no phantom crossings routed", nox == 0,
          f"{nox} edges cross a crossing that does not exist")

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
