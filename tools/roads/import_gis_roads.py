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


def load_lines(path: Path) -> list[dict]:
    data = json.loads(path.read_text())
    if data.get("type") != "FeatureCollection":
        sys.exit("error: expected a GeoJSON FeatureCollection")
    lines = []
    for i, f in enumerate(data.get("features", [])):
        geom = f.get("geometry") or {}
        props = f.get("properties") or {}
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
            lines.append({"pts": pts, "name": str(props.get("name", "") or ""), "surface": surface})
    if not lines:
        sys.exit("error: no LineString features found")
    return lines


def node_lines(lines: list[dict]) -> tuple[list[tuple[float, float]], list[dict]]:
    """Split lines where another line's endpoint touches them, then cluster
    endpoints into shared junction nodes. Returns (nodes, edges)."""
    endpoints = [ln["pts"][k] for ln in lines for k in (0, -1)]

    # split any line at interior vertices that coincide with some endpoint
    split: list[dict] = []
    for ln in lines:
        pts = ln["pts"]
        cut = [0]
        for i in range(1, len(pts) - 1):
            if any(dist_m(pts[i], e) <= SNAP_M for e in endpoints):
                cut.append(i)
        cut.append(len(pts) - 1)
        for a, b in zip(cut, cut[1:]):
            if b > a:
                split.append({**ln, "pts": pts[a : b + 1]})

    # cluster endpoints -> nodes
    nodes: list[tuple[float, float]] = []

    def node_id(p: tuple[float, float]) -> int:
        for i, n in enumerate(nodes):
            if dist_m(p, n) <= SNAP_M:
                return i
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
    args = ap.parse_args()

    SNAP_M = args.snap

    lines = load_lines(args.geojson)
    for cpath in args.connectors:
        extra = load_lines(cpath)
        print(f"  + {len(extra)} connector line(s) from {cpath.name}")
        lines.extend(extra)
    nodes, edges = node_lines(lines)
    nodes, edges = keep_largest_component(nodes, edges)
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
