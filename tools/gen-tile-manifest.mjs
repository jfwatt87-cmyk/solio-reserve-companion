/* Build-time tile manifest generator.
 *
 * Walks public/tiles/{z}/{x}/{y}.jpg and writes public/tiles-manifest.json — the
 * exact set of tiles that exist on disk, grouped by zoom. The guest app reads
 * this to proactively pull the whole ~14 MB pyramid into the offline cache after
 * first load (so a phone that scans at the gate keeps the map in the dead zones).
 *
 * Grouping by zoom lets the client precache low zooms first and treat the heavy
 * z16 layer as best-effort, so an iOS cache-quota eviction still leaves usable
 * coverage. Runs automatically via the `prebuild` npm script — no manual step.
 */
import { readdirSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tilesDir = join(root, "public", "tiles");

const byZoom = {};
let count = 0;
let bytes = 0;

for (const z of readdirSync(tilesDir).sort((a, b) => Number(a) - Number(b))) {
  const zDir = join(tilesDir, z);
  if (!statSync(zDir).isDirectory()) continue;
  const urls = [];
  for (const x of readdirSync(zDir)) {
    const xDir = join(zDir, x);
    if (!statSync(xDir).isDirectory()) continue;
    for (const f of readdirSync(xDir)) {
      if (!f.endsWith(".jpg")) continue;
      urls.push(`tiles/${z}/${x}/${f}`);
      bytes += statSync(join(xDir, f)).size;
      count++;
    }
  }
  if (urls.length) byZoom[z] = urls.sort();
}

const manifest = { generated: new Date().toISOString(), count, bytes, byZoom };
const out = join(root, "public", "tiles-manifest.json");
writeFileSync(out, JSON.stringify(manifest));
console.log(`[tile-manifest] ${count} tiles, ${(bytes / 1e6).toFixed(1)} MB → public/tiles-manifest.json`);
