/**
 * Gated routing-origin resolution — ONE implementation of the safety rules the
 * drive-distance popup earned through three adversarial review rounds
 * (D105–D108), shared by every consumer that turns a live position into a
 * route start:
 *
 *   1. ACCURACY GATE — a real-GPS position may only drive routing when the fix
 *      is proven good (accuracy known and ≤ GOOD_FIX_M). Poor or UNKNOWN
 *      accuracy fails closed: a 100 m fix beside close roads can put every
 *      plausible candidate on the wrong side of the reserve and understate a
 *      4.6 km drive as 40 m (gpt-5.6-sol round 3). Phrased as "not proven
 *      good" so NaN or any non-comparable value also fails closed (round 4).
 *      Sim positions are exact by construction and skip the gate.
 *   2. EDGE PROJECTION, NOT NODE SNAP — the nearest graph NODE can belong to a
 *      road the guest is not on; mid-edge guests were understated by 6.8 km
 *      (post-release audit, finding 3).
 *   3. AMBIGUITY — with ordinary GPS error the nearest edge is only a guess.
 *      Every edge within SNAP_AMBIGUITY_M of the nearest is plausibly
 *      occupied; if the candidates' drive totals disagree by more than
 *      ROUTE_AGREE_M we genuinely don't know which road the guest is on, and
 *      no routing may proceed (round 2).
 *   4. BLOCKERS — if any plausible candidate's user→road connector passes near
 *      a cut crossing segment, routing could silently assume a crossing the
 *      graph forbids (R8/R9). Refuse.
 *
 * Consumers: the popup drive distance (display policy stays with the caller)
 * and — since the nav gating work (D115) — route preview, live re-routing,
 * stop replanning and tour legs. If you are about to turn a live position into
 * a route ANYWHERE else, come through this module.
 */

import type { LatLng } from "./geo";
import { distanceMeters, segmentsMinMeters } from "./geo";
import type { RoadSnap, Route } from "./routing";
import { BLOCKER_SEGMENTS } from "../data/blockers";

/** Accuracy threshold: at or below this a GPS fix is treated as precise. */
export const GOOD_FIX_M = 50;
/** GPS error envelope (good fix ≤50 m) + projection slop. */
export const SNAP_AMBIGUITY_M = 75;
/** Candidate drive totals further apart than this = ambiguous, refuse. */
export const ROUTE_AGREE_M = 500;
/** A connector passing nearer than this to a cut crossing = refuse. */
export const BLOCKER_CLEARANCE_M = 25;
/** Further than this from any road: don't route, show direct information. */
export const OFF_NETWORK_M = 2000;

/** The slice of RoadNetwork this module needs (the app passes its lazy wrapper). */
export interface RoutingNet {
  route(startId: string, goalId: string): Route | null;
  nearestRoadPoints(p: LatLng, toleranceM: number): RoadSnap[];
}

export interface Fix {
  source: "gps" | "sim";
  /** Metres, from the geolocation fix; null = unknown (fails closed). */
  accuracy: number | null;
}

export type OriginFailure =
  /** Real GPS without a proven-good fix — wait, don't route. */
  | "poor-fix"
  /** No road within OFF_NETWORK_M — routing is meaningless here. */
  | "off-network"
  /** A plausible connector passes near a cut crossing — refuse. */
  | "blocked"
  /** Plausible edges disagree about the drive — we don't know the road. */
  | "ambiguous"
  /** A plausible candidate cannot reach the destination at all. */
  | "no-route";

export type OriginCandidates =
  | { ok: true; perEdge: { snap: RoadSnap; bestEndId: string; totalM: number }[] }
  | { ok: false; reason: Exclude<OriginFailure, "ambiguous"> };

/**
 * Gate a live position and produce the per-edge routing candidates toward a
 * destination. Implements rules 1, 2 and 4 (and the off-network bound); the
 * AMBIGUITY decision (rule 3) is left to the caller because display policy
 * differs — the popup min/maxes over the set, `resolveRouteStart` refuses.
 */
export function gatedOriginCandidates(
  net: RoutingNet,
  user: LatLng,
  fix: Fix,
  destNodeId: string,
): OriginCandidates {
  if (fix.source === "gps" && !(fix.accuracy != null && fix.accuracy <= GOOD_FIX_M)) {
    return { ok: false, reason: "poor-fix" };
  }
  const candidates = net.nearestRoadPoints(user, SNAP_AMBIGUITY_M);
  if (candidates.length === 0 || candidates[0].gapM > OFF_NETWORK_M) {
    return { ok: false, reason: "off-network" };
  }
  const perEdge: { snap: RoadSnap; bestEndId: string; totalM: number }[] = [];
  for (const snap of candidates) {
    if (
      BLOCKER_SEGMENTS.some((s) => segmentsMinMeters(user, snap.point, s[0], s[1]) < BLOCKER_CLEARANCE_M)
    ) {
      return { ok: false, reason: "blocked" };
    }
    let best: { endId: string; totalM: number } | null = null;
    for (const [endId, alongM] of [
      [snap.aId, snap.alongToAM],
      [snap.bId, snap.alongToBM],
    ] as const) {
      const r = net.route(endId, destNodeId);
      if (!r) continue; // endpoint unreachable — try the other one
      // r.totalM is 0 when the destination IS this endpoint: the along-edge
      // distance already covers the drive, so an empty path is fine here.
      const totalM = snap.gapM + alongM + r.totalM;
      if (!best || totalM < best.totalM) best = { endId, totalM };
    }
    // A plausible edge with NO route to the destination means the real drive
    // cannot be bounded — fail safe.
    if (!best) return { ok: false, reason: "no-route" };
    perEdge.push({ snap, bestEndId: best.endId, totalM: best.totalM });
  }
  return { ok: true, perEdge };
}

export type OriginResolution =
  | { ok: true; startId: string; snap: RoadSnap; totalM: number }
  | { ok: false; reason: OriginFailure };

/**
 * Resolve a route START for navigation: all four rules enforced. Returns the
 * best endpoint of the best candidate edge only when every plausible edge
 * agrees (within ROUTE_AGREE_M) about the drive — otherwise refuses, because
 * guiding a guest from the wrong road is exactly the failure the popup's
 * review rounds kept finding.
 */
export function resolveRouteStart(
  net: RoutingNet,
  user: LatLng,
  fix: Fix,
  destNodeId: string,
): OriginResolution {
  const g = gatedOriginCandidates(net, user, fix, destNodeId);
  if (!g.ok) return g;
  let min = Infinity;
  let max = -Infinity;
  let best: { snap: RoadSnap; bestEndId: string; totalM: number } | null = null;
  for (const c of g.perEdge) {
    min = Math.min(min, c.totalM);
    max = Math.max(max, c.totalM);
    if (!best || c.totalM < best.totalM) best = c;
  }
  if (max - min > ROUTE_AGREE_M) return { ok: false, reason: "ambiguous" };
  return { ok: true, startId: best!.bestEndId, snap: best!.snap, totalM: best!.totalM };
}

/** Honest guest-facing line for each refusal, shared so wording stays consistent. */
export function originFailureMessage(reason: OriginFailure, destName: string): string {
  switch (reason) {
    case "poor-fix":
      return "Waiting for an accurate GPS fix — routing will start once your position settles";
    case "ambiguous":
      return "Can't tell which road you're on yet — drive on a little and try again";
    case "blocked":
      return "You're beside a closed crossing — routing from here could mislead";
    case "off-network":
    case "no-route":
      return `No drivable route to ${destName} yet`;
  }
}

/** Re-export for callers that only need the distance guard. */
export { distanceMeters };
