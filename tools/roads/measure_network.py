#!/usr/bin/env python3
"""Measure a generated roads.gis.ts: POI reachability, pairwise route lengths,
detour ratios vs straight line, and worst pairs. Usage:

    python3 tools/roads/measure_network.py src/data/roads.gis.ts [other.ts]

With two files, prints a per-POI-pair comparison (what a change broke/fixed).
"""
from __future__ import annotations

import heapq, json, math, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

# corner georef — must mirror src/data/reserve.ts (validated by import_gis_roads)
LNG0, LNG1, LAT0, LAT1, IW, IH = 36.849258, 37.002478, -0.090041, -0.305231, 2400, 3601
MLAT = 111320.0
MLNG = 111320.0 * math.cos(math.radians(-0.1975))


def px_world(x: float, y: float) -> tuple[float, float]:
    return (LNG0 + x / IW * (LNG1 - LNG0), LAT0 + y / IH * (LAT1 - LAT0))


def dist_m(a, b) -> float:
    return math.hypot((a[0] - b[0]) * MLNG, (a[1] - b[1]) * MLAT)


def load(ts_path: Path):
    src = ts_path.read_text()
    nodes: dict[str, tuple[float, float]] = {}
    for m in re.finditer(r'\{ id: "([^"]+)", pixel: \{ x: ([\d.]+), y: ([\d.]+) \} \}', src):
        nodes[m.group(1)] = px_world(float(m.group(2)), float(m.group(3)))
    adj: dict[str, list[tuple[str, float]]] = {k: [] for k in nodes}
    edge_re = re.compile(r'\{\s*a: "([^"]+)",\s*b: "([^"]+)",(.*?)\n  \},', re.S)
    for m in edge_re.finditer(src):
        a, b, body = m.group(1), m.group(2), m.group(3)
        via = [px_world(float(x), float(y)) for x, y in re.findall(r"\{ x: ([\d.]+), y: ([\d.]+) \}", body)]
        pts = [nodes[a], *via, nodes[b]]
        L = sum(dist_m(p, q) for p, q in zip(pts, pts[1:]))
        adj[a].append((b, L))
        adj[b].append((a, L))
    return nodes, adj


def dijkstra(adj, src: str) -> dict[str, float]:
    dist = {src: 0.0}
    pq = [(0.0, src)]
    while pq:
        d, u = heapq.heappop(pq)
        if d > dist.get(u, 1e18):
            continue
        for v, w in adj[u]:
            nd = d + w
            if nd < dist.get(v, 1e18):
                dist[v] = nd
                heapq.heappush(pq, (nd, v))
    return dist


def poi_ids() -> list[str]:
    src = (ROOT / "src/data/pois.ts").read_text()
    return re.findall(r'nodeId:\s*"([^"]+)"', src)


def measure(ts: Path):
    nodes, adj = load(ts)
    pois = [p for p in poi_ids() if p in nodes]
    missing = [p for p in poi_ids() if p not in nodes]
    routes: dict[tuple[str, str], float] = {}
    for i, a in enumerate(pois):
        dist = dijkstra(adj, a)
        for b in pois[i + 1:]:
            routes[(a, b)] = dist.get(b, float("inf"))
    return nodes, pois, missing, routes


def main() -> None:
    paths = [Path(p) for p in sys.argv[1:]] or [ROOT / "src/data/roads.gis.ts"]
    results = []
    for ts in paths:
        nodes, pois, missing, routes = measure(ts)
        size = ts.stat().st_size
        ratios = []
        unreach = []
        for (a, b), d in routes.items():
            sl = dist_m(nodes[a], nodes[b])
            if math.isinf(d):
                unreach.append((a, b))
            elif sl > 200:
                ratios.append((d / sl, a, b, d, sl))
        ratios.sort(reverse=True)
        print(f"\n=== {ts} ({size/1024:.0f} KB) ===")
        print(f"nodes {len(nodes)}; POIs bound {len(pois)}/{len(pois)+len(missing)}"
              + (f" (missing: {', '.join(missing)})" if missing else ""))
        if unreach:
            print(f"UNREACHABLE pairs: {['%s-%s' % p for p in unreach]}")
        if ratios:
            avg = sum(r[0] for r in ratios) / len(ratios)
            print(f"avg detour ratio {avg:.2f}; worst 3:")
            for r, a, b, d, sl in ratios[:3]:
                print(f"  {a}->{b}: {d/1000:.2f} km vs {sl/1000:.2f} km straight ({r:.1f}x)")
        results.append((ts, dict(routes)))

    if len(results) == 2:
        (ta, ra), (tb, rb) = results
        print(f"\n=== pairwise change {ta.name} -> {tb.name} (>10% or reachability) ===")
        for pair in sorted(ra):
            da, db = ra[pair], rb.get(pair, float("inf"))
            if math.isinf(da) and math.isinf(db):
                continue
            if math.isinf(db) and not math.isinf(da):
                print(f"  {pair[0]}->{pair[1]}: {da/1000:.2f} km -> UNREACHABLE")
            elif math.isinf(da) and not math.isinf(db):
                print(f"  {pair[0]}->{pair[1]}: unreachable -> {db/1000:.2f} km")
            elif da > 0 and abs(db - da) / da > 0.10:
                print(f"  {pair[0]}->{pair[1]}: {da/1000:.2f} km -> {db/1000:.2f} km ({(db-da)/da:+.0%})")


if __name__ == "__main__":
    main()
