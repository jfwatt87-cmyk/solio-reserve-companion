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
    # TWO AXES (D89) — a crossing can exist AND be closed to guests. That is S18/S20.
    # Checking them as one axis is what produced "site_confirmed:false" beside
    # "Real crossing..." on the same feature.
    bad = []
    for f in joins:
        p = f["properties"]
        sid = p.get("site")
        if sid not in man:
            continue
        status = man[sid]["status"]
        want_exists = status in ("confirmed", "private")
        want_routable = status == "confirmed"
        if p.get("site_confirmed") is not None and bool(p["site_confirmed"]) != want_exists:
            bad.append(f"{sid}: joins site_confirmed={p['site_confirmed']} but manifest {status} means exists={want_exists}")
        if p.get("guest_routable") is not None and bool(p["guest_routable"]) != want_routable:
            bad.append(f"{sid}: joins guest_routable={p['guest_routable']} vs manifest {status}")
        # a routable claim that is an inference must SAY so — never laundered as quoted
        if want_routable and p.get("routable_basis") not in ("quote", "inference", "recorded-drive"):
            bad.append(f"{sid}: routable with no routable_basis recorded")
    check("joins file agrees with the manifest (both axes)", not bad,
          "; ".join(sorted(set(bad))) or "no contradictions")

    # EVERY site must be in the inventory. A site that is merely absent from the manifest
    # is ungoverned: nothing blocks it, nothing checks it, and it stays routable. Deleting
    # S06 from the manifest left the entire suite green (D89).
    in_joins = {f["properties"]["site"] for f in joins if f["properties"].get("site")}
    ungoverned = in_joins - set(man)
    check("every site is in the manifest", not ungoverned,
          f"{len(in_joins)} sites governed" if not ungoverned else f"UNGOVERNED: {sorted(ungoverned)}")

    # Evidence must survive the generator. It destroyed all 22 evidence notes once (D89).
    lost = [f["properties"].get("site") for f in joins
            if f["properties"].get("site") in man and not f["properties"].get("evidence_note")]
    check("evidence_note survives on managed joins", not lost,
          f"{len(joins)} joins carry evidence" if not lost else f"LOST on {sorted(set(lost))}")

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

    # 5. the committed exports must BE what the exporter produces. Round 2 deleted one
    #    crossing feature (21 -> 20) and one road edge (451 -> 450) and the suite stayed
    #    green: the checks compared a SET of site ids, losing multiplicity and geometry,
    #    and nothing checked the road layer at all (D89).
    import subprocess, tempfile, os
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td) / "x.geojson"
        r = subprocess.run([sys.executable, str(HERE / "export_v2_geojson.py"),
                            str(HERE.parent.parent / "src/data/roads.gis.ts"), str(tmp)],
                           capture_output=True, text=True)
        if r.returncode != 0:
            check("exports regenerate", False, (r.stderr or r.stdout)[-200:])
        else:
            pairs = [(GIS / "Solio_Roads_V2_WGS84.geojson", tmp),
                     (GIS / "Solio_Roads_V2_WGS84_crossings.geojson",
                      tmp.with_name(tmp.stem + "_crossings.geojson"))]
            for committed, fresh in pairs:
                same = (json.loads(committed.read_text()) == json.loads(fresh.read_text())
                        if committed.exists() and fresh.exists() else False)
                n = len(json.loads(committed.read_text())["features"]) if committed.exists() else 0
                check(f"export matches the exporter: {committed.name}", same,
                      f"{n} features, identical" if same
                      else "DIFFERS from freshly generated — stale or hand-edited")

    if fails:
        print(f"\n{len(fails)} consistency check(s) FAILED: {', '.join(fails)}")
        sys.exit(1)
    print("\nall artifacts agree with crossing_decisions.json")


if __name__ == "__main__":
    main()
