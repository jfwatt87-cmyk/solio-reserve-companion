#!/usr/bin/env python3
"""Every artifact must agree with crossing_decisions.json. Exit 0 = consistent.

    python3 tools/roads/test_decision_consistency.py

This exists because of D87 F7. On 2026-07-14 the same decision was hand-written into
five places. Within a day they contradicted each other and a client deliverable
asserted something false:

  - the joins file still said S05 "must remain in the unconfirmed list" after S05
    had been moved out of it;
  - sites carried `crossing_confirmed=false` and "please confirm" NEXT TO
    `guest_routable=true`;
  - CHANGES.md quoted blocker counts that were two edits out of date;
  - the export told Callan "the app will not route a guest onto it" about JW
    Marriott's only access road.

None of that was caught by a test, because no test compared the files to each other.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
GIS = HERE.parent / "gis"

fails: list[str] = []


def check(name: str, ok: bool, detail: str) -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}: {detail}")
    if not ok:
        fails.append(name)


def main() -> None:
    man = json.loads((HERE / "crossing_decisions.json").read_text())["sites"]

    # 1. blocker files are exactly what the manifest generates
    import subprocess
    r = subprocess.run([sys.executable, str(HERE / "build_blockers.py"), "--check"],
                       capture_output=True, text=True)
    check("blockers regenerate from the manifest", r.returncode == 0,
          (r.stdout + r.stderr).strip().splitlines()[-1] if (r.stdout or r.stderr) else "clean")

    # 2. the joins file must not contradict the manifest. This is the specific
    #    contradiction that shipped: a site cut by the manifest while the joins
    #    file advertised it as routable/confirmed.
    joins = json.loads((GIS / "Solio_Joins_Best_Guess.geojson").read_text())["features"]
    bad = []
    for f in joins:
        p = f["properties"]
        sid = p.get("site")
        if sid not in man:
            continue
        want_routable = man[sid]["status"] == "confirmed"
        if p.get("guest_routable") is not None and bool(p["guest_routable"]) != want_routable:
            bad.append(f"{sid}: joins guest_routable={p['guest_routable']} vs manifest {man[sid]['status']}")
        if p.get("site_confirmed") is True and not want_routable:
            bad.append(f"{sid}: joins site_confirmed=true but manifest says {man[sid]['status']}")
    check("joins file agrees with the manifest", not bad, "; ".join(sorted(set(bad))) or "no contradictions")

    # 3. the client export makes no access claim on a road edge — we cannot
    #    substantiate one, and the last attempt asserted a falsehood (F3/F4)
    roads = json.loads((GIS / "Solio_Roads_V2_WGS84.geojson").read_text())
    claim_fields = {"status", "site", "access", "guest_routable", "private"}
    offenders = sum(1 for f in roads["features"] if claim_fields & set(f["properties"]))
    check("export: no access claims on road edges", offenders == 0,
          f"{offenders} edges carry an access/status field")

    banned = "will not route a guest onto it"
    check("export: no false routing claim", banned not in roads.get("description", ""),
          f"description does not contain {banned!r}")

    # 4. every cut site is described SOMEWHERE the client can read — the old export
    #    could not describe S05/S22 at all, because a cut crossing leaves no edge
    x_path = GIS / "Solio_Roads_V2_WGS84_crossings.geojson"
    if x_path.exists():
        x = json.loads(x_path.read_text())["features"]
        described = {f["properties"]["site"] for f in x}
        cut = {s for s, v in man.items() if v["status"] != "confirmed"}
        check("export: every cut site is described", described == cut,
              f"described={sorted(described)} cut={sorted(cut)}")
        wrong = [f["properties"]["site"] for f in x
                 if f["properties"].get("routed_by_app") is not False]
        check("export: crossings layer says routed_by_app=false", not wrong, "all false")
    else:
        check("export: crossings layer exists", False, f"{x_path.name} missing")

    if fails:
        print(f"\n{len(fails)} consistency check(s) FAILED: {', '.join(fails)}")
        sys.exit(1)
    print("\nall artifacts agree with crossing_decisions.json")


if __name__ == "__main__":
    main()
