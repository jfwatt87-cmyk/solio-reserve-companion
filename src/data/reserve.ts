/**
 * Reserve definition for the PoC.
 *
 * This defines the PIXEL coordinate system that every overlay (POIs, rhinos,
 * roads) is authored in: Callan's georeferenced poster at 2400×3601. The four
 * GROUND CONTROL POINTS tie its corners to real-world coordinates (read from
 * SOLIO_MAP_FINAL.tif). The map the app actually DISPLAYS is the georeferenced
 * true-north poster (`assets/solio-truenorth.jpg`), pinned by its four world
 * corners in ReserveMap.tsx — overlays are placed by lng/lat, so they align.
 * Do NOT change IMAGE_WIDTH/HEIGHT without rescaling every authored pixel below.
 *
 * A Ground Control Point ties one pixel on the image to one real-world
 * coordinate. You get them by clicking known features (gate, lodge, a junction)
 * on the image and reading their GPS coordinate from the field or from
 * satellite imagery. Three is the minimum; five+ spread to the corners is
 * comfortable and lets us report a fit error.
 */

import { GeoReference, type ControlPoint } from "../lib/georef";
import type { LatLng } from "../lib/geo";

/** Pixel dimensions of the authored coordinate system (Callan's poster). */
export const IMAGE_WIDTH = 2400;
export const IMAGE_HEIGHT = 3601;

// Per-layer visibility. POIs are re-authored on the real map (in data/pois.ts);
// the road OVERLAY stays off until real road vectors arrive from Callan (the
// illustration already draws its own roads), but the active navigation route
// renders. Live rhino tracking is intentionally excluded from this app for the
// animals' safety — no animal-location data exists in the app at all.
export const SHOW_POIS = true;
export const SHOW_ROADS = false;
export const SHOW_ROUTE = true;
// The authoritative GIS reserve outline (data/boundary.ts). Off by default: the
// poster already draws the boundary, and the true GPS edge differs from the
// artwork's drawn edge by up to ~50 m, so overlaying it doubles the line.
export const SHOW_BOUNDARY = false;

// Turn-by-turn navigation (route preview + drive mode + nav banner). OFF for the
// Phase 1 launch (2026-07-09, at Callan's request): the routing faithfully follows
// the roads in the GIS export, but that export's interior tracks and — especially —
// river/bridge crossings aren't fully connected, so A* is forced onto perimeter/
// fence-line roads and sends guests the long way. All the routing code stays in the
// build; flip this back to `true` once Callan's roads layer is repaired (bridges
// noded, lodge access tracks added) and routes verify as direct. The robust parts
// (live map, GPS dot, drawn roads, tap-a-place for distance) are unaffected.
//
// BEFORE FLIPPING THIS ON — the Marriotts private road (D80/D82). Solio asked us to
// keep guests off it. Today that is satisfied for free: the S18/S20 crossings are cut,
// so the drive survives only as three dead-end spurs, and nothing routes to them
// because the app routes to POIs and the corridor's only POI is JW Marriott — a lodge
// that must stay reachable. Turning nav on is what makes that reasoning load-bearing,
// so re-check it here: guests must be able to navigate TO JW Marriott, but must never
// be routed THROUGH the corridor or nudged onto a spur that dead-ends at the river.
// Parked deliberately at James's call (2026-07-14): it is a nav-time question, not a
// roads-data one. Closing the drive outright needs Callan to identify which roads ARE
// the drive — we have geometry for two crossings on it, not for the road itself.
//
// ALSO BEFORE FLIPPING THIS ON — GPS-accuracy gating (D105–D108, 2026-07-22). The
// popup drive distance learned the hard way that a poor fix beside close roads can
// snap to the wrong edge and understate a drive by kilometres. The popup now gates on
// accuracy ≤50 m and edge ambiguity; nav's OWN route consumers (nearestNode start
// snapping, off-route re-routing) predate that work and need the equivalent gating
// before any guest is guided by them (gpt-5.6-sol round 4).
export const NAV_ENABLED = false;

/**
 * Pixel margin used when testing whether a GPS fix is "at Solio" — the artwork
 * draws surrounding landscape beyond the reserve, so allow a generous border.
 */
export const MAP_MARGIN = 700;

/**
 * Control points tying base-map image pixels to real GPS, taken directly from
 * the georeferencing embedded in Callan's GeoTIFF (EPSG:3857 → WGS84). The four
 * image corners define an exact affine placement, so the live GPS dot lands
 * correctly on the real reserve map. (Verified against satellite imagery.)
 */
export const CONTROL_POINTS: ControlPoint[] = [
  { label: "NW corner", pixel: { x: 0, y: 0 }, world: { lng: 36.849258, lat: -0.090041 } },
  { label: "NE corner", pixel: { x: IMAGE_WIDTH, y: 0 }, world: { lng: 37.002478, lat: -0.090041 } },
  { label: "SW corner", pixel: { x: 0, y: IMAGE_HEIGHT }, world: { lng: 36.849258, lat: -0.305231 } },
  { label: "SE corner", pixel: { x: IMAGE_WIDTH, y: IMAGE_HEIGHT }, world: { lng: 37.002478, lat: -0.305231 } },
];

/**
 * Single shared georeference (affine from the GeoTIFF corners). Every feature is
 * authored in base-image PIXEL coordinates and lifted to real GPS through it, so
 * all overlays sit at their true world positions on the real map.
 */
const GEOREF = new GeoReference(IMAGE_WIDTH, IMAGE_HEIGHT, CONTROL_POINTS);

/** The georeference used across the app. */
export function createGeoReference(): GeoReference {
  return GEOREF;
}

/** Convert an authored pixel coordinate to its real-world coordinate. */
export function pixelWorld(x: number, y: number): LatLng {
  return GEOREF.pixelToWorld({ x, y });
}
