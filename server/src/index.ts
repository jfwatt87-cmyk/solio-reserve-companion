/**
 * Solio live-tracking Worker — PHASE 2 SCAFFOLD (not deployed, not scope
 * until Callan agrees Module B; see vault "Phase 2 — Technical Spec").
 *
 * Design rules baked in:
 *  - THE RHINO RULE lives HERE, server-side, in filterForRole(). No client
 *    ever receives positions its role isn't allowed to see, so no client bug
 *    can leak them. Change the guest dial ONLY via SETTINGS in KV.
 *  - Vehicles, never animals.
 *  - Boring auth: per-device tokens issued by the manager; guests anonymous.
 *
 * Deploy (when agreed): wrangler deploy — same Cloudflare account as the
 * Pages site (tech@solioranch.co.ke), and remember the ambient
 * CLOUDFLARE_API_TOKEN trap: `env -u CLOUDFLARE_API_TOKEN npx wrangler ...`
 */

export interface Env {
  TRACK: KVNamespace; // positions (TTL'd), device tokens, settings
}

type Role = "guest" | "ranger" | "manager";

interface Position {
  vehicleId: string;
  label: string; // "Ranger 1", never an animal reference
  lat: number;
  lng: number;
  heading: number | null;
  ts: number; // epoch ms, server-assigned
}

/** Guest-visibility dial — Callan's choice, stored in KV under "settings". */
interface GuestDial {
  mode: "off" | "delayed" | "coarse" | "live";
  delayMinutes: number; // used when mode = delayed
  gridMetres: number; // used when mode = coarse
}

const DEFAULT_DIAL: GuestDial = { mode: "off", delayMinutes: 30, gridMetres: 1000 };
const POSITION_TTL_S = 3600;

/* ------------------------------------------------------------------ *
 * THE enforcement point. Everything above/below is plumbing.          *
 * ------------------------------------------------------------------ */
export function filterForRole(positions: Position[], role: Role, dial: GuestDial, now: number): Position[] {
  if (role === "manager" || role === "ranger") return positions;
  switch (dial.mode) {
    case "off":
      return [];
    case "live":
      return positions;
    case "delayed":
      return positions.filter((p) => now - p.ts >= dial.delayMinutes * 60_000);
    case "coarse": {
      // snap to grid: guests see "a vehicle is in this square", nothing finer
      const dLat = dial.gridMetres / 110_574;
      const dLng = dial.gridMetres / (111_320 * Math.cos((-0.1975 * Math.PI) / 180));
      return positions.map((p) => ({
        ...p,
        lat: Math.round(p.lat / dLat) * dLat,
        lng: Math.round(p.lng / dLng) * dLng,
        heading: null,
      }));
    }
  }
}

async function roleForRequest(req: Request, env: Env): Promise<Role> {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return "guest";
  const kind = await env.TRACK.get(`token:${token}`);
  return kind === "manager" ? "manager" : kind === "ranger" ? "ranger" : "guest";
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const role = await roleForRequest(req, env);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    // ranger/manager devices report their vehicle position
    if (url.pathname === "/api/track" && req.method === "POST") {
      if (role === "guest") return json({ error: "unauthorised" }, 401);
      const b = (await req.json()) as Partial<Position>;
      if (typeof b.lat !== "number" || typeof b.lng !== "number" || !b.vehicleId) {
        return json({ error: "bad payload" }, 400);
      }
      const pos: Position = {
        vehicleId: String(b.vehicleId),
        label: String(b.label ?? b.vehicleId),
        lat: b.lat,
        lng: b.lng,
        heading: typeof b.heading === "number" ? b.heading : null,
        ts: Date.now(), // server clock, not client's
      };
      await env.TRACK.put(`pos:${pos.vehicleId}`, JSON.stringify(pos), { expirationTtl: POSITION_TTL_S });
      return json({ ok: true });
    }

    // anyone may ask; the role filter decides what they get
    if (url.pathname === "/api/positions" && req.method === "GET") {
      const list = await env.TRACK.list({ prefix: "pos:" });
      const positions: Position[] = [];
      for (const k of list.keys) {
        const v = await env.TRACK.get(k.name);
        if (v) positions.push(JSON.parse(v));
      }
      const dial: GuestDial = JSON.parse((await env.TRACK.get("settings:guestDial")) ?? "null") ?? DEFAULT_DIAL;
      return json({ role, positions: filterForRole(positions, role, dial, Date.now()) });
    }

    // manager issues/revokes device tokens + sets the guest dial
    if (url.pathname === "/api/admin" && req.method === "POST") {
      if (role !== "manager") return json({ error: "unauthorised" }, 401);
      const b = (await req.json()) as { action: string; token?: string; kind?: string; dial?: GuestDial };
      if (b.action === "issue" && b.token && (b.kind === "ranger" || b.kind === "manager")) {
        await env.TRACK.put(`token:${b.token}`, b.kind);
        return json({ ok: true });
      }
      if (b.action === "revoke" && b.token) {
        await env.TRACK.delete(`token:${b.token}`);
        return json({ ok: true });
      }
      if (b.action === "dial" && b.dial) {
        await env.TRACK.put("settings:guestDial", JSON.stringify(b.dial));
        return json({ ok: true });
      }
      return json({ error: "bad action" }, 400);
    }

    return json({ error: "not found" }, 404);
  },
};
