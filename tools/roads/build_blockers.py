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
supplies only the decision. A site is CUT unless guest_routable is exactly true —
"unknown" cuts just like false — and `closure` picks which file it lands in:

    not routable + closure=open    -> blockers.open.geojson        (may reopen on an answer)
    not routable + closure=settled -> blockers.permanent.geojson   (never reopens)
    guest_routable=true            -> not blocked at all
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "crossing_decisions.json"
JOINS = HERE.parent / "gis" / "Solio_Joins_Best_Guess.geojson"
# Renamed from blockers.unconfirmed-crossings.geojson (D90 F2): it now also holds S06, a
# crossing we know EXISTS and simply have no permission answer for. A file called
# "unconfirmed-crossings" holding a confirmed crossing is the same species of lie the
# reviews keep finding — a name that claims something other than what it contains.
OPEN = HERE / "blockers.open.geojson"
PERMANENT = HERE / "blockers.permanent.geojson"

CRS = {"type": "name", "properties": {"name": "urn:ogc:def:crs:OGC:1.3:CRS84"}}


def no_duplicate_keys(pairs):
    """json.loads hook: a repeated key is an error, not last-one-wins.

    D90 F5. Adding a SECOND top-level "description" reading "All crossings are confirmed safe"
    passed every check, because `json.loads` silently keeps the last of a duplicated key while
    the file a human (or a GIS tool) reads may show the first. A file that parses to something
    other than what it says is exactly the failure these checks exist to catch.
    """
    seen: dict = {}
    for k, v in pairs:
        if k in seen:
            raise SystemExit(f"duplicate JSON key {k!r} — a file that parses differently from "
                             f"how it reads is not a source of truth")
        seen[k] = v
    return seen


TRI = (True, False, "unknown")


def blocked(s: dict) -> bool:
    """Cut unless we have an affirmative YES. `unknown` cuts exactly like `false`.

    The whole point of the tri-state: not-yet-asked and asked-and-refused have different
    answers, different owners and different futures — but the identical routing consequence.
    """
    return s["guest_routable"] is not True


def load_manifest(joins: dict | None = None) -> dict:
    m = json.loads(MANIFEST.read_text())
    sites = m["sites"]
    for sid, s in sites.items():
        for axis in ("crossing_exists", "guest_routable"):
            if s.get(axis) not in TRI:
                raise SystemExit(f"{sid}: {axis}={s.get(axis)!r} — must be true, false or \"unknown\"")
        if s["closure"] not in ("open", "settled"):
            raise SystemExit(f"{sid}: closure={s['closure']!r} — must be 'open' or 'settled'")
        # You cannot drive through a crossing that is not there. The axes are independent,
        # not unrelated: this is the ONE implication that holds between them.
        if s["guest_routable"] is True and s["crossing_exists"] is not True:
            raise SystemExit(f"{sid}: guest_routable=true but crossing_exists="
                             f"{s['crossing_exists']!r} — routable through what?")
        if s["guest_routable"] is True:
            if s.get("routable_basis") not in ("recorded-drive", "quote", "inference"):
                raise SystemExit(f"{sid}: routable with no routable_basis — say WHY a guest may "
                                 f"drive here (recorded-drive | quote | inference)")
        elif s.get("routable_basis") is not None:
            raise SystemExit(f"{sid}: routable_basis={s['routable_basis']!r} on a site that is "
                             f"not routable — a basis for a claim we are not making")
    if joins is not None:
        check_basis_against_evidence(sites, joins)
    return m


def check_basis_against_evidence(sites: dict, joins: dict) -> None:
    """`routable_basis: "recorded-drive"` must be backed by a recorded drive.

    It was free text. Round 3 set S06 to "recorded-drive" — a site with zero recorded river
    crossings — and the whole suite stayed green (D90 F2). A basis nobody checks is decoration:
    it describes the evidence we would like to have rather than the evidence we have.
    """
    by_site: dict[str, list] = {}
    for f in joins["features"]:
        sid = f["properties"].get("site")
        if sid:
            by_site.setdefault(sid, []).append(f["properties"])
    for sid, s in sites.items():
        if s.get("routable_basis") != "recorded-drive":
            continue
        ev = by_site.get(sid, [])
        if not any(p.get("crossing_confirmed") is True or (p.get("river_cross_events_150m") or 0) > 0
                   for p in ev):
            raise SystemExit(
                f"{sid}: routable_basis='recorded-drive' but no join here records a drive crossing "
                f"the river (crossing_confirmed / river_cross_events_150m). Either the basis is "
                f"wrong or the evidence is — do not resolve it by editing the evidence.")


def block_reason(s: dict) -> str:
    """WHY this site is cut. Three different situations, three different owners."""
    if s["guest_routable"] is False:
        return "private-access"          # asked and closed — Solio's decision, settled
    if s["crossing_exists"] is not True:
        return "crossing-unconfirmed"    # we have not established there is a crossing at all
    return "permission-unknown"          # the crossing is real; nobody has asked if guests may use it


def build(joins: dict | None = None) -> dict[Path, dict]:
    joins = joins if joins is not None else json.loads(JOINS.read_text())
    man = load_manifest(joins)
    sites = man["sites"]

    out: dict[str, list] = {"open": [], "settled": []}
    for f in joins["features"]:
        sid = f["properties"].get("site")
        if not sid or sid not in sites:
            continue
        s = sites[sid]
        if not blocked(s):
            continue
        props = {
            "site": sid,
            "site_name": s.get("name"),
            "gap_m": f["properties"].get("gap_m"),
            "crossing_exists": s["crossing_exists"],
            "guest_routable": s["guest_routable"],
            "reason": block_reason(s),
            "quote": s.get("quote") or None,
            "decided": s.get("date"),
            "why": s.get("inference"),
        }
        if s["closure"] == "settled":
            props["agreed_by"] = s.get("agreed_by")
        if s.get("likely_endpoint"):
            props["likely_endpoint"] = True
        out[s["closure"]].append({"type": "Feature", "properties": props, "geometry": f["geometry"]})

    return {
        OPEN: {
            "type": "FeatureCollection",
            "name": "Solio_Blockers_Open",
            "description": ("Crossings cut pending an ANSWER — either we have not established the "
                            "crossing exists (reason=crossing-unconfirmed) or it does exist and "
                            "nobody has asked whether guests may drive it (reason=permission-unknown). "
                            "OPEN: if Solio answers, unblocking is the correct response. "
                            "GENERATED from crossing_decisions.json — do not hand-edit."),
            "crs": CRS,
            "features": out["open"],
        },
        PERMANENT: {
            "type": "FeatureCollection",
            "name": "Solio_Blockers_Permanent",
            "description": ("Settled blocks — these never reopen on 'confirmation'. Only Solio "
                            "reversing the access decision lifts one. GENERATED from "
                            "crossing_decisions.json — do not hand-edit."),
            "crs": CRS,
            "features": out["settled"],
        },
    }


# Decision fields on the joins file — generated, never hand-set. These are the exact
# fields that contradicted each other on 14 Jul (D87 F7): a site advertised
# guest_routable=true while the manifest had it cut.
DECISION_FIELDS = ("crossing_exists", "guest_routable", "routable_basis", "site_name", "access",
                   "solio_said", "decided", "decision_note", "likely_endpoint")
# Written by hand on 14 Jul, now stale or retracted. `route_cost_of_blocking` carried the
# claim "zero — opening S05 changes no POI route", which D87 F2 RETRACTED as unproven.
STALE_FIELDS = ("access_decision", "access_decision_status", "crossing_verdict",
                "route_cost_of_blocking", "ask_status", "callan_reply", "confirmed_by",
                "agreed_by", "note")
# NEVER TOUCHED. `evidence_note` and the GPX fields record what the recorded drives showed;
# they are findings, not decisions, and nothing generated may overwrite them. On 15 Jul I put
# `note` in STALE_FIELDS and destroyed the evidence text on all 22 managed joins — while the
# docstring below said evidence "is not ours to rewrite" (D89). Restored from f271601 under a
# name whose whole job is to stop that happening again.
EVIDENCE_FIELDS = ("evidence_note", "confidence", "crossing_confirmed", "gpx_points_near",
                   "gpx_crossings", "river_cross_events_150m", "on_river", "gap_m", "kind")


def canonical_joins(man: dict) -> dict:
    """Regenerate the joins file's DECISION fields from the manifest.

    EVIDENCE_FIELDS are left strictly alone: they record what the recorded drives showed
    and are findings, not decisions. A site can legitimately be confirmed by Solio while
    crossing_confirmed=false — that is S06, confirmed by his words rather than by a drive —
    so the two are not in conflict, and decision_note says which is which.
    """
    if set(STALE_FIELDS) & set(EVIDENCE_FIELDS):
        # Not an `assert`: `python -O` strips those, and this one is load-bearing (D90 F4).
        raise SystemExit("a field cannot be both stale and evidence — that is how the notes "
                         "were destroyed on 15 Jul (D89)")
    sites = man["sites"]
    d = json.loads(JOINS.read_text(), object_pairs_hook=no_duplicate_keys)
    for f in d["features"]:
        sid = f["properties"].get("site")
        if sid not in sites:
            continue
        pr = f["properties"]
        for k in STALE_FIELDS:
            pr.pop(k, None)
        s = sites[sid]
        # PUBLISHED, not derived. Both axes are authored in the manifest; this copies them.
        pr["crossing_exists"] = s["crossing_exists"]
        pr["guest_routable"] = s["guest_routable"]
        pr["routable_basis"] = s.get("routable_basis")
        pr["site_name"] = s.get("name")
        pr["solio_said"] = s.get("quote") or None
        pr["decided"] = s.get("date")
        pr.pop("site_confirmed", None)   # renamed to crossing_exists (D90 F2)
        if s["guest_routable"] is False:
            pr["access"] = "private"
        else:
            pr.pop("access", None)
        if s.get("likely_endpoint"):
            pr["likely_endpoint"] = True
        else:
            pr.pop("likely_endpoint", None)   # must clear if the manifest flag goes away
        # The note must say exactly what the axes say — no more. The old text asserted
        # "Crossing exists and guests may drive it" for ANY confirmed site, which on S06 sat
        # beside "no recorded drive crosses the river" and "please confirm" in the same
        # properties bag (D90 F2). Every branch below is now reachable from the axes alone.
        if s["guest_routable"] is True:
            note = {"recorded-drive": "Crossing exists and guests may drive it — a recorded drive "
                                      "crossed the river here.",
                    "quote": "Crossing exists and guests may drive it — Solio's words say so.",
                    "inference": "Crossing exists. Guests may drive it — INFERRED by us, not "
                                 "stated by Solio; see `why` in the manifest."}[s["routable_basis"]]
        elif s["guest_routable"] is False:
            note = ("Crossing EXISTS and is confirmed; closed to guest through-routing by "
                    "agreement." if s["crossing_exists"] is True else
                    "Closed to guest routing by agreement.")
        else:
            note = ("Crossing exists; whether guests may drive through it is UNKNOWN — nobody has "
                    "asked. Cut from routing until answered."
                    if s["crossing_exists"] is True else
                    "NOT established as a drivable crossing — cut from routing until answered.")
        pr["decision_note"] = note + (" Decision authored in crossing_decisions.json — "
                                      "do not hand-edit this field.")
    return d


def main() -> None:
    check = "--check" in sys.argv
    joins = json.loads(JOINS.read_text(), object_pairs_hook=no_duplicate_keys)
    man = load_manifest(joins)
    built = build(joins)
    # --check must cover EVERYTHING this script owns, not just the files it is named
    # after. It used to verify the two blocker files only and silently ignore the joins
    # sync — so removing a site from the manifest, editing a joins field, or corrupting
    # join geometry all passed green (D89). Canonicalise and compare the lot.
    built[JOINS] = canonical_joins(man)
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
                sid = f["properties"].get("site")
                if sid:
                    by_site[sid] = by_site.get(sid, 0) + 1
            print(f"wrote {path.name}: {len(fc['features'])} features {by_site or '{}'}")
    if check and drift:
        sys.exit(1)
    if check:
        print("blockers AND joins match crossing_decisions.json")


if __name__ == "__main__":
    main()
