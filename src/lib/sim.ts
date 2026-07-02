/**
 * Position simulation. Because reviewers won't physically be in Laikipia, the
 * PoC can drive a vehicle along a path at a set speed. The same component reads
 * real device GPS when "Use my GPS" is enabled — the rest of the app cannot
 * tell the difference.
 */

import { bearingDeg, distanceMeters, type LatLng } from "./geo";

export interface Pose {
  pos: LatLng;
  heading: number;
}

/** Cumulative arc-length lookup along a polyline. */
export function pathLength(path: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distanceMeters(path[i - 1], path[i]);
  return total;
}

/** Interpolate a pose at `distM` metres along `path` (clamped to its ends). */
export function poseAlong(path: LatLng[], distM: number): Pose {
  if (path.length === 0) return { pos: { lat: 0, lng: 0 }, heading: 0 };
  if (path.length === 1) return { pos: path[0], heading: 0 };
  let remaining = Math.max(0, distM);
  for (let i = 1; i < path.length; i++) {
    const seg = distanceMeters(path[i - 1], path[i]);
    if (remaining <= seg || i === path.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, remaining / seg);
      const a = path[i - 1];
      const b = path[i];
      return {
        pos: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t },
        heading: bearingDeg(a, b),
      };
    }
    remaining -= seg;
  }
  return { pos: path[path.length - 1], heading: 0 };
}
