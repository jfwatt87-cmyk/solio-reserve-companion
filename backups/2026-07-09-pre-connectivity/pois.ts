/**
 * Points of interest — visitor destinations the app can navigate to.
 * `nodeId` ties each POI onto the road network for routing.
 */

import { pixelWorld } from "./reserve";
import type { LatLng } from "../lib/geo";
import type { Pixel } from "../lib/georef";

export type PoiKind =
  | "gate"
  | "lodge"
  | "orphanage"
  | "airstrip"
  | "viewpoint"
  | "waterhole"
  | "picnic";

export interface Poi {
  id: string;
  name: string;
  kind: PoiKind;
  pixel: Pixel;
  nodeId: string;
  blurb: string;
}

// Positions digitised from the real georeferenced map (base-image pixels).
export const POIS: Poi[] = [
  {
    id: "gate",
    name: "Main Gate",
    kind: "gate",
    pixel: { x: 601, y: 2671 },
    nodeId: "gate",
    blurb: "Reception, check-in and conservation fees.",
  },
  {
    id: "rhinogate",
    name: "Rhino Gate",
    kind: "gate",
    pixel: { x: 2044, y: 906 },
    nodeId: "rhinogate",
    blurb: "North-eastern entrance to the reserve.",
  },
  {
    id: "airstrip",
    name: "Airstrip",
    kind: "airstrip",
    pixel: { x: 485, y: 2666 },
    nodeId: "airstrip",
    blurb: "Fly-in arrivals and departures.",
  },
  {
    id: "lodge",
    name: "Solio Lodge",
    kind: "lodge",
    pixel: { x: 869, y: 2406 },
    nodeId: "lodge",
    blurb: "Guest lodge with views to the Aberdares.",
  },
  {
    id: "jw",
    name: "JW Marriott",
    kind: "lodge",
    pixel: { x: 778, y: 1900 },
    nodeId: "jw",
    blurb: "Safari lodge on the western plains.",
  },
  {
    id: "orphanage",
    name: "Solio Rhino Orphanage",
    kind: "orphanage",
    pixel: { x: 759, y: 2514 },
    nodeId: "orphanage",
    blurb: "Rescues and rewilds orphaned rhino.",
  },
  {
    id: "kingfisher",
    name: "Kingfisher Dam",
    kind: "waterhole",
    pixel: { x: 952, y: 1055 },
    nodeId: "kingfisher",
    blurb: "Northern dam.",
  },
  {
    id: "yellowthorn",
    name: "Yellow Thorn Spring & Dam",
    kind: "waterhole",
    pixel: { x: 1594, y: 1237 },
    nodeId: "yellowthorn",
    blurb: "Spring-fed dam.",
  },
  {
    id: "naribo",
    name: "Naribo Springs",
    kind: "waterhole",
    pixel: { x: 1814, y: 1013 },
    nodeId: "naribo",
    blurb: "Eastern springs.",
  },
  {
    id: "choroa",
    name: "Choroa Dam",
    kind: "waterhole",
    pixel: { x: 1601, y: 1610 },
    nodeId: "choroa",
    blurb: "Central dam.",
  },
];

export function poiWorld(p: Poi): LatLng {
  return pixelWorld(p.pixel.x, p.pixel.y);
}
