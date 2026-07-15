#!/usr/bin/env python3
"""Generate the blocker files from crossing_decisions.json — the single manifest.

    python3 tools/roads/build_blockers.py            # write
    python3 tools/roads/build_blockers.py --check    # exit 1 if files differ (CI)

Why this exists (D87 F7): on 2026-07-14 the same decision was hand-written into the
two blocker files, the joins file, the exporter description and CHANGES.md. Within a
day they disagreed — the joins file still said S05 "must remain in the unconfirmed
list" after it had been moved, and sites carried `crossing_confirmed=false` next to
`guest_routable=true`. A client deliverable ended up asserting something false. So:
decisions are authored ONCE, in the manifest, and everything else is generated.

Geometry comes from Solio_Joins_Best_Guess.geojson (the join lines); the manifest
supplies only the decision. A site's status routes it to a file:

    unconfirmed -> blockers.unconfirmed-crossings.geojson   (open; may yet reopen)
    private     -> blockers.permanent.geojson               (settled; never reopens)
    confirmed   -> not blocked at all
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "crossing_decisions.json"
JOINS = HERE.parent / "gis" / "Solio_Joins_Best_Guess.geojson"
UNCONFIRMED = HERE / "blockers.unconfirmed-crossings.geojson"
PERMANENT = HERE / "blockers.permanent.geojson"

CRS = {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}}


def load_manifest() -> dict:
    m = json.loads(MANIFEST.read_text())
    sites = m["sites"]
    for sid, s in sites.items():
        if s["status"] not in ("confirmed", "unconfirmed", "private"):
            raise SystemExit(f"{sid}: unknown status {s['status']!r}")
        # A confirmed site is routable; anything cut is not. Catch the contradiction
        # that shipped on 14 Jul (confirmed-but-closed, or unconfirmed-but-routable).
        if (s["status"] == "confirmed") != bool(s["guest_routable"]):
            raise SystemExit(
                f"{sid}: status={s['status']} contradicts guest_routable={s['guest_routable']}")
    return m


def build() -> dict[Path, dict]:
    man = load_manifest()
    sites = man["sites"]
    joins = json.loads(JOINS.read_text())

    out: dict[str, list] = {"unconfirmed": [], "private": []}
    for f in joins["features"]:
        sid = f["properties"].get("site")
        if not sid or sid not in sites:
            continue
        s = sites[sid]
        if s["status"] == "confirmed":
            continue
        bucket = "unconfirmed" if s["status"] == "unconfirmed" else "private"
        props = {
            "site": sid,
            "site_name": s.get("name"),
            "gap_m": f["properties"].get("gap_m"),
            "status": s["status"],
            "quote": s.get("quote") or None,
            "decided": s.get("date"),
            "why": s.get("inference"),
        }
        if s["status"] == "private":
            props["reason"] = "private-access"
            props["agreed_by"] = s.get("agreed_by")
        else:
            props["reason"] = "unconfirmed"
            if s.get("likely_endpoint"):
                props["likely_endpoint"] = True
        out[bucket].append({"type": "Feature", "properties": props, "geometry": f["geometry"]})

    return {
        UNCONFIRMED: {
            "type": "FeatureCollection",
            "name": "Solio_Blockers_Unconfirmed",
            "description": ("Crossings NOT confirmed drivable — cut from the routing graph. OPEN: "
                            "if Solio ever confirms one, unblocking is the correct response. "
                            "GENERATED from crossing_decisions.json — do not hand-edit."),
            "crs": CRS,
            "features": out["unconfirmed"],
        },
        PERMANENT: {
            "type": "FeatureCollection",
            "name": "Solio_Blockers_Permanent",
            "description": ("Settled blocks — these never reopen on 'confirmation'. Only Solio "
                            "reversing the access decision lifts one. GENERATED from "
                            "crossing_decisions.json — do not hand-edit."),
            "crs": CRS,
            "features": out["private"],
        },
    }


# Decision fields on the joins file — generated, never hand-set. These are the exact
# fields that contradicted each other on 14 Jul (D87 F7): a site advertised
# guest_routable=true while the manifest had it cut.
DECISION_FIELDS = ("site_confirmed", "guest_routable", "site_name", "access", "solio_said",
                   "decided", "decision_note", "likely_endpoint")
# Written by hand on 14 Jul, now stale or retracted. `route_cost_of_blocking` carried the
# claim "zero — opening S05 changes no POI route", which D87 F2 RETRACTED as unproven.
STALE_FIELDS = ("access_decision", "access_decision_status", "crossing_verdict",
                "route_cost_of_blocking", "ask_status", "callan_reply", "confirmed_by",
                "agreed_by", "note")


def sync_joins(man: dict) -> int:
    """Regenerate the joins file's DECISION fields from the manifest.

    Evidence fields (`confidence`, `crossing_confirmed`, `gpx_*`, `on_river`) are left
    alone: they record what the recorded drives showed and are not ours to rewrite.
    A site can legitimately be confirmed by Solio while crossing_confirmed=false —
    that is S06 — so the two are not in conflict; the decision_note says which is which.
    """
    sites = man["sites"]
    path = JOINS
    d = json.loads(path.read_text())
    n = 0
    for f in d["features"]:
        sid = f["properties"].get("site")
        if sid not in sites:
            continue
        pr = f["properties"]
        for k in STALE_FIELDS:
            pr.pop(k, None)
        s = sites[sid]
        confirmed = s["status"] == "confirmed"
        pr["site_confirmed"] = confirmed
        pr["guest_routable"] = confirmed
        pr["site_name"] = s.get("name")
        pr["solio_said"] = s.get("quote") or None
        pr["decided"] = s.get("date")
        if s["status"] == "private":
            pr["access"] = "private"
        else:
            pr.pop("access", None)
        if s.get("likely_endpoint"):
            pr["likely_endpoint"] = True
        pr["decision_note"] = (
            ("Confirmed by Solio as drivable." if confirmed else
             "NOT confirmed drivable — cut from routing." if s["status"] == "unconfirmed" else
             "Real crossing, closed to guest through-routing by agreement.")
            + " Decision authored in crossing_decisions.json — do not hand-edit this field.")
        n += 1
    path.write_text(json.dumps(d, indent=1) + "\n")
    return n


def main() -> None:
    check = "--check" in sys.argv
    built = build()
    drift = False
    for path, fc in built.items():
        text = json.dumps(fc, indent=1) + "\n"
        if check:
            current = path.read_text() if path.exists() else ""
            if current != text:
                print(f"DRIFT: {path.name} differs from crossing_decisions.json")
                drift = True
        else:
            path.write_text(text)
            by_site: dict[str, int] = {}
            for f in fc["features"]:
                by_site[f["properties"]["site"]] = by_site.get(f["properties"]["site"], 0) + 1
            print(f"wrote {path.name}: {len(fc['features'])} joins {by_site or '{}'}")
    if not check:
        n = sync_joins(load_manifest())
        print(f"synced {n} join decision fields in {JOINS.name}")
    if check and drift:
        sys.exit(1)
    if check:
        print("blocker files match crossing_decisions.json")


if __name__ == "__main__":
    main()
