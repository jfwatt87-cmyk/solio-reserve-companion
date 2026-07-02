#!/usr/bin/env python3
"""Import Solio's GIS road centrelines into the app's road-network format.

Reads a GeoJSON FeatureCollection of road-centreline LineStrings (EPSG:4326
lon,lat — see GIS_ROADS_SPEC.md), nodes the lines into a routing graph at
shared / touching endpoints, carries the `name` and `surface` properties, and
emits `src/data/roads.gis.ts` in exactly the shape `src/data/roads.ts` uses.
The app (src/data/roadSource.ts) prefers roads.gis.ts whenever it exists.

POI binding: tours and navigation route to well-known node ids (gate, lodge,
orphanage, airstrip, jw, kingfisher, yellowthorn, naribo, choroa, rhinogate).
Each POI's verified position (from src/data/pois.ts) is matched to the nearest
imported graph node (within --poi-radius metres, default 800) and that node
adopts the POI's id, so existing tours keep routing unchanged.

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

SNAP_M = 25.0          # endpoints closer than this are the same junction
SURFACES = {"graded", "dirt", "4x4"}


def world_to_pixel(lng: float, lat: float) -> tuple[float, float]:
    return (
        (lng - LNG0) / (LNG1 - LNG0) * IW,
        (lat - LAT0) / (LAT1 - LAT0) * IH,
    )


def dist_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot((a[0] - b[0]) * M_PER_DEG_LNG, (a[1] - b[1]) * M_PER_DEG_LAT)


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
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("geojson", type=Path)
    ap.add_argument("--out", type=Path, default=ROOT / "src/data/roads.gis.ts")
    ap.add_argument("--poi-radius", type=float, default=800.0,
                    help="max metres from a POI to its network node (default 800)")
    args = ap.parse_args()

    lines = load_lines(args.geojson)
    nodes, edges = node_lines(lines)
    print(f"read {len(lines)} centreline(s) -> {len(nodes)} node(s), {len(edges)} edge(s)")

    # bind POI ids to nearest nodes
    ids = [f"g{i + 1}" for i in range(len(nodes))]
    for poi_id, lng, lat in load_pois():
        best, best_d = None, args.poi_radius
        for i, n in enumerate(nodes):
            d = dist_m((lng, lat), n)
            if d < best_d and ids[i].startswith("g"):
                best, best_d = i, d
        if best is None:
            print(f"  WARNING: no network node within {args.poi_radius:.0f} m of POI '{poi_id}' — "
                  "routes to it will fail until the network reaches it")
        else:
            ids[best] = poi_id
            print(f"  poi '{poi_id}' -> node {best} ({best_d:.0f} m)")

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
