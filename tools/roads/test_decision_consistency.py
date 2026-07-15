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

import hashlib
import json
import subprocess
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
    sys.path.insert(0, str(HERE))
    from build_blockers import blocked, no_duplicate_keys  # noqa: E402 — one definition each
    man = json.loads((HERE / "crossing_decisions.json").read_text())["sites"]

    # The exact inventory, spelled out. "every site in the joins file is in the manifest" is
    # satisfied by an EMPTY manifest and an empty joins file, and round 3 slipped a site past
    # it by setting `site` to null — the site stopped existing rather than failing (D90 F4).
    expect = {f"S{i:02d}" for i in range(1, 23)}
    check("the manifest holds exactly S01..S22", set(man) == expect,
          f"{len(man)} sites" if set(man) == expect
          else f"missing={sorted(expect - set(man))} unexpected={sorted(set(man) - expect)}")

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
    # TWO INDEPENDENT AXES (D90 F2). D89 named them and still derived both from one `status`,
    # so "the crossing exists but nobody has asked whether guests may use it" — the actual S06
    # situation — could not be said at all, and got rounded up to routable.
    def same(a, b) -> bool:
        """Equal AND the same type. `True == 1` and `False == 0` in Python, so a plain `==`
        would read a stray 1 as a confirmed crossing. `is` is not the answer either: it is
        true for the True/False/None singletons but not for two equal strings parsed out of
        two different JSON files, which quietly failed every tri-state site."""
        if isinstance(a, bool) != isinstance(b, bool):
            return False
        return a == b

    bad = []
    for f in joins:
        p = f["properties"]
        sid = p.get("site")
        if sid not in man:
            continue
        s = man[sid]
        for axis in ("crossing_exists", "guest_routable"):
            if axis in p and not same(p[axis], s[axis]):
                bad.append(f"{sid}: joins {axis}={p[axis]!r} but manifest says {s[axis]!r}")
        if p.get("routable_basis") != s.get("routable_basis"):
            bad.append(f"{sid}: joins routable_basis={p.get('routable_basis')!r} "
                       f"vs manifest {s.get('routable_basis')!r}")
    check("joins file agrees with the manifest (both axes)", not bad,
          "; ".join(sorted(set(bad))) or "no contradictions")

    # An inference must never read as a statement of fact. The joins file is client-visible.
    laundered = [f["properties"]["site"] for f in joins
                 if f["properties"].get("routable_basis") == "inference"
                 and "INFERRED" not in (f["properties"].get("decision_note") or "")]
    check("an inferred routing claim says it is inferred", not laundered,
          "no laundered inferences" if not laundered else f"LAUNDERED on {sorted(set(laundered))}")

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

    # ...and it must be the SAME evidence. Non-emptiness is not integrity: round 3 replaced S06's
    # note with "recorded drive proves guests crossed here" — a fabrication — and every check
    # passed (D90 F4). Nor can we compare against anything the generator writes: canonical_joins
    # reads geometry and evidence from the very file it then compares to, so those fields are
    # canonical by definition and cannot disagree with themselves.
    #
    # So: compare to GIT. f271601 is the last commit before any decision text touched this file
    # (fb6554f already carried five polluted S05 notes). A commit hash is the one reference in
    # this repo that cannot be edited to agree with a mistake. If a new survey ever legitimately
    # changes the evidence, repin this hash deliberately, in a commit that says why.
    EVIDENCE_PINNED_AT = "f271601"
    EV = ("evidence_note", "confidence", "crossing_confirmed", "gpx_points_near", "gpx_crossings",
          "river_cross_events_150m", "on_river", "gap_m", "kind")

    def digest(features, rename_note: bool) -> dict[str, str]:
        out = {}
        for f in features:
            p = f["properties"]
            ev = {k: p.get(k) for k in EV if k in p}
            if rename_note and "note" in p and "evidence_note" not in p:
                ev["evidence_note"] = p["note"]      # renamed by D89; same text
            key = hashlib.sha256(json.dumps(f["geometry"], sort_keys=True).encode()).hexdigest()
            out[key] = hashlib.sha256(json.dumps(ev, sort_keys=True).encode()).hexdigest()
        return out

    r = subprocess.run(["git", "show", f"{EVIDENCE_PINNED_AT}:tools/gis/Solio_Joins_Best_Guess.geojson"],
                       capture_output=True, text=True, cwd=HERE.parents[1])
    if r.returncode != 0:
        check("evidence matches git", False, f"cannot read {EVIDENCE_PINNED_AT}: {r.stderr.strip()[:80]}")
    else:
        want = digest(json.loads(r.stdout)["features"], rename_note=True)
        got = digest(joins, rename_note=False)
        drift = sorted(k for k in want if want[k] != got.get(k))
        check(f"evidence is byte-identical to {EVIDENCE_PINNED_AT}",
              not drift and set(want) == set(got),
              f"{len(want)} joins, evidence and geometry unchanged" if not drift and set(want) == set(got)
              else f"{len(drift)} join(s) have altered evidence; "
                   f"{len(set(want) - set(got))} geometries missing, {len(set(got) - set(want))} added")

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
        cut = {s for s, v in man.items() if blocked(v)}
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
                # BYTE equality, not parsed equality. `json.loads` silently keeps the last of a
                # duplicated key, so a second top-level "description" reading "All crossings are
                # confirmed safe" compared equal to the honest one and shipped (D90 F5). What a
                # reader sees is the bytes; that is what must match.
                ok = (committed.exists() and fresh.exists()
                      and committed.read_bytes() == fresh.read_bytes())
                n = 0
                if committed.exists():
                    parsed = json.loads(committed.read_text(), object_pairs_hook=no_duplicate_keys)
                    n = len(parsed["features"])
                check(f"export matches the exporter: {committed.name}", ok,
                      f"{n} features, byte-identical" if ok
                      else "DIFFERS from freshly generated — stale or hand-edited")

    if fails:
        print(f"\n{len(fails)} consistency check(s) FAILED: {', '.join(fails)}")
        sys.exit(1)
    print("\nall artifacts agree with crossing_decisions.json")


if __name__ == "__main__":
    main()
