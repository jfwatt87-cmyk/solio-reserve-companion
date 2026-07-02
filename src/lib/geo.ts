/**
 * Geographic primitives — distance, bearing and formatting on the WGS84 sphere.
 * Distances are returned in metres; bearings in degrees clockwise from true north.
 */

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Great-circle (haversine) distance between two points, in metres. */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from `a` to `b`, degrees [0,360). */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** Move from `origin` a given distance (m) along a bearing (deg). */
export function destinationPoint(
  origin: LatLng,
  distMeters: number,
  bearing: number,
): LatLng {
  const angular = distMeters / EARTH_RADIUS_M;
  const br = toRad(bearing);
  const lat1 = toRad(origin.lat);
  const lng1 = toRad(origin.lng);
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) +
      Math.cos(lat1) * Math.sin(angular) * Math.cos(br),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(br) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: toDeg(lat2), lng: toDeg(lng2) };
}

/**
 * Project a point onto a polyline: the perpendicular ("cross-track") distance to
 * the nearest point on the line, and how far ALONG the line that nearest point is
 * (arc length from the start). Used to tell whether a driver has left the planned
 * route (cross) and how far through it they are (along). Uses a local
 * equirectangular projection around the point — fine over the distances here.
 */
export function projectOnPath(p: LatLng, path: LatLng[]): { along: number; cross: number } {
  if (path.length === 0) return { along: 0, cross: Infinity };
  if (path.length === 1) return { along: 0, cross: distanceMeters(p, path[0]) };
  const mPerLat = 111_320;
  const mPerLng = 111_320 * Math.cos(toRad(p.lat));
  let best = Infinity;
  let bestAlong = 0;
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    const ax = (path[i - 1].lng - p.lng) * mPerLng;
    const ay = (path[i - 1].lat - p.lat) * mPerLat;
    const bx = (path[i].lng - p.lng) * mPerLng;
    const by = (path[i].lat - p.lat) * mPerLat;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const segLen = Math.sqrt(len2);
    let t = len2 ? (-ax * dx - ay * dy) / len2 : 0; // p is at the origin
    t = Math.max(0, Math.min(1, t));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) {
      best = d;
      bestAlong = acc + t * segLen;
    }
    acc += segLen;
  }
  return { along: bestAlong, cross: best };
}

/** Shortest distance (m) from a point to a polyline — the cross-track deviation. */
export function pointToPathMeters(p: LatLng, path: LatLng[]): number {
  return projectOnPath(p, path).cross;
}

const COMPASS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/** 16-point compass label for a bearing. */
export function compass(bearing: number): string {
  return COMPASS[Math.round(bearing / 22.5) % 16];
}

/** Human-friendly distance string. */
export function formatDistance(meters: number): string {
  if (meters < 950) return `${Math.round(meters / 10) * 10} m`;
  return `${(meters / 1000).toFixed(meters < 9500 ? 1 : 0)} km`;
}

/** "3 minutes ago" style relative time from an epoch (ms). */
export function timeAgo(epochMs: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - epochMs) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr${h > 1 ? "s" : ""} ago`;
  const d = Math.round(h / 24);
  return `${d} day${d > 1 ? "s" : ""} ago`;
}
