#!/usr/bin/env python3
"""Export a generated roads .ts as ArcGIS-ready WGS84 GeoJSON — the v2
best-fit road network as a comparison/replacement layer for Callan.

    python3 tools/roads/export_v2_geojson.py <roads.ts> <out.geojson>

Each edge becomes one LineString with:
  id           edge index
  length_m     edge length
  source       poster_trace | manual_connector (verified/drawn bridge decks)
  status       ok | unconfirmed_crossing (realises a join at one of the
               7 unconfirmed crossing sites — see the sent fix-list pack)
"""
from __future__ import annotations

import json, math, re, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]

# corner georef — must mirror src/data/reserve.ts (validated by import_gis_roads)
LNG0, LNG1, LAT0, LAT1, IW, IH = 36.849258, 37.002478, -0.090041, -0.305231, 2400, 3601
MLAT = 110574.0  # metres per degree latitude (WGS84); 111,320 is the LONGITUDE figure
MLNG = 111320.0 * math.cos(math.radians(-0.1975))


def px_world(x: float, y: float) -> tuple[float, float]:
    return (round(LNG0 + x / IW * (LNG1 - LNG0), 7), round(LAT0 + y / IH * (LAT1 - LAT0), 7))


def dist_m(a, b) -> float:
    return math.hypot((a[0] - b[0]) * MLNG, (a[1] - b[1]) * MLAT)


def seg_point_m(p, a, b) -> float:
    ax, ay = a[0] * MLNG, a[1] * MLAT
    bx, by = b[0] * MLNG, b[1] * MLAT
    px, py = p[0] * MLNG, p[1] * MLAT
    dx, dy = bx - ax, by - ay
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
    return math.hypot(px - (ax + t * dx), py - (ay + t * dy))


def segs_cross(p1, p2, p3, p4) -> bool:
    def o(a, b, c):
        v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        return 0 if abs(v) < 1e-18 else (1 if v > 0 else -1)
    return o(p1, p2, p3) != o(p1, p2, p4) and o(p3, p4, p1) != o(p3, p4, p2)


def seg_seg_m(p1, p2, p3, p4) -> float:
    """Min distance in metres between two segments (0 if they cross)."""
    if segs_cross(p1, p2, p3, p4):
        return 0.0
    return min(seg_point_m(p1, p3, p4), seg_point_m(p2, p3, p4),
               seg_point_m(p3, p1, p2), seg_point_m(p4, p1, p2))


def load_lines(path: Path) -> list[tuple[list[tuple[float, float]], dict]]:
    out = []
    for f in json.load(open(path))["features"]:
        g = f["geometry"]
        props = f.get("properties") or {}
        if g["type"] == "LineString":
            out.append(([tuple(c) for c in g["coordinates"]], props))
        elif g["type"] == "MultiLineString":
            out += [([tuple(c) for c in part], props) for part in g["coordinates"]]
    return out


def main() -> None:
    ts_path = Path(sys.argv[1])
    out_path = Path(sys.argv[2])
    src = ts_path.read_text()
    nodes = {m.group(1): px_world(float(m.group(2)), float(m.group(3)))
             for m in re.finditer(r'\{ id: "([^"]+)", pixel: \{ x: ([\d.]+), y: ([\d.]+) \} \}', src)}
    connectors = (load_lines(HERE / "connectors.bridges.geojson")
                  + load_lines(HERE / "connectors.unconfirmed.geojson"))
    blockers = load_lines(HERE / "blockers.unconfirmed-crossings.geojson")

    feats = []
    n_conn = n_unc = 0
    for i, m in enumerate(re.finditer(r'\{\s*a: "([^"]+)",\s*b: "([^"]+)",(.*?)\n  \},', src, re.S)):
        a, b, body = m.group(1), m.group(2), m.group(3)
        via = [px_world(float(x), float(y)) for x, y in re.findall(r"\{ x: ([\d.]+), y: ([\d.]+) \}", body)]
        pts = [nodes[a], *via, nodes[b]]
        length = sum(dist_m(p, q) for p, q in zip(pts, pts[1:]))

        near = sum(1 for p in pts if any(
            seg_point_m(p, c[j], c[j + 1]) < 25 for c, _ in connectors for j in range(len(c) - 1)))
        source = "manual_connector" if near >= max(2, round(len(pts) * 0.3)) else "poster_trace"

        # realises an unconfirmed join if any SEGMENT of it crosses or runs
        # within 15 m of the join line (vertex-only tests miss simplified edges)
        status, site = "ok", None
        for bl, bprops in blockers:
            if any(seg_seg_m(pts[j], pts[j + 1], bl[k], bl[k + 1]) < 15
                   for j in range(len(pts) - 1) for k in range(len(bl) - 1)):
                status, site = "unconfirmed_crossing", bprops.get("site")
                break
        n_conn += source == "manual_connector"
        n_unc += status == "unconfirmed_crossing"
        props = {"id": i, "length_m": round(length, 1), "source": source, "status": status}
        if site:
            props["site"] = site
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "LineString", "coordinates": [list(p) for p in pts]}})

    fc = {"type": "FeatureCollection",
          "name": "Solio_Roads_V2_WGS84",
          "description": ("Solio road network v2 — traced from the printed reserve map, "
                          "georeferenced, noded and simplified. source=manual_connector marks "
                          "drawn bridge decks added by hand; status=unconfirmed_crossing marks "
                          "edges over the 7 crossing places awaiting confirmation "
                          "(see 4-joins-to-confirm.geojson in the fix-list pack)."),
          "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
          "features": feats}
    out_path.write_text(json.dumps(fc))
    total = sum(f["properties"]["length_m"] for f in feats)
    print(f"wrote {out_path}: {len(feats)} edges, {total/1000:.1f} km total; "
          f"{n_conn} connector edges, {n_unc} unconfirmed-crossing edges")


if __name__ == "__main__":
    main()
