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
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tilesDir = join(root, "public", "tiles");

/* Guard: the tile cache name must be IDENTICAL in the service worker and the
 * precache module — they address the same Cache Storage bucket. Bumping one
 * without the other either silently ships stale tiles or strands the pyramid,
 * so a mismatch fails the build here, before anything can be deployed. */
const swTag = /const TILE_CACHE = "([^"]+)"/.exec(readFileSync(join(root, "public", "sw.js"), "utf8"))?.[1];
const tsTag = /export const TILE_CACHE_TAG = "([^"]+)"/.exec(
  readFileSync(join(root, "src", "lib", "precache.ts"), "utf8"),
)?.[1];
if (!swTag || !tsTag || swTag !== tsTag) {
  console.error(`[tile-manifest] FATAL: tile cache tag mismatch — sw.js has "${swTag}", precache.ts has "${tsTag}". Bump BOTH together.`);
  process.exit(1);
}

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

// Deterministic "generated" stamp: a hash of the content, not a timestamp, so
// two builds of the same tiles produce byte-identical manifests (lets the
// release runbook hash-compare the Cloudflare and GitHub Pages artifacts).
const digest = createHash("sha256").update(JSON.stringify(byZoom)).digest("hex").slice(0, 12);
const manifest = { generated: digest, count, bytes, byZoom };
const out = join(root, "public", "tiles-manifest.json");
writeFileSync(out, JSON.stringify(manifest));
console.log(`[tile-manifest] ${count} tiles, ${(bytes / 1e6).toFixed(1)} MB → public/tiles-manifest.json`);
