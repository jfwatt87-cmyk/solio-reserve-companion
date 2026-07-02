/**
 * Road-network source selector.
 *
 * The app consumes the road network through this module only. Two sources share
 * the exact same shape (see roads.ts):
 *
 *  - `roads.gis.ts` — generated from Solio's authoritative GIS road vectors by
 *    `tools/roads/import_gis_roads.py`. PREFERRED whenever the file exists.
 *  - `roads.ts` — road centrelines digitized off the georeferenced poster
 *    (traced + back-projected to GPS). The fallback until the GIS file lands.
 *
 * `import.meta.glob` resolves at build time: if roads.gis.ts is absent the glob
 * is empty and the traced network ships — no code changes needed either way.
 */

import * as traced from "./roads";

type RoadModule = typeof traced;

const gisModules = import.meta.glob("./roads.gis.ts", { eager: true });
const gis = gisModules["./roads.gis.ts"] as RoadModule | undefined;

/** True when the GIS-imported network is active. */
export const USING_GIS_ROADS = gis !== undefined;

const source: RoadModule = gis ?? traced;

export const NODE_PIXEL = source.NODE_PIXEL;
export const ROAD_GEOMS = source.ROAD_GEOMS;
export const createRoadNetwork = source.createRoadNetwork;
export type { RoadGeom } from "./roads";
