#!/usr/bin/env python3
"""Export a generated roads .ts as ArcGIS-ready WGS84 GeoJSON for Callan.

    python3 tools/roads/export_v2_geojson.py <roads.ts> <out.geojson>

Writes TWO layers:

  <out.geojson>              the road network. Per edge: id, length_m, source
                             (poster_trace | manual_connector).
  <out>_crossings.geojson    the crossings the app will NOT route over, one
                             feature per blocked join: site, reason, status,
                             Solio's verbatim quote, gap_m.

WHY TWO LAYERS, and why roads carry NO access field (D87 F3/F4). The old export
tagged ROAD EDGES by proximity to a crossing JOIN LINE. Those are different
objects, and conflating them produced two failures at once:

  - It could not describe S05/S22 at all. An exporter that iterates SURVIVING
    edges can never label a crossing that was cut — the edge isn't there.
  - It smeared a 15 m river-hop onto whole 550-600 m chain-merged edges, then
    asserted "the app will not route a guest onto it" about edge 204 — which is
    JW Marriott's ONLY access road, traversed by every route to the lodge. The
    statement was simply false, in a file a third party reads.

We have no geometry for the Marriotts road as a whole, so NO edge-level access
claim here is substantiable. Do not add one back without that geometry. The real
policy — guests may navigate TO JW Marriott, but the app will not route a
through-route across S18/S20 — is a property of the crossings, so it lives in the
crossings layer where it is true.
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
    feats = []
    n_conn = 0
    for i, m in enumerate(re.finditer(r'\{\s*a: "([^"]+)",\s*b: "([^"]+)",(.*?)\n  \},', src, re.S)):
        a, b, body = m.group(1), m.group(2), m.group(3)
        via = [px_world(float(x), float(y)) for x, y in re.findall(r"\{ x: ([\d.]+), y: ([\d.]+) \}", body)]
        pts = [nodes[a], *via, nodes[b]]
        length = sum(dist_m(p, q) for p, q in zip(pts, pts[1:]))

        near = sum(1 for p in pts if any(
            seg_point_m(p, c[j], c[j + 1]) < 25 for c, _ in connectors for j in range(len(c) - 1)))
        source = "manual_connector" if near >= max(2, round(len(pts) * 0.3)) else "poster_trace"

        n_conn += source == "manual_connector"
        # NO access/status field: see the module docstring. Every edge here is a road
        # the app may route over — the ones it may not are simply absent, and are
        # described in the crossings layer instead.
        props = {"id": i, "length_m": round(length, 1), "source": source}
        feats.append({"type": "Feature", "properties": props,
                      "geometry": {"type": "LineString", "coordinates": [list(p) for p in pts]}})

    fc = {"type": "FeatureCollection",
          "name": "Solio_Roads_V2_WGS84",
          "description": ("Solio road network v2 — traced from the printed reserve map, "
                          "georeferenced, noded and simplified. Every road here is one the app "
                          "may route over; source=manual_connector marks drawn bridge decks added "
                          "by hand. Roads carry NO access attribute: crossings the app will not "
                          "route over are absent from this layer and described in the companion "
                          "*_crossings.geojson instead. Access policy in plain terms: guests may "
                          "navigate TO JW Marriott (a lodge they stay at), but the app will not "
                          "route a through-route across the Marriotts private crossings (S18/S20) "
                          "— closed at Solio's request, 2026-07-14."),
          "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
          "features": feats}
    out_path.write_text(json.dumps(fc))

    # The crossings layer — the only place an access/confirmation claim is made, because
    # it is the only place we can substantiate one. Built from the blocker files, so a
    # cut crossing is DESCRIBED even though no road edge survives to carry a label.
    xfeats = []
    for fname in ("blockers.unconfirmed-crossings.geojson", "blockers.permanent.geojson"):
        for f in json.load(open(HERE / fname))["features"]:
            pr = f["properties"]
            xfeats.append({"type": "Feature", "geometry": f["geometry"], "properties": {
                "site": pr.get("site"),
                "site_name": pr.get("site_name"),
                "status": pr.get("status"),
                "reason": pr.get("reason"),
                "routed_by_app": False,
                "gap_m": pr.get("gap_m"),
                "solio_said": pr.get("quote"),
                "decided": pr.get("decided"),
            }})
    xfc = {"type": "FeatureCollection",
           "name": "Solio_Blocked_Crossings_V2",
           "description": ("River crossings the app will NOT route over, and why. "
                           "reason=unconfirmed — Solio has not confirmed the crossing is real and "
                           "guest-drivable; naming the road is not the same as confirming you can "
                           "drive through it, so these stay cut and may yet reopen if confirmed. "
                           "reason=private-access — the Marriotts private crossings (S18/S20): "
                           "real, but closed to guest through-routing at Solio's request. JW "
                           "Marriott itself remains reachable. Crossings NOT listed here are "
                           "routable. Generated from crossing_decisions.json."),
           "crs": {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}},
           "features": xfeats}
    x_path = out_path.with_name(out_path.stem + "_crossings.geojson")
    x_path.write_text(json.dumps(xfc, indent=1))

    total = sum(f["properties"]["length_m"] for f in feats)
    by_reason: dict = {}
    for f in xfeats:
        r = f["properties"]["reason"]
        by_reason[r] = by_reason.get(r, 0) + 1
    print(f"wrote {out_path}: {len(feats)} edges, {total/1000:.1f} km total; "
          f"{n_conn} connector edges; NO access claims on roads (D87 F3/F4)")
    print(f"wrote {x_path.name}: {len(xfeats)} blocked crossings {by_reason}")


if __name__ == "__main__":
    main()
