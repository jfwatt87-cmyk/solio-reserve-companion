/**
 * Regression guard for GPS route progress + arrival, on the SHIPPED network:
 *
 *     npm run test:nav     # exit 0 = all pass
 *
 * Drives every route the app can build — POI to POI, and multi-stop routes that
 * pass their own destination on the way out to a stop — in small steps, through
 * the same functions App.tsx uses (projectOnPathFrom, atPathEnd, ARRIVE_M), and
 * asserts that progress tracks the true distance driven and that arrival fires
 * at the end of the route, never before it. Run after ANY change to routing,
 * geo, sim or a regenerated roads.gis.ts.
 *
 * History: arrival originally needed the fix within 45 m of the POI, but routes
 * end at the POI's road node 67–282 m away, so it never fired (0/110 routes).
 * The first route-end fix used a global projection and fired early on 16/16
 * out-and-back multi-stop routes (Fable review, 2026-10-14). Check 4 proves the
 * suite still catches that.
 */

import { createRoadNetwork } from "../../src/data/roads.gis";
import { POIS, poiWorld, type Poi } from "../../src/data/pois";
import { ARRIVE_M, atPathEnd, pathLength, poseAlong } from "../../src/lib/sim";
import { destinationPoint, distanceMeters, projectOnPath, projectOnPathFrom, type LatLng } from "../../src/lib/geo";

// Runs under node; declared here rather than adding @types/node to the app.
declare const process: { exit(code: number): never };

const failures: string[] = [];
function check(name: string, ok: boolean, detail: string): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}: ${detail}`);
  if (!ok) failures.push(name);
}

const net = createRoadNetwork();
const STEP_M = 10;

interface Drive { label: string; path: LatLng[]; dest: Poi }

/**
 * Drive `path` in STEP_M steps, `offsetM` to the side. Returns the first arrival
 * distance, the worst progress error, and the longest run of consecutive fixes
 * with progress off by more than 2 m.
 */
function drive(d: Drive, offsetM = 0, global = false): { firstFire: number; maxErr: number; maxRun: number; len: number } {
  const len = pathLength(d.path);
  let prev = 0;
  let maxErr = 0, run = 0, maxRun = 0;
  for (let s = 0; ; s = Math.min(len, s + STEP_M)) {
    const pose = poseAlong(d.path, s);
    const pos = offsetM ? destinationPoint(pose.pos, Math.abs(offsetM), pose.heading + (offsetM > 0 ? 90 : -90)) : pose.pos;
    const along = global ? projectOnPath(pos, d.path).along : projectOnPathFrom(pos, d.path, prev).along;
    prev = along;
    if (!offsetM) {
      const err = Math.abs(along - s);
      maxErr = Math.max(maxErr, err);
      run = err > 2 ? run + 1 : 0;
      maxRun = Math.max(maxRun, run);
    }
    if (distanceMeters(pos, poiWorld(d.dest)) < ARRIVE_M || atPathEnd(pos, d.path, along, ARRIVE_M)) {
      return { firstFire: s, maxErr, maxRun, len };
    }
    if (s >= len) return { firstFire: Infinity, maxErr, maxRun, len };
  }
}

const bound = POIS.filter((p) => POIS.some((q) => q !== p && net.route(q.nodeId, p.nodeId)));

// Direct POI-to-POI routes.
const direct: Drive[] = [];
for (const a of bound) for (const b of bound) {
  if (a === b) continue;
  const r = net.route(a.nodeId, b.nodeId);
  if (r && r.path.length >= 2) direct.push({ label: `${a.id}->${b.id}`, path: r.path, dest: b });
}

// Multi-stop routes whose outbound leg passes the destination node (built the
// way App.tsx's multiStopFrom joins legs).
const outAndBack: Drive[] = [];
for (const o of bound) for (const s of bound) for (const b of bound) {
  if (o === s || s === b || o === b) continue;
  const l1 = net.route(o.nodeId, s.nodeId);
  const l2 = net.route(s.nodeId, b.nodeId);
  if (!l1 || !l2 || l1.path.length < 2 || l2.path.length < 2) continue;
  if (!l1.nodeIds.includes(b.nodeId)) continue;
  outAndBack.push({ label: `${o.id}->(${s.id})->${b.id}`, path: [...l1.path, ...l2.path.slice(1)], dest: b });
}

function sweep(drives: Drive[], offsetM: number, earliestAllowed: number) {
  let missed = 0, early = 0, worstEarly = 0, worstErr = 0, worstRun = 0;
  const examples: string[] = [];
  for (const d of drives) {
    const { firstFire, maxErr, maxRun, len } = drive(d, offsetM);
    worstErr = Math.max(worstErr, maxErr);
    worstRun = Math.max(worstRun, maxRun);
    if (firstFire === Infinity) { missed++; examples.push(`${d.label} never arrives`); continue; }
    const before = len - firstFire;
    worstEarly = Math.max(worstEarly, before);
    if (before > earliestAllowed) { early++; examples.push(`${d.label} arrives ${Math.round(before)} m early`); }
  }
  return { missed, early, worstEarly, worstErr, worstRun, examples: examples.slice(0, 3).join("; ") };
}

function main(): void {
  // 0. projectOnPathFrom on a synthetic out-and-back: same road both ways.
  const a: LatLng = { lat: -0.2, lng: 36.9 };
  const b = destinationPoint(a, 500, 90);
  const mid = destinationPoint(a, 250, 90);
  const ob = [a, b, a];
  const out = projectOnPathFrom(mid, ob, 0).along;
  const back = projectOnPathFrom(mid, ob, 700).along;
  check("anchored projection picks the right copy", Math.abs(out - 250) < 1 && Math.abs(back - 750) < 1,
    `outbound ${out.toFixed(1)} m (want 250), return ${back.toFixed(1)} m (want 750)`);
  // ...and a guest who genuinely reverses 100 m on a plain road goes backwards.
  const straight = [a, b];
  const rev = projectOnPathFrom(mid, straight, 350).along;
  check("anchored projection follows a real reversal", Math.abs(rev - 250) < 1,
    `progress ${rev.toFixed(1)} m after reversing from 350 m to 250 m`);

  // 1. every direct route arrives, on the road, no earlier than ARRIVE_M from the end
  const d0 = sweep(direct, 0, ARRIVE_M + STEP_M);
  check("direct routes arrive at the end", d0.missed === 0 && d0.early === 0,
    `${direct.length} routes, ${d0.missed} never arrive, earliest ${Math.round(d0.worstEarly)} m before the end` +
    (d0.examples ? ` — ${d0.examples}` : ""));
  check("direct routes: progress tracks distance driven", d0.worstErr < 2,
    `worst progress error ${d0.worstErr.toFixed(2)} m`);

  // 2. ...and with GPS 15 m to either side of the road
  for (const off of [15, -15]) {
    const d = sweep(direct, off, ARRIVE_M + 20);
    check(`direct routes with GPS ${off > 0 ? "right" : "left"} 15 m`, d.missed === 0 && d.early === 0,
      `${d.missed} never arrive, earliest ${Math.round(d.worstEarly)} m before the end` + (d.examples ? ` — ${d.examples}` : ""));
  }

  // 3. routes that pass their destination on the way to a stop beyond it
  const m0 = sweep(outAndBack, 0, ARRIVE_M + STEP_M);
  check("out-and-back stop routes exist on this network", outAndBack.length > 0, `${outAndBack.length} routes`);
  check("out-and-back stop routes arrive only at the end", m0.missed === 0 && m0.early === 0,
    `${m0.missed} never arrive, earliest ${Math.round(m0.worstEarly)} m before the end` + (m0.examples ? ` — ${m0.examples}` : ""));
  // At the turnaround itself, out and back are the same spot: progress may lag
  // by ONE fix there, never more.
  check("out-and-back stop routes: progress tracks distance driven", m0.worstRun <= 1 && m0.worstErr <= STEP_M + 1,
    `worst progress error ${m0.worstErr.toFixed(2)} m, never off by >2 m for more than ${m0.worstRun} fix in a row`);

  // 4. the suite still catches the original bug: global projection fires early
  const caught = outAndBack.filter((d) => {
    const r = drive(d, 0, true);
    return r.len - r.firstFire > ARRIVE_M + STEP_M;
  }).length;
  check("suite detects the global-projection bug", caught > 0,
    `${caught}/${outAndBack.length} out-and-back routes fire early with a global projection`);

  console.log(failures.length ? `\n${failures.length} nav check(s) FAILED` : "\nall nav checks hold");
  process.exit(failures.length ? 1 : 0);
}

main();
