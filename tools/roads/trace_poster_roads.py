#!/usr/bin/env python3
"""Trace the complete drawn road network off the poster basemap.

WHY: the app displays the poster (solio-truenorth.jpg, the exact image the
tiles are cut from), and the poster is the most COMPLETE road source we hold —
cross-validation (2026-07-09) showed Callan's GIS roads layer is missing whole
drawn corridors (orphanage/gate river roads, Rhino Gate access, the western
inside-fence track) while containing ~25 km of bare fence line and ~45 km of
undrawn management tracks. Tracing the drawn artwork through the deployment
georeference produces GPS-true geometry (validated ±~30–56 m) that also sits
EXACTLY on what guests see.

Pipeline: grey road-pixel mask -> morphological close (heals bridge icons /
river overdraw / text breaks) -> Zhang-Suen thinning -> skeleton graph
(junctions + runs) -> prune specks & far-outside artwork -> GeoJSON
(EPSG:4326) for import_gis_roads.py.

Outputs tools/roads/poster_roads.geojson. Pure numpy+PIL, no GDAL needed.
"""
from __future__ import annotations

import json, math, sys
from pathlib import Path

import numpy as np
from PIL import Image

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
Image.MAX_IMAGE_PIXELS = None

META = json.load(open(ROOT / "src/assets/solio-truenorth.json"))
M = META["merc2px"]; PW, PH = META["px"]
RAD = 6378137.0
DET = M[0] * M[4] - M[1] * M[3]

def tn(lng, lat):
    x = math.radians(lng) * RAD
    y = math.log(math.tan(math.pi / 4 + math.radians(lat) / 2)) * RAD
    return (M[0] * x + M[1] * y + M[2], M[3] * x + M[4] * y + M[5])

def tn_inv(px, py):
    ux, uy = px - M[2], py - M[5]
    x = (M[4] * ux - M[1] * uy) / DET
    y = (-M[3] * ux + M[0] * uy) / DET
    return (math.degrees(x / RAD), math.degrees(2 * math.atan(math.exp(y / RAD)) - math.pi / 2))

MLAT = 111320.0
MLNG = 111320.0 * math.cos(math.radians(-0.1975))

def meters(a, b):
    return math.hypot((a[0] - b[0]) * MLNG, (a[1] - b[1]) * MLAT)

# ---------------------------------------------------------------- mask
def road_mask(img: np.ndarray) -> np.ndarray:
    """Grey drawn-road pixels: low chroma, mid value (calibrated 2026-07-09:
    roads sample mean RGB ~(83,89,82); paper ~cream >200; art/labels chromatic)."""
    r, g, b = img[:, :, 0], img[:, :, 1], img[:, :, 2]
    ch = np.abs(r - g) + np.abs(g - b)
    v = img.mean(axis=2)
    # roads are neutral-to-slightly-green grey (sample mean 83,89,82 -> b-r ~ -1);
    # the salt-pan stipple is BLUE-grey (b > r), which otherwise welds a phantom
    # web onto the network once closed+skeletonized — exclude the blue tint.
    return (ch < 26) & (v < 185) & (v > 55) & ((b - r) < 6)

def shift_or(a: np.ndarray, n: int) -> np.ndarray:
    for _ in range(n):
        b = a.copy()
        b[1:, :] |= a[:-1, :]; b[:-1, :] |= a[1:, :]
        b[:, 1:] |= a[:, :-1]; b[:, :-1] |= a[:, 1:]
        a = b
    return a

def shift_and(a: np.ndarray, n: int) -> np.ndarray:
    for _ in range(n):
        b = a.copy()
        b[1:, :] &= a[:-1, :]; b[:-1, :] &= a[1:, :]
        b[:, 1:] &= a[:, :-1]; b[:, :-1] &= a[:, 1:]
        a = b
    return a

# ------------------------------------------------------ Zhang-Suen thinning
def skeletonize(img: np.ndarray, max_iter=80) -> np.ndarray:
    img = img.astype(np.uint8)
    def neighbours(i):
        p2 = np.roll(i, -1, 0); p3 = np.roll(np.roll(i, -1, 0), 1, 1)
        p4 = np.roll(i, 1, 1);  p5 = np.roll(np.roll(i, 1, 0), 1, 1)
        p6 = np.roll(i, 1, 0);  p7 = np.roll(np.roll(i, 1, 0), -1, 1)
        p8 = np.roll(i, -1, 1); p9 = np.roll(np.roll(i, -1, 0), -1, 1)
        return p2, p3, p4, p5, p6, p7, p8, p9
    for it in range(max_iter):
        changed = False
        for step in (0, 1):
            p2, p3, p4, p5, p6, p7, p8, p9 = neighbours(img)
            B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
            seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2]
            A = sum(((seq[k] == 0) & (seq[k + 1] == 1)).astype(np.uint8) for k in range(8))
            if step == 0:
                cond = (img == 1) & (B >= 2) & (B <= 6) & (A == 1) & (p2 * p4 * p6 == 0) & (p4 * p6 * p8 == 0)
            else:
                cond = (img == 1) & (B >= 2) & (B <= 6) & (A == 1) & (p2 * p4 * p8 == 0) & (p2 * p6 * p8 == 0)
            if cond.any():
                img[cond] = 0
                changed = True
        if not changed:
            break
    return img.astype(bool)

# ------------------------------------------------------ skeleton -> graph
def skeleton_graph(skel: np.ndarray):
    """Walk skeleton runs between junction/endpoint pixels. Returns list of
    pixel polylines [(y,x), ...]."""
    ys, xs = np.nonzero(skel)
    pix = set(zip(ys.tolist(), xs.tolist()))
    NB = [(-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1)]
    def nbrs(p):
        return [(p[0] + dy, p[1] + dx) for dy, dx in NB if (p[0] + dy, p[1] + dx) in pix]
    deg = {p: len(nbrs(p)) for p in pix}
    nodes = {p for p, d in deg.items() if d != 2}
    runs = []
    used = set()
    for n in nodes:
        for nb in nbrs(n):
            key = (n, nb)
            if key in used:
                continue
            run = [n, nb]
            used.add(key); used.add((nb, n))
            prev, cur = n, nb
            while cur not in nodes:
                nxt = [q for q in nbrs(cur) if q != prev]
                if not nxt:
                    break
                prev, cur = cur, nxt[0]
                run.append(cur)
                used.add((prev, cur)); used.add((cur, prev))
            runs.append(run)
    # isolated loops (all deg==2) — rare; pick them up too
    covered = {p for r in runs for p in r}
    for p in pix - covered - nodes:
        run = [p]
        prev, cur = None, p
        while True:
            nxt = [q for q in nbrs(cur) if q != prev]
            if not nxt:
                break
            prev, cur = cur, nxt[0]
            if cur == p or cur in covered:
                break
            run.append(cur)
        covered |= set(run)
        if len(run) > 8:
            runs.append(run)
    return runs

def simplify(run, every=6):
    pts = run[::every]
    if pts[-1] != run[-1]:
        pts.append(run[-1])
    return pts

def main():
    print("loading poster…")
    img = np.asarray(Image.open(ROOT / "src/assets/solio-truenorth.jpg").convert("RGB")).astype(np.int16)
    mask = road_mask(img)
    print("mask px:", int(mask.sum()))
    # heal small breaks (bridge icons, river overdraw, labels): close with n=5
    closed = shift_and(shift_or(mask, 5), 5)
    print("skeletonizing…")
    skel = skeletonize(closed)
    print("skeleton px:", int(skel.sum()))
    runs = skeleton_graph(skel)
    print("raw runs:", len(runs))

    # boundary for outside-clipping
    B = json.load(open(ROOT / "tools/gis/layers/Boundary_Solio_Game_reserve.geojson"))
    bg = B["features"][0]["geometry"]
    bring = bg["coordinates"][0][0] if bg["type"] == "MultiPolygon" else bg["coordinates"][0]
    def pt_seg_m(p, a, b):
        ax = (a[0] - p[0]) * MLNG; ay = (a[1] - p[1]) * MLAT
        bx = (b[0] - p[0]) * MLNG; by = (b[1] - p[1]) * MLAT
        dx = bx - ax; dy = by - ay; l2 = dx * dx + dy * dy
        if l2 == 0:
            return math.hypot(ax, ay)
        t = max(0.0, min(1.0, -(ax * dx + ay * dy) / l2))
        return math.hypot(ax + t * dx, ay + t * dy)
    def d_boundary(p):
        return min(pt_seg_m(p, bring[k], bring[k + 1]) for k in range(len(bring) - 1))
    def inside(p):
        x, y = p; c = False
        for k in range(len(bring) - 1):
            x1, y1 = bring[k]; x2, y2 = bring[k + 1]
            if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
                c = not c
        return c

    # ---- component-aware filtering: never drop a run that CONNECTS the network.
    # Group runs into connected components via shared endpoints, drop speck
    # components (< 150 m total) and far-outside artwork components, then prune
    # only DANGLING micro-spurs (< 35 m with a free end) inside kept components.
    polys = []
    for run in runs:
        ll = [tn_inv(x, y) for y, x in simplify(run)]
        L = sum(meters(ll[i], ll[i + 1]) for i in range(len(ll) - 1))
        polys.append({"ll": ll, "len": L, "a": run[0], "b": run[-1]})
    # union endpoints (skeleton junction pixels coincide exactly)
    parent = list(range(len(polys)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]; i = parent[i]
        return i
    def union(i, j):
        ri, rj = find(i), find(j)
        if ri != rj:
            parent[ri] = rj
    end_ix = {}
    for i, p in enumerate(polys):
        for e in (p["a"], p["b"]):
            if e in end_ix:
                union(i, end_ix[e])
            else:
                end_ix[e] = i
    # ---- graph healing: bridge decks & icon-broken spots. The mask excludes
    # blue-tinted pixels, so roads BREAK where they cross water — join free
    # endpoints within 70 m (a bridge-deck length), midpoint in/near the
    # reserve, and LOG every heal (they're the river crossings).
    deg_all = {}
    for p in polys:
        for e in (p["a"], p["b"]):
            deg_all[e] = deg_all.get(e, 0) + 1
    free = [(e, i) for i, p in enumerate(polys) for e in (p["a"], p["b"]) if deg_all[e] == 1]
    # water mask (dilated) — allows LONGER heals only across drawn water, i.e.
    # a genuine bridge deck; away from water the cap stays tight so parallel
    # dead-ends can't get falsely joined.
    wr, wb = img[:, :, 0], img[:, :, 2]
    water = shift_or(((wb - wr) > 25) & (img.mean(axis=2) < 210) & (img.mean(axis=2) > 50), 8)
    # spatial bin at ~20px
    binsz = 20
    grid = {}
    for e, i in free:
        grid.setdefault((e[0] // binsz, e[1] // binsz), []).append((e, i))
    heals = []
    healed_ends = set()
    for e, i in free:
        if e in healed_ends:
            continue
        by, bx = e[0] // binsz, e[1] // binsz
        best = None
        for dy in (-2, -1, 0, 1, 2):
            for dx in (-2, -1, 0, 1, 2):
                for e2, j in grid.get((by + dy, bx + dx), []):
                    if e2 == e or e2 in healed_ends or find(i) == find(j):
                        continue
                    d_px = math.hypot(e[0] - e2[0], e[1] - e2[1])
                    if d_px > 40:
                        continue
                    if d_px > 20:
                        # long heal: only across drawn water (a bridge deck)
                        myx, myy = (e[1] + e2[1]) // 2, (e[0] + e2[0]) // 2
                        if not water[myy, myx]:
                            continue
                    if best is None or d_px < best[0]:
                        best = (d_px, e2, j)
        if best:
            d_px, e2, j = best
            llA = tn_inv(e[1], e[0]); llB = tn_inv(e2[1], e2[0])
            mid = ((llA[0] + llB[0]) / 2, (llA[1] + llB[1]) / 2)
            # guard: keep heals in/near the reserve (never bridge out to the
            # public roads beyond the fence)
            if not inside(mid) and d_boundary(mid) > 150:
                continue
            heals.append({"llA": [round(c, 6) for c in llA], "llB": [round(c, 6) for c in llB],
                          "gap_m": round(meters(llA, llB), 1)})
            polys.append({"ll": [llA, llB], "len": meters(llA, llB), "a": e, "b": e2, "heal": True})
            parent.append(len(polys) - 1)
            union(len(polys) - 1, i); union(len(polys) - 1, j)
            healed_ends.add(e); healed_ends.add(e2)
    print(f"healed {len(heals)} breaks (bridge decks / icon gaps) — logged")
    json.dump(heals, open(HERE / "poster_trace_heals.json", "w"), indent=1)
    comps = {}
    for i in range(len(polys)):
        comps.setdefault(find(i), []).append(i)

    feats = []
    kept_km = 0.0
    dropped_speck = dropped_out = pruned_spur = 0
    for members in comps.values():
        total = sum(polys[i]["len"] for i in members)
        if total < 150:
            dropped_speck += len(members)
            continue
        # component-level outside test (sampled)
        pts = [p for i in members for p in polys[i]["ll"][:: max(1, len(polys[i]["ll"]) // 6)]]
        if min((0 if inside(p) else d_boundary(p)) for p in pts[:: max(1, len(pts) // 40)]) > 1100:
            dropped_out += len(members)
            continue
        # ITERATIVE leaf pruning: repeatedly drop dangling spurs < 60 m so
        # skeleton fuzz (rough road edges, stipple tendrils) melts away without
        # ever cutting a through-connection.
        alive = set(members)
        while True:
            deg = {}
            for i in alive:
                for e in (polys[i]["a"], polys[i]["b"]):
                    deg[e] = deg.get(e, 0) + 1
            drop = {i for i in alive
                    if polys[i]["len"] < 60 and (deg[polys[i]["a"]] == 1 or deg[polys[i]["b"]] == 1)}
            if not drop:
                break
            pruned_spur += len(drop)
            alive -= drop
        # merge degree-2 chains so the emitted network carries only real
        # junctions (file size: thousands of 9 m stub edges -> hundreds of
        # roads), then Douglas-Peucker at ~6 m which is invisible at map scale.
        deg2 = {}
        for i in alive:
            for e in (polys[i]["a"], polys[i]["b"]):
                deg2[e] = deg2.get(e, 0) + 1
        end_map = {}
        for i in alive:
            for e in (polys[i]["a"], polys[i]["b"]):
                end_map.setdefault(e, []).append(i)
        visited = set()
        def rdp(pts, eps=6.0):
            if len(pts) < 3:
                return pts
            a, b = pts[0], pts[-1]
            dmax, idx = -1.0, 0
            for k in range(1, len(pts) - 1):
                ax = (a[0] - pts[k][0]) * MLNG; ay = (a[1] - pts[k][1]) * MLAT
                bx = (b[0] - pts[k][0]) * MLNG; by = (b[1] - pts[k][1]) * MLAT
                dx = bx - ax; dy = by - ay; l2 = dx * dx + dy * dy
                d = math.hypot(ax, ay) if l2 == 0 else abs(ax * dy - ay * dx) / math.sqrt(l2)
                if d > dmax:
                    dmax, idx = d, k
            if dmax <= eps:
                return [a, b]
            return rdp(pts[: idx + 1], eps)[:-1] + rdp(pts[idx:], eps)
        def oriented(i, start):
            p = polys[i]
            return p["ll"] if p["a"] == start else list(reversed(p["ll"]))
        for i in alive:
            if i in visited:
                continue
            # walk backwards to a chain start (junction / endpoint / loop guard)
            start_i, start_e = i, polys[i]["a"]
            guard = 0
            while deg2[start_e] == 2 and guard < 100000:
                nxts = [j for j in end_map[start_e] if j != start_i and j in alive]
                if not nxts or nxts[0] in visited or nxts[0] == i:
                    break
                start_i = nxts[0]
                start_e = polys[start_i]["a"] if polys[start_i]["b"] == start_e else polys[start_i]["b"]
                guard += 1
            # walk forward assembling the chain
            chain = []
            cur_i, cur_e = start_i, start_e
            while True:
                visited.add(cur_i)
                seg = oriented(cur_i, cur_e)
                chain += seg if not chain else seg[1:]
                far = polys[cur_i]["b"] if polys[cur_i]["a"] == cur_e else polys[cur_i]["a"]
                if deg2[far] != 2:
                    break
                nxts = [j for j in end_map[far] if j != cur_i and j in alive and j not in visited]
                if not nxts:
                    break
                cur_i, cur_e = nxts[0], far
            pts = rdp(chain)
            L = sum(meters(pts[k], pts[k + 1]) for k in range(len(pts) - 1))
            kept_km += L / 1000
            feats.append({"type": "Feature",
                          "properties": {"name": "", "surface": "dirt", "source": "poster-trace"},
                          "geometry": {"type": "LineString", "coordinates": [list(q) for q in pts]}})
    print(f"kept {len(feats)} runs, {kept_km:.1f} km "
          f"(dropped {dropped_speck} speck-runs, {dropped_out} outside-runs, pruned {pruned_spur} micro-spurs)")
    out = HERE / "poster_roads.geojson"
    json.dump({"type": "FeatureCollection", "features": feats}, open(out, "w"))
    print("wrote", out)

if __name__ == "__main__":
    main()
