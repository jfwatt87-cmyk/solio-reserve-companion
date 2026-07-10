/**
 * Tests for THE rhino-rule enforcement: clampDial + buildGuestSnapshot.
 * If these fail, nothing ships. Run: npx tsx server/src/filter.test.ts
 */
import { buildGuestSnapshot, clampDial, FLOORS } from "./index";

const NOW = 1_752_000_000_000;
const MIN = 60_000;
const pos = (ts: number, lat = -0.198765, lng = 36.912345, vehicleId = "v1") => ({
  vehicleId,
  label: "Ranger 1",
  lat,
  lng,
  heading: 90,
  ts,
});

let failures = 0;
function assert(name: string, cond: boolean) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}: ${name}`);
}

const run = async () => {
  /* ---- clampDial: hostile/corrupt settings can never weaken the floors ---- */
  assert("null dial fails closed", clampDial(null).mode === "off");
  assert("garbage dial fails closed", clampDial("live").mode === "off");
  assert("unknown mode fails closed", clampDial({ mode: "live" }).mode === "off");
  const hostile = clampDial({ mode: "windowed", delayMinutes: -5, gridMetres: 0.001 });
  assert("negative delay clamps to floor", hostile.delayMinutes === FLOORS.minDelayMinutes);
  assert("mm grid clamps to floor", hostile.gridMetres === FLOORS.minGridMetres);
  assert("NaN params clamp to floor",
    clampDial({ mode: "windowed", delayMinutes: NaN, gridMetres: Infinity }).delayMinutes === FLOORS.minDelayMinutes);
  assert("looser-than-floor values survive",
    clampDial({ mode: "windowed", delayMinutes: 60, gridMetres: 2000 }).delayMinutes === 60);

  /* ---- off / default: guests see nothing ---- */
  assert("no dial stored -> empty", (await buildGuestSnapshot([[pos(NOW - 120 * MIN)]], null, NOW)).length === 0);
  assert("mode off -> empty", (await buildGuestSnapshot([[pos(NOW - 120 * MIN)]], { mode: "off" }, NOW)).length === 0);

  const dial = { mode: "windowed", delayMinutes: 30, gridMetres: 1000 };

  /* ---- delay: nothing fresher than the window, trailing point shown ---- */
  const freshOnly = await buildGuestSnapshot([[pos(NOW - 5 * MIN)]], dial, NOW);
  assert("fresh-only vehicle hidden", freshOnly.length === 0);
  const trail = await buildGuestSnapshot(
    [[pos(NOW - 45 * MIN), pos(NOW - 31 * MIN), pos(NOW - 5 * MIN)]], dial, NOW);
  assert("moving vehicle shows delayed trail (not hidden)", trail.length === 1);
  assert("trailing point is newest ELIGIBLE, not newest overall",
    trail[0].seenBucket <= NOW - 30 * MIN && trail[0].seenBucket >= NOW - 45 * MIN);
  const boundary = await buildGuestSnapshot([[pos(NOW - 30 * MIN)]], dial, NOW);
  assert("exact-boundary age is visible (<= cutoff)", boundary.length === 1);

  /* ---- the guest DTO is an allowlist: nothing private can ride along ---- */
  const g = trail[0] as unknown as Record<string, unknown>;
  const keys = Object.keys(g).sort().join(",");
  assert("DTO has exactly the allowlisted keys", keys === "cell,gridMetres,id,seenBucket");
  assert("no heading/ts/lat/lng/vehicleId/label leak",
    !("heading" in g) && !("ts" in g) && !("lat" in g) && !("lng" in g) && !("vehicleId" in g) && !("label" in g));

  /* ---- coarsening: cell centres on the grid, floors hold ---- */
  const dLat = 1000 / 110_574;
  const cell = trail[0].cell;
  assert("cell lat on grid", Math.abs(cell.lat / dLat - Math.round(cell.lat / dLat)) < 1e-9);
  assert("gridMetres echoed >= floor", trail[0].gridMetres >= FLOORS.minGridMetres);

  /* ---- time bucketing: no raw timestamps ---- */
  const bucketMs = FLOORS.timeBucketMinutes * MIN;
  assert("seenBucket is a bucket boundary", trail[0].seenBucket % bucketMs === 0);

  /* ---- id rotation: same vehicle, different day -> different id ---- */
  const day1 = await buildGuestSnapshot([[pos(NOW - 31 * MIN)]], dial, NOW);
  const day2 = await buildGuestSnapshot([[pos(NOW + 86_400_000 - 31 * MIN)]], dial, NOW + 86_400_000);
  assert("guest id rotates daily", day1[0].id !== day2[0].id);
  assert("guest id is not the vehicleId", day1[0].id !== "v1");

  /* ---- property sweep: hostile dials + random rings never breach floors ---- */
  let leaks = 0;
  for (let i = 0; i < 200; i++) {
    const ring = Array.from({ length: 8 },
      () => pos(NOW - Math.random() * 90 * MIN, -0.1 - Math.random() * 0.2, 36.85 + Math.random() * 0.15));
    const out = await buildGuestSnapshot(
      [ring],
      { mode: "windowed", delayMinutes: Math.random() * 100 - 20, gridMetres: Math.random() * 5000 },
      NOW);
    for (const v of out) {
      if (v.seenBucket > NOW - FLOORS.minDelayMinutes * MIN) leaks++;
      if (v.gridMetres < FLOORS.minGridMetres) leaks++;
    }
  }
  assert("200-run property sweep: zero floor violations", leaks === 0);

  if (failures) {
    console.log(`\n${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\nrhino-rule projection: all assertions hold");
};

run();
