#!/usr/bin/env python3
"""Import Solio's GIS road centrelines into the app's road-network format.

Reads a GeoJSON FeatureCollection of road-centreline LineStrings (EPSG:4326
lon,lat — see GIS_ROADS_SPEC.md), nodes the lines into a routing graph at
shared / touching endpoints, carries the `name` and `surface` properties, and
emits `src/data/roads.gis.ts` in exactly the shape `src/data/roads.ts` uses.
The app (src/data/roadSource.ts) prefers roads.gis.ts whenever it exists.

POI binding: tours and navigation route to well-known node ids (gate, lodge,
orphanage, airstrip, jw, kingfisher, yellowthorn, naribo, choroa, rhinogate).
Each POI's verified position (from src/data/pois.ts) is projected onto the
nearest imported road *edge* (within --poi-radius metres, default 800); the
edge is split at that point and the new node adopts the POI's id, so a POI
beside a through-road binds to the closest point on the road rather than to a
possibly-distant junction. When the projection lands on an existing junction
(within the snap tolerance) that junction adopts the id directly.

Usage:
    python3 tools/roads/import_gis_roads.py <roads.geojson>
    python3 tools/roads/import_gis_roads.py <roads.geojson> --out src/data/roads.gis.ts

No third-party dependencies; plain Python 3.

Coordinate note: pixels in the emitted file are authored 2400x3601 basemap
pixels, produced with the EXACT inverse of reserve.ts's corner georeference, so
`pixelWorld()` reproduces the original GPS coordinates loss-free (affine).
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Must mirror src/data/reserve.ts CONTROL_POINTS / IMAGE_WIDTH / IMAGE_HEIGHT.
LNG0, LNG1 = 36.849258, 37.002478
LAT0, LAT1 = -0.090041, -0.305231
IW, IH = 2400, 3601

M_PER_DEG_LAT = 111_320.0
M_PER_DEG_LNG = 111_320.0 * math.cos(math.radians((LAT0 + LAT1) / 2))

SNAP_M = 25.0          # endpoints closer than this are the same junction (overridable via --snap)
SURFACES = {"graded", "dirt", "4x4"}


def world_to_pixel(lng: float, lat: float) -> tuple[float, float]:
    return (
        (lng - LNG0) / (LNG1 - LNG0) * IW,
        (lat - LAT0) / (LAT1 - LAT0) * IH,
    )


def dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot((a[0] - b[0]) * M_PER_DEG_LNG, (a[1] - b[1]) * M_PER_DEG_LAT)


def project_to_segment(
    p: tuple[float, float], a: tuple[float, float], b: tuple[float, float]
) -> tuple[float, tuple[float, float], float]:
    """Project p onto segment a-b. Returns (t in [0,1], projection lng/lat,
    perpendicular distance in metres). Local equirectangular metre frame — fine
    at reserve scale."""
    pax, pay = (a[0] - p[0]) * M_PER_DEG_LNG, (a[1] - p[1]) * M_PER_DEG_LAT
    pbx, pby = (b[0] - p[0]) * M_PER_DEG_LNG, (b[1] - p[1]) * M_PER_DEG_LAT
    dx, dy = pbx - pax, pby - pay
    l2 = dx * dx + dy * dy
    if l2 == 0.0:
        return 0.0, a, math.hypot(pax, pay)
    t = max(0.0, min(1.0, -(pax * dx + pay * dy) / l2))
    cx, cy = pax + t * dx, pay + t * dy
    proj = (a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]))
    return t, proj, math.hypot(cx, cy)


def bind_pois_to_edges(
    nodes: list[tuple[float, float]],
    edges: list[dict],
    pois: list[tuple[str, float, float]],
    radius: float,
) -> dict[int, str]:
    """Bind each POI to the nearest point on the road network, splitting the
    edge there when the point falls mid-segment. Mutates `nodes`/`edges` in
    place (only appends nodes / splits edges — existing indices stay valid) and
    returns {node_index: poi_id}. POIs farther than `radius` from any road warn
    and are left unbound (routes to them will fail)."""
    claimed: dict[int, str] = {}
    for poi_id, lng, lat in pois:
        p = (lng, lat)
        best = None  # (dist_m, edge_index, seg_k, t, projection)
        for ei, e in enumerate(edges):
            pts = e["pts"]
            for k in range(len(pts) - 1):
                t, proj, d = project_to_segment(p, pts[k], pts[k + 1])
                if best is None or d < best[0]:
                    best = (d, ei, k, t, proj)
        if best is None or best[0] > radius:
            print(f"  WARNING: no road within {radius:.0f} m of POI '{poi_id}' — "
                  "routes to it will fail until the network reaches it")
            continue
        d, ei, k, _t, proj = best
        e = edges[ei]
        na, nb = e["a"], e["b"]
        snap = None
        if dist_m(proj, nodes[na]) <= SNAP_M:
            snap = na
        elif dist_m(proj, nodes[nb]) <= SNAP_M:
            snap = nb
        # A snap onto a junction already owned by another POI would overwrite
        # it — refuse: the nearest road only reaches an existing POI's node, so
        # this POI is effectively unserved by the export.
        if snap is not None and snap in claimed:
            print(f"  WARNING: nearest road for POI '{poi_id}' ({d:.0f} m) is the "
                  f"node already bound to '{claimed[snap]}' — leaving '{poi_id}' "
                  "unbound (the export has no road of its own reaching it)")
            continue
        if snap is not None:
            target = snap
        else:
            target = len(nodes)
            nodes.append(proj)
            pts = e["pts"]
            left = pts[: k + 1] + [proj]
            right = [proj] + pts[k + 1 :]
            edges[ei] = {"a": na, "b": target, "name": e["name"], "surface": e["surface"], "pts": left}
            edges.append({"a": target, "b": nb, "name": e["name"], "surface": e["surface"], "pts": right})
        claimed[target] = poi_id
        print(f"  poi '{poi_id}' -> node {target} ({d:.0f} m)"
              + ("  [on junction]" if target in (na, nb) else "  [split edge]"))
    return claimed


def closed_to_guests(props: dict) -> str | None:
    """Reason this line is marked closed to guests, or None. IDENTITY, not geometry.

    D90 F1. `connectors.unconfirmed.geojson` parks `jw-bridge` — the Marriotts private
    crossing — carrying `access=private`, `guest_routable=false` and a note reading "DO NOT
    RE-ADD for guest routing". The ONLY thing keeping it out of the graph was that nobody
    passes that file to --connectors. Copy it into connectors.bridges.geojson (which the
    note's own predecessor invited: "re-add when Callan confirms S20" — and he has now
    confirmed it) and it imports clean: the S20 blockers do NOT catch it (nearest endpoint
    44.5 m > BLOCK_PAIR_TOL_M=40; nearest midpoint 53.3 m > BLOCK_TOL_M=12), the whole suite
    stays green, gate->jw drops 6.64 -> 6.43 km through the private drive, and the exporter
    strips `access` and ships it to the client as ordinary road.

    Proximity blockers are a policy on PLACES. This is a policy on THIS LINE. A line whose
    own properties say guests may not use it must never become routable road, whatever file
    it is in and whatever the blocker geometry does or does not reach.
    """
    access = str(props.get("access", "") or "").strip().lower()
    if access in ("private", "no", "closed", "restricted"):
        return f"access={access!r}"
    gr = props.get("guest_routable")
    if gr is False or (isinstance(gr, str) and gr.strip().lower() in ("false", "no")):
        return f"guest_routable={gr!r}"
    return None


def load_lines(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    if data.get("type") != "FeatureCollection":
        sys.exit("error: expected a GeoJSON FeatureCollection")
    lines = []
    refused = []
    for i, f in enumerate(data.get("features", [])):
        geom = f.get("geometry") or {}
        props = f.get("properties") or {}
        # Refuse LOUDLY rather than skip quietly: a private line reaching this importer means
        # someone believed it belonged in the network, and that belief needs correcting, not
        # silently honouring. There is no flag to override this — reopening a private crossing
        # is Solio's decision to make in crossing_decisions.json, not the importer's.
        if (why := closed_to_guests(props)) is not None:
            refused.append(f"    {path.name} feature {i} ({props.get('fix') or props.get('name') or '?'}): {why}")
            continue
        coords_sets: list[list[list[float]]]
        if geom.get("type") == "LineString":
            coords_sets = [geom["coordinates"]]
        elif geom.get("type") == "MultiLineString":
            coords_sets = geom["coordinates"]
        else:
            print(f"  skipping feature {i}: geometry {geom.get('type')!r}")
            continue
        surface = str(props.get("surface", "dirt")).lower()
        if surface not in SURFACES:
            surface = "dirt"
        for coords in coords_sets:
            pts = [(float(c[0]), float(c[1])) for c in coords]
            if len(pts) < 2:
                continue
            lines.append({"pts": pts, "name": str(props.get("name", "") or ""),
                          "surface": surface, "fix": str(props.get("fix", "") or "") or None})
    if refused:
        sys.exit("error: refusing to import line(s) whose own properties say guests may not "
                 "drive them:\n" + "\n".join(refused) +
                 "\n  These are closed by DECISION, not by geometry. If Solio has reopened one, "
                 "change its status in tools/roads/crossing_decisions.json and remove the "
                 "access/guest_routable marking deliberately — do not route around this check.")
    if not lines:
        sys.exit("error: no LineString features found")
    return lines


class _Grid:
    """Spatial hash over lng/lat points so proximity queries are O(1)-ish —
    the naive all-pairs scans made large traces (34k lines) take tens of
    minutes; this brings the whole noding pass to seconds."""

    def __init__(self, cell_m: float):
        self.cell = cell_m
        self.cells: dict[tuple[int, int], list[int]] = {}
        self.pts: list[tuple[float, float]] = []

    def _key(self, p: tuple[float, float]) -> tuple[int, int]:
        return (int(p[0] * M_PER_DEG_LNG // self.cell), int(p[1] * M_PER_DEG_LAT // self.cell))

    def add(self, p: tuple[float, float]) -> int:
        i = len(self.pts)
        self.pts.append(p)
        self.cells.setdefault(self._key(p), []).append(i)
        return i

    def near(self, p: tuple[float, float], r: float):
        kx, ky = self._key(p)
        span = int(r // self.cell) + 1
        for dx in range(-span, span + 1):
            for dy in range(-span, span + 1):
                for i in self.cells.get((kx + dx, ky + dy), []):
                    if dist_m(p, self.pts[i]) <= r:
                        yield i


def node_lines(lines: list[dict]) -> tuple[list[tuple[float, float]], list[dict]]:
    """Split lines where another line's endpoint touches them, then cluster
    endpoints into shared junction nodes. Returns (nodes, edges)."""
    ep_grid = _Grid(max(SNAP_M, 1.0))
    for ln in lines:
        ep_grid.add(ln["pts"][0])
        ep_grid.add(ln["pts"][-1])

    # split any line at interior vertices that coincide with some endpoint
    split: list[dict] = []
    for ln in lines:
        pts = ln["pts"]
        cut = [0]
        for i in range(1, len(pts) - 1):
            if next(ep_grid.near(pts[i], SNAP_M), None) is not None:
                cut.append(i)
        cut.append(len(pts) - 1)
        for a, b in zip(cut, cut[1:]):
            if b > a:
                split.append({**ln, "pts": pts[a : b + 1]})

    # cluster endpoints -> nodes
    nodes: list[tuple[float, float]] = []
    node_grid = _Grid(max(SNAP_M, 1.0))

    def node_id(p: tuple[float, float]) -> int:
        # Match the pre-grid semantics exactly: the LOWEST-index node within
        # range wins (insertion-order chaining) — an arbitrary cell-order match
        # splits clusters differently and fragments the graph.
        hits = list(node_grid.near(p, SNAP_M))
        if hits:
            return min(hits)
        node_grid.add(p)
        nodes.append(p)
        return len(nodes) - 1

    edges = []
    for ln in split:
        a = node_id(ln["pts"][0])
        b = node_id(ln["pts"][-1])
        if a == b and len(ln["pts"]) < 4:
            continue  # zero-length stub
        edges.append({"a": a, "b": b, "name": ln["name"], "surface": ln["surface"], "pts": ln["pts"]})
    return nodes, edges


def keep_largest_component(
    nodes: list[tuple[float, float]], edges: list[dict]
) -> tuple[list[tuple[float, float]], list[dict]]:
    """Drop disconnected fragments so the routing graph is a single connected
    network — a stray road stub that doesn't join the network can never be
    navigated to/from, and a disjoint graph yields dead-end routes. Keeps the
    largest component and reindexes; POIs then bind only to routable roads."""
    adj: dict[int, list[int]] = {i: [] for i in range(len(nodes))}
    for e in edges:
        adj[e["a"]].append(e["b"])
        adj[e["b"]].append(e["a"])
    seen: set[int] = set()
    best: set[int] = set()
    for start in range(len(nodes)):
        if start in seen:
            continue
        comp: set[int] = set()
        stack = [start]
        while stack:
            u = stack.pop()
            if u in comp:
                continue
            comp.add(u)
            seen.add(u)
            stack.extend(v for v in adj[u] if v not in comp)
        if len(comp) > len(best):
            best = comp
    if len(best) == len(nodes):
        return nodes, edges
    keep = sorted(best)
    remap = {old: i for i, old in enumerate(keep)}
    new_nodes = [nodes[old] for old in keep]
    new_edges = [
        {**e, "a": remap[e["a"]], "b": remap[e["b"]]}
        for e in edges
        if e["a"] in remap and e["b"] in remap
    ]
    print(f"  pruned {len(nodes) - len(best)} node(s) in disconnected fragment(s) "
          f"— kept the {len(best)}-node connected network")
    return new_nodes, new_edges


def load_blocker_lines(paths: list[Path]) -> list[list[tuple[float, float]]]:
    """Blocker lines: joins the evidence does NOT support (e.g. unconfirmed
    river crossings). Any edge realising one of these joins is cut."""
    blockers: list[list[tuple[float, float]]] = []
    for p in paths:
        data = json.loads(Path(p).read_text())
        for f in data.get("features", []):
            g = f.get("geometry") or {}
            lines = [g["coordinates"]] if g.get("type") == "LineString" else (
                g["coordinates"] if g.get("type") == "MultiLineString" else [])
            for line in lines:
                blockers.append([(float(c[0]), float(c[1])) for c in line])
    return blockers


def _segs_properly_intersect(p1, p2, p3, p4) -> bool:
    """Strict transversal: each segment straddles the other's line.

    ORIENTATION-INVARIANT (D90 F3). The old form tested `(d1 > 0) != (d2 > 0)`, which reads a
    zero — a point exactly ON the other line — as "negative side". So a segment TOUCHING the
    blocker's end scored as a crossing written one way round and not the other: reversing the
    line's own vertex order changed the answer. A touch is not a crossing in either order, so
    every determinant must be strictly non-zero for this to be a straddle.
    """
    def side(a, b, c) -> int:
        v = (c[1] - a[1]) * (b[0] - a[0]) - (b[1] - a[1]) * (c[0] - a[0])
        return 0 if abs(v) < 1e-18 else (1 if v > 0 else -1)
    d1, d2 = side(p3, p4, p1), side(p3, p4, p2)
    d3, d4 = side(p1, p2, p3), side(p1, p2, p4)
    if 0 in (d1, d2, d3, d4):
        return False        # touching / collinear — handled by the span forms, not here
    return d1 != d2 and d3 != d4


# The ONE definition of "this edge realises a blocked join". Both the importer (which
# cuts) and test_network_invariants.py (which proves none survived) call this — so the
# safety oracle and the implementation oracle cannot disagree. They did before: the test
# used strict segment intersection while the importer used node-pairs + seam overlap, so
# the test could not see the very cases the importer was built to handle (D87 F6, D89).
#
# Do not reimplement this predicate anywhere. Two forms, matching cut_blocked_edges:
#   (a) span     — the road runs the join: reaches both ends, covers it, doesn't wander
#   (b) crossing — the road properly straddles the join (drives over it)
#
# There was a third, "seam: the blocker's MIDPOINT lies on the road". It is gone. Its history
# is the whole argument for deleting it rather than keeping it as a safety net:
#   D89: it was `line[len(line)//2]`, which for a 2-VERTEX line — nearly every join — returns
#        the LAST vertex, so it asked "is the join's END near this road?", true of every road
#        that merely stops at the river. Adjacency read as a seam, in the routine that CUTS.
#   D90: rewritten to sample the join and require 90% coverage — at which point it became
#        provably UNREACHABLE. It can only fire when both join ends are >40 m from the road
#        while >=90% of the join is within 12 m of it, and the span form claims every such
#        case first. A hooked join with 200 m hooks does not reach it.
# A branch that cannot run, guarded by a tolerance no fixture pins, is not a safety net — it
# is a place for a bug to live undisturbed, which is exactly what it did for two rounds.
BLOCK_PAIR_TOL_M = 40.0


def poly_len(line) -> float:
    return sum(dist_m(a, b) for a, b in zip(line, line[1:]))


def nearest_on_poly(q, poly) -> tuple[float, float]:
    """(perpendicular distance to poly, distance ALONG poly to that closest point), metres."""
    best_d, best_s, run = None, 0.0, 0.0
    for a, b in zip(poly, poly[1:]):
        t, _proj, d = project_to_segment(q, a, b)
        seg = dist_m(a, b)
        if best_d is None or d < best_d:
            best_d, best_s = d, run + t * seg
        run += seg
    return (best_d if best_d is not None else math.inf), best_s


# How far the road may wander between the join's two ends and still BE that join. A crossing
# is a short hop over a river; a road that reaches both banks 1.1 km apart the long way round
# is a legitimate detour, not the crossing (D90 F3).
DETOUR_FACTOR = 2.5
DETOUR_SLACK_M = 40.0
# ...and it must actually GO from one bank to the other. Requiring only "a point of the road is
# near each end" is satisfied by a SINGLE point whenever the join is shorter than pair_tol —
# which is most of them (S18 is 30.7 m vs a 40 m tolerance). That read the 557 m road ENDING at
# S18 as spanning it: both ends of the join were within 40 m of the road's last vertex, giving
# an along-road span of 0.0 m. Adjacency misread as traversal — the same mistake as the D89
# midpoint bug, in the fix for the D90 one. The road must cover the join, not just touch it.
SPAN_MIN_FRAC = 0.5


def classify_blocker(pts, line, pair_tol: float = BLOCK_PAIR_TOL_M):
    """How this edge realises this blocked join, or None. THE single classifier.

    Both `cut_blocked_edges` (which cuts) and test_network_invariants.py (which proves none
    survived) call this. They must not merely agree in spirit: the cutter used to reimplement
    the rules with its own hard-coded 12 and 40, so changing the cutter's tolerance to 11 left
    the whole suite green — the safety oracle could not see the cutter's actual behaviour
    (D90 F3). There is one implementation and one set of constants.

    Returns (kind, lo_m, hi_m) where kind is:
      "span"     the road runs the join — reaches both ends, covers it, does not wander.
                 Cut that SPAN out (this is also the healed-seam case: a join lying along
                 part of a long edge has both ends ON the edge and a span of ~its length).
      "crossing" the road strictly straddles the join. Cut the edge whole.
    A road merely touching, or ending at, the join is NEITHER: that is a road stopping at the
    river bank, which is exactly what an unbuilt crossing looks like.
    """
    blen = poly_len(line)
    # (a) reaches BOTH ends of the join — and gets between them directly enough to BE it
    d0, s0 = nearest_on_poly(line[0], pts)
    d1, s1 = nearest_on_poly(line[-1], pts)
    if d0 <= pair_tol and d1 <= pair_tol:
        span = abs(s1 - s0)
        if blen * SPAN_MIN_FRAC <= span <= max(blen * DETOUR_FACTOR, blen + DETOUR_SLACK_M):
            return ("span", min(s0, s1), max(s0, s1))
    # (b) strict transversal
    if any(_segs_properly_intersect(pts[i], pts[i + 1], line[j], line[j + 1])
           for i in range(len(pts) - 1) for j in range(len(line) - 1)):
        return ("crossing", None, None)
    return None


def realises_blocker(pts, line, pair_tol: float = BLOCK_PAIR_TOL_M) -> bool:
    return classify_blocker(pts, line, pair_tol) is not None


def cut_blocked_edges(
    nodes: list[tuple[float, float]], edges: list[dict],
    blockers: list[list[tuple[float, float]]],
) -> list[dict]:
    """Remove every realisation of a blocked join. Three forms:
    (a) an edge directly connecting the nodes at the join's endpoints
        (vertex-snapped connectors);
    (b) a healed seam INSIDE a longer edge — the blocker lies along part of the
        edge polyline; the overlapping SPAN is cut out (surgical split), leaving
        the rest of the road intact;
    (c) an edge properly crossing the blocker (cut whole — it drives over the
        unverified crossing).

    Every rule and tolerance comes from classify_blocker — this routine decides only what to
    DO about a realisation, never whether there is one (D90 F3)."""

    def nearest_vertex_idx(pts, p):
        return min(range(len(pts)), key=lambda i: dist_m(pts[i], p))

    out: list[dict] = []
    cuts = 0
    hit: set[int] = set()
    queue = list(edges)
    while queue:
        e = queue.pop()
        pts = e["pts"]
        acted = False
        done = e.get("_done") or set()
        for bi, line in enumerate(blockers):
            if bi in done:
                continue  # this lineage already had blocker bi cut out
            r = classify_blocker(pts, line)
            if r is None:
                continue
            hit.add(bi)
            cuts += 1
            acted = True
            if r[0] == "crossing":
                break       # drives over the join — the whole edge goes
            # span: remove the overlapped stretch, leaving the rest of the road intact
            i0 = nearest_vertex_idx(pts, line[0])
            i1 = nearest_vertex_idx(pts, line[-1])
            lo, hi = min(i0, i1), max(i0, i1)
            if hi == lo:  # blocker shorter than vertex spacing — still
                hi = min(lo + 1, len(pts) - 1)  # remove one whole segment
                lo = max(0, lo - (1 if hi == lo else 0))
            left, right = pts[: lo + 1], pts[hi:]
            # each remnant becomes a stub ending at a NEW node
            for part in (left, right):
                if len(part) >= 2 and sum(
                    dist_m(a, b) for a, b in zip(part, part[1:])
                ) > 5:
                    nid = len(nodes)
                    nodes.append(part[-1] if part is left else part[0])
                    stub = dict(e)
                    stub["pts"] = part
                    stub["_done"] = done | {bi}
                    if part is left:
                        stub["b"] = nid
                    else:
                        stub["a"] = nid
                    queue.append(stub)  # re-check: another blocker may overlap
            break
        if not acted:
            out.append(e)
    unrealised = len(blockers) - len(hit)
    print(f"  blocked joins: {cuts} cut(s); {len(hit)}/{len(blockers)} blocker(s) realised in "
          f"the graph, ~{max(unrealised, 0)} not present")
    return out


def _rdp(pts: list[tuple[float, float]], eps_m: float) -> list[tuple[float, float]]:
    """Iterative Douglas–Peucker in metres (no recursion — chains can be long)."""
    if len(pts) < 3:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        if b - a < 2:
            continue
        worst_d, worst_i = -1.0, -1
        for i in range(a + 1, b):
            _t, _proj, d = project_to_segment(pts[i], pts[a], pts[b])
            if d > worst_d:
                worst_d, worst_i = d, i
        if worst_d > eps_m:
            keep[worst_i] = True
            stack.append((a, worst_i))
            stack.append((worst_i, b))
    return [p for p, k in zip(pts, keep) if k]


def _edge_len(e: dict) -> float:
    return sum(dist_m(a, b) for a, b in zip(e["pts"], e["pts"][1:]))


def dedupe_parallel_edges(edges: list[dict]) -> list[dict]:
    """The poster trace double-draws some corridors, yielding two near-identical
    edges between the same junction pair. Keep the shorter when the pair is
    within 20% in length (a genuine second road between the same junctions is
    much longer than its sibling)."""
    by_pair: dict[frozenset, list[dict]] = {}
    for e in edges:
        if e["a"] == e["b"]:
            by_pair.setdefault(("loop", id(e)), []).append(e)  # never dedupe loops
        else:
            by_pair.setdefault(frozenset((e["a"], e["b"])), []).append(e)
    out: list[dict] = []
    dropped = 0
    for group in by_pair.values():
        group = sorted(group, key=_edge_len)
        keep = [group[0]]
        for e in group[1:]:
            if _edge_len(e) <= _edge_len(keep[0]) * 1.2:
                dropped += 1  # near-duplicate parallel — drop
            else:
                keep.append(e)  # genuinely different road
        out.extend(keep)
    if dropped:
        print(f"  deduped {dropped} near-duplicate parallel edge(s)")
    return out


CORRIDOR_TOL_M = 15.0


def within_corridor(cand_pts, kept_pts, tol_m: float = CORRIDOR_TOL_M) -> bool:
    """Does `cand` run the same physical road as `kept`? Every point of cand within tol of kept.

    DIRECTIONAL, and that matters: it must be asked of the LONGER edge against the SHORTER
    (see dedupe_same_corridor). Asked the other way it is nearly always true and means nothing
    — a via-less edge consists of just its two endpoints, which for a same-endpoints pair lie
    exactly ON the other edge, so it scores as a duplicate of every road joining those nodes.
    test_network_invariants.py reimplemented this rule without the ordering and reported the
    g212/g293 loop as a duplicate the moment one appeared (D90). Shared, so it cannot drift.
    """
    def seg_point_m(p, a, b) -> float:
        ax, ay = a[0] * M_PER_DEG_LNG, a[1] * M_PER_DEG_LAT
        bx, by = b[0] * M_PER_DEG_LNG, b[1] * M_PER_DEG_LAT
        px_, py_ = p[0] * M_PER_DEG_LNG, p[1] * M_PER_DEG_LAT
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px_ - ax) * dx + (py_ - ay) * dy) / L2))
        return math.hypot(px_ - (ax + t * dx), py_ - (ay + t * dy))

    return all(
        min(seg_point_m(p, kept_pts[j], kept_pts[j + 1]) for j in range(len(kept_pts) - 1)) <= tol_m
        for p in cand_pts
    )


def dedupe_same_corridor(edges: list[dict], tol_m: float = CORRIDOR_TOL_M) -> list[dict]:
    """After chain-merge, the double-drawn poster corridors surface as two (or
    three) edges between the same junction pair whose geometry runs the same
    physical road. The stub-level length heuristic can't catch these (short
    parallel stubs differ >1.2x in length from snap noise), so test geometry:
    drop the longer edge of a same-endpoints pair iff EVERY point of it lies
    within tol_m of the kept edge — a genuine second road (loop) diverges."""
    by_pair: dict[frozenset, list[dict]] = {}
    loops: list[dict] = []
    for e in edges:
        if e["a"] == e["b"]:
            loops.append(e)
        else:
            by_pair.setdefault(frozenset((e["a"], e["b"])), []).append(e)
    out: list[dict] = list(loops)
    dropped = 0
    for group in by_pair.values():
        group = sorted(group, key=_edge_len)   # shortest first: it is the one we keep
        keep = [group[0]]
        for e in group[1:]:
            if any(within_corridor(e["pts"], k["pts"], tol_m) for k in keep):
                dropped += 1
            else:
                keep.append(e)
        out.extend(keep)
    if dropped:
        print(f"  corridor-deduped {dropped} duplicate parallel edge(s)")
    return out


def merge_chains(
    nodes: list[tuple[float, float]], edges: list[dict], simplify_m: float
) -> tuple[list[tuple[float, float]], list[dict]]:
    """Collapse degree-2 nodes so every edge runs junction-to-junction with the
    geometry carried in `via` vertices, then Douglas–Peucker the polylines.
    This is what turns 4,300 two-point stubs into a few hundred real edges."""
    edges = [dict(e) for e in edges]
    while True:
        inc: dict[int, list[int]] = {}
        for ei, e in enumerate(edges):
            inc.setdefault(e["a"], []).append(ei)
            inc.setdefault(e["b"], []).append(ei)
        consumed: set[int] = set()
        merges: list[tuple[int, int, int]] = []  # (node, e1, e2)
        for n, eis in inc.items():
            if len(eis) != 2:
                continue
            e1i, e2i = eis
            if e1i == e2i or e1i in consumed or e2i in consumed:
                continue  # self-loop at n, or edge already part of another merge
            if edges[e1i]["a"] == edges[e1i]["b"] or edges[e2i]["a"] == edges[e2i]["b"]:
                continue
            merges.append((n, e1i, e2i))
            consumed.add(e1i)
            consumed.add(e2i)
        if not merges:
            break
        applied = 0
        dead: set[int] = set()
        for n, e1i, e2i in merges:
            e1, e2 = edges[e1i], edges[e2i]
            p1 = e1["pts"] if e1["b"] == n else list(reversed(e1["pts"]))
            a = e1["a"] if e1["b"] == n else e1["b"]
            p2 = e2["pts"] if e2["a"] == n else list(reversed(e2["pts"]))
            b = e2["b"] if e2["a"] == n else e2["a"]
            if a == b:
                continue  # merging would create a loop — leave the pair split
            applied += 1
            edges.append({
                "a": a, "b": b,
                "name": e1["name"] or e2["name"],
                "surface": e1["surface"],
                "pts": p1 + p2[1:],
            })
            dead.add(e1i)
            dead.add(e2i)
        edges = [e for ei, e in enumerate(edges) if ei not in dead]
        if not applied:
            break  # every remaining candidate is a would-be loop — done

    for e in edges:
        e["pts"] = _rdp(e["pts"], simplify_m)

    # drop nodes no edge references any more, reindexing
    used = sorted({e["a"] for e in edges} | {e["b"] for e in edges})
    remap = {old: i for i, old in enumerate(used)}
    new_nodes = [nodes[old] for old in used]
    for e in edges:
        e["a"] = remap[e["a"]]
        e["b"] = remap[e["b"]]
    print(f"  chain-merged -> {len(new_nodes)} node(s), {len(edges)} edge(s) "
          f"(simplified at {simplify_m:g} m)")
    return new_nodes, edges


def load_pois() -> list[tuple[str, float, float]]:
    """(nodeId, lng, lat) for each POI, via the corner georeference."""
    src = (ROOT / "src/data/pois.ts").read_text()
    out = []
    # each POI object lists `pixel: {...}` immediately before `nodeId: "..."`
    for m in re.finditer(
        r'pixel:\s*\{\s*x:\s*([\d.]+),\s*y:\s*([\d.]+)\s*\},\s*nodeId:\s*"([^"]+)"', src
    ):
        x, y = float(m.group(1)), float(m.group(2))
        lng = LNG0 + x / IW * (LNG1 - LNG0)
        lat = LAT0 + y / IH * (LAT1 - LAT0)
        out.append((m.group(3), lng, lat))
    return out


def main() -> None:
    global SNAP_M
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("geojson", type=Path)
    ap.add_argument("--out", type=Path, default=ROOT / "src/data/roads.gis.ts")
    ap.add_argument("--poi-radius", type=float, default=800.0,
                    help="max metres from a POI to its network node (default 800)")
    ap.add_argument("--snap", type=float, default=SNAP_M,
                    help="metres within which two road endpoints are the same junction (default 25)")
    ap.add_argument("--connectors", type=Path, action="append", default=[],
                    help="extra GeoJSON of connector centrelines to node into the network "
                         "(e.g. tools/roads/connectors.gpx.geojson — real tracks recovered from the "
                         "GPX survey to bridge gaps the export left disconnected). Repeatable.")
    ap.add_argument("--block", type=Path, action="append", default=[],
                    help="GeoJSON of join lines the evidence does NOT support (e.g. unconfirmed "
                         "river crossings) — every edge realising one is cut before routing. "
                         "Repeatable.")
    ap.add_argument("--simplify", type=float, default=6.0,
                    help="Douglas-Peucker tolerance in metres for edge geometry (default 6; 0 disables)")
    args = ap.parse_args()

    SNAP_M = args.snap

    import time as _time
    _t0 = _time.time()
    def _stage(msg):
        print(f"  [{_time.time()-_t0:7.1f}s] {msg}", flush=True)
    lines = load_lines(args.geojson)
    _stage(f"loaded {len(lines)} lines")
    active: set[str] = set()
    for cpath in args.connectors:
        extra = load_lines(cpath)
        ids = sorted(x["fix"] for x in extra if x.get("fix"))
        active.update(ids)
        print(f"  + {len(extra)} connector line(s) from {cpath.name}: {', '.join(ids) or '(unnamed)'}")
        lines.extend(extra)
    # Every connector that reaches the graph is named in the output, so the invariants can
    # assert the ACTIVE SET against an allow-list. `closed_to_guests` catches a line that
    # admits what it is; this catches one that does not (D90 F1).
    print(f"  active connectors: {' '.join(sorted(active)) or '(none)'}")
    nodes, edges = node_lines(lines)
    _stage(f"noded: {len(nodes)} nodes, {len(edges)} edges")
    if args.block:
        blockers = load_blocker_lines(args.block)
        print(f"  blocking {len(blockers)} unsupported join(s) from {', '.join(p.name for p in args.block)}")
        edges = cut_blocked_edges(nodes, edges, blockers)
        _stage("blockers cut")
    nodes, edges = keep_largest_component(nodes, edges)
    _stage("largest component kept")
    edges = dedupe_parallel_edges(edges)
    _stage("parallels deduped")
    if args.simplify >= 0:
        nodes, edges = merge_chains(nodes, edges, args.simplify)
        # double-drawn corridors survive as same-endpoints parallels; dropping
        # them frees new degree-2 chains, so dedupe+merge until stable
        while True:
            before = len(edges)
            edges = dedupe_same_corridor(edges)
            if len(edges) == before:
                break
            nodes, edges = merge_chains(nodes, edges, args.simplify)
        _stage("chains merged + corridors deduped")
    print(f"read {len(lines)} centreline(s) -> {len(nodes)} node(s), {len(edges)} edge(s)")

    # bind POI ids onto the nearest road edge (splitting mid-segment as needed)
    claimed = bind_pois_to_edges(nodes, edges, load_pois(), args.poi_radius)
    ids = [claimed.get(i, f"g{i + 1}") for i in range(len(nodes))]

    def px(p: tuple[float, float]) -> str:
        x, y = world_to_pixel(*p)
        return f"{{ x: {x:.1f}, y: {y:.1f} }}"

    node_lines_ts = "\n".join(
        f'  {{ id: "{ids[i]}", pixel: {px(n)} }},' for i, n in enumerate(nodes)
    )
    edge_blocks = []
    for e in edges:
        via = ", ".join(px(p) for p in e["pts"][1:-1])
        edge_blocks.append(
            "  {\n"
            f'    a: "{ids[e["a"]]}",\n'
            f'    b: "{ids[e["b"]]}",\n'
            f'    name: "{e["name"]}",\n'
            f'    type: "{e["surface"]}",\n'
            f"    via: [{via}],\n"
            "  },"
        )
    edges_ts = "\n".join(edge_blocks)

    out = f"""/**
 * GENERATED by tools/roads/import_gis_roads.py — DO NOT EDIT BY HAND.
 *
 * Road network imported from Solio's GIS road-centreline export
 * (see tools/roads/GIS_ROADS_SPEC.md). Same shape as roads.ts; the app
 * prefers this file when present (src/data/roadSource.ts).
 */

import {{ pixelWorld }} from "./reserve";
import {{ RoadNetwork, type RoadClass, type RoadEdge, type RouteNode }} from "../lib/routing";
import type {{ Pixel }} from "../lib/georef";

interface RawNode {{
  id: string;
  pixel: Pixel;
}}

const RAW_NODES: RawNode[] = [
{node_lines_ts}
];

interface RawEdge {{
  a: string;
  b: string;
  name: string;
  type: RoadClass;
  via?: Pixel[];
  crossing?: boolean;
}}

const RAW_EDGES: RawEdge[] = [
{edges_ts}
];

/** Pixel position of a network node. */
export const NODE_PIXEL = new Map<string, Pixel>(RAW_NODES.map((n) => [n.id, n.pixel]));

export interface RoadGeom {{
  name: string;
  type: RoadClass;
  crossing?: boolean;
  pixels: Pixel[];
  /** River-crossing point in pixels, if any. */
  crossPixel?: Pixel;
}}

/** Pixel polylines for drawing the base road network. */
export const ROAD_GEOMS: RoadGeom[] = RAW_EDGES.map((e) => {{
  const pixels = [NODE_PIXEL.get(e.a)!, ...(e.via ?? []), NODE_PIXEL.get(e.b)!];
  return {{
    name: e.name,
    type: e.type,
    crossing: e.crossing,
    pixels,
    crossPixel: e.crossing ? pixels[Math.floor(pixels.length / 2)] : undefined,
  }};
}});

const ROUTE_NODES: RouteNode[] = RAW_NODES.map((n) => ({{ id: n.id, ...pixelWorld(n.pixel.x, n.pixel.y) }}));

/** The GIS-imported road network. */
export function createRoadNetwork(): RoadNetwork {{
  const edges: RoadEdge[] = RAW_EDGES.map((e) => ({{
    a: e.a,
    b: e.b,
    name: e.name,
    type: e.type,
    via: (e.via ?? []).map((p) => pixelWorld(p.x, p.y)),
  }}));
  return new RoadNetwork(ROUTE_NODES, edges);
}}
"""
    args.out.write_text(out)
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
