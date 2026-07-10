/**
 * Solio live-tracking Worker — PHASE 2 SCAFFOLD v2 (not deployed, not scope
 * until Callan agrees Module B; see vault "Phase 2 — Technical Spec").
 *
 * v2 after adversarial review (gpt-5.6-sol, 2026-07-10) — design rules:
 *
 *  - THE RHINO RULE IS AN INVARIANT, NOT A SETTING. Guests can only ever see
 *    a projection that is BOTH delayed AND coarsened past hard floors
 *    (FLOORS below), or nothing. There is no "live" guest mode; hostile or
 *    corrupt settings clamp to the floors or fail closed to "off".
 *  - Guests receive a dedicated allow-listed DTO (GuestVehicle) — never the
 *    private Position shape, so new private fields can't leak via spread.
 *    No heading, no raw timestamp, no stable vehicle id (ids rotate daily).
 *  - "Delayed" = a continuously-trailing snapshot built from a short history
 *    ring, NOT an ageing latest-position (which would hide a moving vehicle
 *    entirely, then reveal its exact stopping point — the worst case).
 *  - Guests cost one KV read: they get the prebuilt "snapshot:public" key,
 *    edge-cacheable. Naive list+N-reads polling costs ~$45/mo at 50 watchers;
 *    this design + Workers Paid ($5/mo) is the honest budget.
 *  - KV is EVENTUALLY consistent (~60 s): fine for positions, NOT fine as
 *    the production authority for token revocation or the guest dial. At
 *    build time those move to a Durable Object; interim: tokens expire, and
 *    dial/revocation changes propagate within ~60 s (documented, accepted
 *    for scaffold only).
 *  - Tokens are SERVER-generated (256-bit), returned once, stored as SHA-256
 *    hashes, bound to one vehicle, expiring. Never in URLs. Manager auth =
 *    wrangler secret (production: Cloudflare Access in front).
 *
 * Deploy (when agreed): env -u CLOUDFLARE_API_TOKEN npx wrangler deploy
 * (Solio account, tech@solioranch.co.ke — ambient-token trap).
 */

export interface Env {
  TRACK: KVNamespace;
  MANAGER_KEY: string; // wrangler secret — bootstrap manager credential
}

/* ---------------------------- invariants ---------------------------- */

export const FLOORS = {
  minDelayMinutes: 15, // guests never see anything fresher than this
  minGridMetres: 500, //  …or finer than this
  timeBucketMinutes: 15, // guest "seen" times round down to this
} as const;

// Solio bounding box + margin — positions outside are rejected as bogus
const BBOX = { lngMin: 36.8, lngMax: 37.05, latMin: -0.36, latMax: -0.04 };

const HISTORY_KEEP = 80; // ring entries per vehicle (~20 min at 15 s)
const POSITION_TTL_S = 3600;
const TOKEN_TTL_DAYS = 30;

/* ------------------------------ types ------------------------------- */

type Role = "guest" | "ranger" | "manager";

interface Position {
  vehicleId: string;
  label: string; // staff-facing, set by manager at token issue
  lat: number;
  lng: number;
  heading: number | null;
  ts: number; // server-assigned epoch ms
}

/** The ONLY shape guests ever receive. Additions require review + tests. */
export interface GuestVehicle {
  id: string; // daily-rotating hash — no cross-day trajectory linking
  cell: { lat: number; lng: number }; // grid-cell centre, never exact
  gridMetres: number;
  seenBucket: number; // epoch ms of a FLOORS.timeBucketMinutes bucket start
}

export interface GuestDial {
  mode: "off" | "windowed"; // that's the whole menu — no "live"
  delayMinutes: number; // clamped up to FLOORS.minDelayMinutes
  gridMetres: number; // clamped up to FLOORS.minGridMetres
}

/* --------------------- the enforcement functions --------------------- */

/** Hostile/corrupt settings clamp to floors or fail closed to "off". */
export function clampDial(raw: unknown): GuestDial {
  const off: GuestDial = { mode: "off", delayMinutes: FLOORS.minDelayMinutes, gridMetres: FLOORS.minGridMetres };
  if (typeof raw !== "object" || raw === null) return off;
  const d = raw as Record<string, unknown>;
  if (d.mode !== "windowed") return off; // anything unrecognised = off
  const num = (v: unknown, floor: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(v, floor) : floor;
  return {
    mode: "windowed",
    delayMinutes: num(d.delayMinutes, FLOORS.minDelayMinutes),
    gridMetres: num(d.gridMetres, FLOORS.minGridMetres),
  };
}

async function dailyId(vehicleId: string, now: number): Promise<string> {
  const day = new Date(now).toISOString().slice(0, 10);
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${vehicleId}:${day}`));
  return [...new Uint8Array(buf)].slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Build the guest projection from per-vehicle history rings: for each
 * vehicle, the NEWEST point already older than the delay (a continuously
 * trailing view — a moving vehicle shows its delayed trail, and a vehicle
 * that stops reporting never "ages into" exposing its exact final spot,
 * because the projection stays coarsened and time-bucketed too).
 */
export async function buildGuestSnapshot(
  histories: Position[][],
  rawDial: unknown,
  now: number,
): Promise<GuestVehicle[]> {
  const dial = clampDial(rawDial);
  if (dial.mode === "off") return [];
  const cutoff = now - dial.delayMinutes * 60_000;
  const dLat = dial.gridMetres / 110_574;
  const dLng = dial.gridMetres / (111_320 * Math.cos((-0.1975 * Math.PI) / 180));
  const bucketMs = FLOORS.timeBucketMinutes * 60_000;
  const out: GuestVehicle[] = [];
  for (const ring of histories) {
    const eligible = ring.filter((p) => p.ts <= cutoff);
    if (!eligible.length) continue;
    const p = eligible.reduce((a, b) => (a.ts > b.ts ? a : b));
    out.push({
      id: await dailyId(p.vehicleId, now),
      cell: {
        lat: Math.round(p.lat / dLat) * dLat,
        lng: Math.round(p.lng / dLng) * dLng,
      },
      gridMetres: dial.gridMetres,
      seenBucket: Math.floor(p.ts / bucketMs) * bucketMs,
    });
  }
  return out;
}

/* ------------------------------ helpers ------------------------------ */

async function sha256hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Digest-equality compare — no early-exit string comparison on secrets. */
async function secretEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256hex(`k:${a}`), sha256hex(`k:${b}`)]);
  return ha === hb;
}

interface TokenRecord {
  kind: "ranger";
  vehicleId: string;
  label: string;
  expiresAt: number;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "private, no-store" },
  });

const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";

/* ------------------------------ routes ------------------------------- */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // Route dispatch BEFORE any KV/auth work: unknown paths cost nothing.
    if (url.pathname === "/api/positions" && req.method === "GET") return positions(req, env);
    if (url.pathname === "/api/track" && req.method === "POST") return track(req, env);
    if (url.pathname === "/api/admin" && req.method === "POST") return admin(req, env);
    return json({ error: "not found" }, 404);
  },
};

async function positions(req: Request, env: Env): Promise<Response> {
  const token = bearer(req);
  if (!token) {
    // Guests: ONE KV read of an already-sanitised snapshot, edge-cacheable.
    const snap = (await env.TRACK.get("snapshot:public")) ?? "[]";
    return new Response(JSON.stringify({ role: "guest", vehicles: JSON.parse(snap) }), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=30" },
    });
  }
  const role = await staffRole(token, env);
  if (role === "guest") return json({ error: "unauthorised" }, 401);
  const list = await env.TRACK.list({ prefix: "pos:" });
  const vehicles: Position[] = [];
  for (const k of list.keys) {
    const v = await env.TRACK.get(k.name);
    if (v) {
      const ring: Position[] = JSON.parse(v);
      if (ring.length) vehicles.push(ring[ring.length - 1]);
    }
  }
  return json({ role, vehicles });
}

async function track(req: Request, env: Env): Promise<Response> {
  const token = bearer(req);
  if (!token || token.length > 128) return json({ error: "unauthorised" }, 401);
  const rec = await tokenRecord(token, env);
  if (!rec) return json({ error: "unauthorised" }, 401);

  const b = (await req.json().catch(() => null)) as { lat?: unknown; lng?: unknown; heading?: unknown } | null;
  const lat = typeof b?.lat === "number" && Number.isFinite(b.lat) ? b.lat : NaN;
  const lng = typeof b?.lng === "number" && Number.isFinite(b.lng) ? b.lng : NaN;
  if (!(lat >= BBOX.latMin && lat <= BBOX.latMax && lng >= BBOX.lngMin && lng <= BBOX.lngMax)) {
    return json({ error: "position out of bounds" }, 400);
  }
  const now = Date.now();
  const pos: Position = {
    vehicleId: rec.vehicleId, // token-bound — a device can only be its own vehicle
    label: rec.label, // server-managed; client input ignored
    lat,
    lng,
    heading: typeof b?.heading === "number" && Number.isFinite(b.heading) ? b.heading : null,
    ts: now, // server clock, never the client's
  };
  const key = `pos:${rec.vehicleId}`;
  const ring: Position[] = JSON.parse((await env.TRACK.get(key)) ?? "[]");
  ring.push(pos);
  await env.TRACK.put(key, JSON.stringify(ring.slice(-HISTORY_KEEP)), { expirationTtl: POSITION_TTL_S });

  // Rebuild the public snapshot on the write path (≤10 vehicles ⇒ cheap here,
  // and guests stay at one read each). Production home: a Durable Object.
  const list = await env.TRACK.list({ prefix: "pos:" });
  const histories: Position[][] = [];
  for (const k of list.keys) {
    const v = await env.TRACK.get(k.name);
    if (v) histories.push(JSON.parse(v));
  }
  const dial = JSON.parse((await env.TRACK.get("settings:guestDial")) ?? "null");
  const snap = await buildGuestSnapshot(histories, dial, now);
  await env.TRACK.put("snapshot:public", JSON.stringify(snap), { expirationTtl: POSITION_TTL_S });
  return json({ ok: true });
}

async function admin(req: Request, env: Env): Promise<Response> {
  if (!(await secretEqual(bearer(req), env.MANAGER_KEY))) return json({ error: "unauthorised" }, 401);
  const b = (await req.json().catch(() => null)) as
    | { action?: string; vehicleId?: string; label?: string; tokenHash?: string; dial?: unknown }
    | null;
  if (b?.action === "issue" && typeof b.vehicleId === "string" && /^[\w-]{1,32}$/.test(b.vehicleId)) {
    const raw = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((x) => x.toString(16).padStart(2, "0"))
      .join("");
    const rec: TokenRecord = {
      kind: "ranger",
      vehicleId: b.vehicleId,
      label: String(b.label ?? b.vehicleId).slice(0, 40),
      expiresAt: Date.now() + TOKEN_TTL_DAYS * 86_400_000,
    };
    await env.TRACK.put(`token:${await sha256hex(raw)}`, JSON.stringify(rec));
    return json({ ok: true, token: raw, note: "shown once — store on the device, never in a URL" });
  }
  if (b?.action === "revoke" && typeof b.tokenHash === "string" && /^[0-9a-f]{64}$/.test(b.tokenHash)) {
    await env.TRACK.delete(`token:${b.tokenHash}`);
    return json({ ok: true, note: "KV propagation ≤60 s; production authority = Durable Object" });
  }
  if (b?.action === "dial") {
    const dial = clampDial(b.dial); // floors enforced at write AND again at read
    await env.TRACK.put("settings:guestDial", JSON.stringify(dial));
    if (dial.mode === "off") {
      await env.TRACK.put("snapshot:public", "[]", { expirationTtl: POSITION_TTL_S });
    }
    return json({ ok: true, dial });
  }
  return json({ error: "bad action" }, 400);
}

async function staffRole(token: string, env: Env): Promise<Role> {
  if (await secretEqual(token, env.MANAGER_KEY)) return "manager";
  return (await tokenRecord(token, env)) ? "ranger" : "guest";
}

async function tokenRecord(token: string, env: Env): Promise<TokenRecord | null> {
  const v = await env.TRACK.get(`token:${await sha256hex(token)}`);
  if (!v) return null;
  const rec = JSON.parse(v) as TokenRecord;
  return rec.expiresAt > Date.now() ? rec : null;
}
