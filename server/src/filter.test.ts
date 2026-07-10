/**
 * Tests for THE rhino-rule enforcement point. If these fail, nothing ships.
 * Run: npx tsx server/src/filter.test.ts  (zero-framework: throws on failure)
 */
import { filterForRole } from "./index";

const NOW = 1_752_000_000_000;
const pos = (ts: number) => ({
  vehicleId: "v1",
  label: "Ranger 1",
  lat: -0.198765,
  lng: 36.912345,
  heading: 90,
  ts,
});
const dial = (mode: "off" | "delayed" | "coarse" | "live") => ({
  mode,
  delayMinutes: 30,
  gridMetres: 1000,
});

function assert(name: string, cond: boolean) {
  if (!cond) throw new Error(`FAIL: ${name}`);
  console.log(`PASS: ${name}`);
}

// default posture: guests see NOTHING
assert("guest sees nothing when dial off", filterForRole([pos(NOW)], "guest", dial("off"), NOW).length === 0);

// staff always see everything, live
assert("ranger sees live regardless of dial", filterForRole([pos(NOW)], "ranger", dial("off"), NOW).length === 1);
assert("manager sees live regardless of dial", filterForRole([pos(NOW)], "manager", dial("off"), NOW).length === 1);

// delayed: fresh positions are withheld from guests, stale ones shown
assert("guest delayed hides fresh", filterForRole([pos(NOW - 5 * 60_000)], "guest", dial("delayed"), NOW).length === 0);
assert("guest delayed shows old", filterForRole([pos(NOW - 31 * 60_000)], "guest", dial("delayed"), NOW).length === 1);

// coarse: guests never receive precise coordinates or heading
const coarse = filterForRole([pos(NOW)], "guest", dial("coarse"), NOW)[0];
assert("coarse strips heading", coarse.heading === null);
assert("coarse rounds lat", coarse.lat !== pos(NOW).lat);
assert("coarse rounds lng", coarse.lng !== pos(NOW).lng);
const dLat = 1000 / 110_574;
assert("coarse lat on 1 km grid", Math.abs(coarse.lat / dLat - Math.round(coarse.lat / dLat)) < 1e-9);

console.log("\nrhino-rule filter: all assertions hold");
