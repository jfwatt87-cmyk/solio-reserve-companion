/**
 * Interactive reserve map (MapLibre GL).
 *
 * The base is Callan's straightened, compass-corrected poster, shown AXIS-ALIGNED
 * (always perfectly square, exactly like the artwork) via a synthetic display box.
 * Overlays are real GPS: each lng/lat is projected onto the poster's pixel grid
 * through its inverse georeference, then into the box (see `toDisplay`), so the
 * "you are here" dot lands on the right feature while the poster never tilts.
 *
 * Overlays keep their hand-drawn styling: POIs and the live "you are here" dot
 * are HTML markers positioned by MapLibre in lng/lat; the route line is a
 * GeoJSON layer. Everything is authored in world coordinates, so no pixel
 * maths here. (No animal-location data exists anywhere in the app.)
 */

import { useEffect, useRef, useState } from "react";
import maplibregl from "maplibre-gl";
import type { Map as MLMap, GeoJSONSource, LngLatBoundsLike } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./reserve-map.css";
import baseMeta from "../assets/solio-truenorth.json";
import tilesMeta from "../assets/tiles-meta.json";
import { SHOW_ROADS, SHOW_ROUTE, SHOW_POIS, SHOW_BOUNDARY, pixelWorld } from "../data/reserve";
import { ROAD_GEOMS } from "../data/roadSource";
import { RESERVE_BOUNDARY } from "../data/boundary";
import { POIS, type Poi } from "../data/pois";
import { type LatLng } from "../lib/geo";
import type { Route } from "../lib/routing";

interface Props {
  user: LatLng | null;
  heading: number | null;
  route: Route | null;
  altRoutes: LatLng[][];
  selectedPoiId: string | null;
  follow: boolean;
  onSelectPoi: (p: Poi) => void;
  onUserPan: () => void;
  /** Fired once the map is fully rendered (style + first tiles) and interactive. */
  onLoaded?: () => void;
}

interface LayerState {
  base: boolean;
  places: boolean;
  routes: boolean;
}

const POI_COLOR: Record<string, string> = {
  gate: "#A6442E",
  lodge: "#C8932F",
  orphanage: "#9b59b6",
  airstrip: "#5a6b8c",
  viewpoint: "#3d7a5a",
  waterhole: "#4f8aa0",
  picnic: "#7a6a3d",
};

const POI_GLYPH: Record<string, string> = {
  gate: "⛩",
  lodge: "★",
  orphanage: "♥",
  airstrip: "✈",
  viewpoint: "◬",
  waterhole: "≈",
  picnic: "⛺",
};

// The georeferenced "true-north" poster (Callan's straightened illustration with the
// compass corrected) is shipped as a raster-tile pyramid and displayed AXIS-ALIGNED —
// always perfectly square, exactly like the artwork — by pinning the tiles to a
// synthetic north-aligned display box. The map view is never rotated, so it can never
// tilt. GPS overlays stay on-feature by being projected onto the poster's pixel grid
// (via its inverse georeference) and then into this same box (see `toDisplay`).
const [W_PX, H_PX] = baseMeta.px as [number, number];
const ANCHOR_LNG = 36.85; // top-left of the display box (synthetic; only the shape matters)
const ANCHOR_LAT = -0.09;
// True ground metres per poster pixel along the x axis, derived from the inverse
// of `merc2px` (Solio sits on the equator, so mercator metres ≈ ground metres).
// The scale bar measures horizontally, so pinning the box width to this makes the
// scale bar accurate; the same per-pixel step is used vertically to keep the
// poster undistorted (its y scale differs by ~7%, but nothing measures vertically).
const [MA, MB, MD, ME] = [baseMeta.merc2px[0], baseMeta.merc2px[1], baseMeta.merc2px[3], baseMeta.merc2px[4]];
const M_PER_PX_X = Math.hypot(ME, MD) / Math.abs(MA * ME - MB * MD); // ~3.61 m/px
const DEG_PER_PX = M_PER_PX_X / 110574;
const LNG_SPAN = (W_PX * DEG_PER_PX) / Math.cos((ANCHOR_LAT * Math.PI) / 180);
const LAT_SPAN = H_PX * DEG_PER_PX; // same per-pixel step both axes -> poster shown undistorted

// Project a real lng/lat onto the display box: WGS84 -> EPSG:3857 -> poster pixel
// (inverse georeference `merc2px`) -> fractional position within the box.
const R_MERC = 6378137;
const [IA, IB, IC, ID, IE, IF] = baseMeta.merc2px as number[];
function toDisplay(lng: number, lat: number): [number, number] {
  const X = (R_MERC * lng * Math.PI) / 180;
  const Y = R_MERC * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  const px = IA * X + IB * Y + IC;
  const py = ID * X + IE * Y + IF;
  return [ANCHOR_LNG + (px / W_PX) * LNG_SPAN, ANCHOR_LAT - (py / H_PX) * LAT_SPAN];
}

const WEST = ANCHOR_LNG;
const EAST = ANCHOR_LNG + LNG_SPAN;
const NORTH = ANCHOR_LAT;
const SOUTH = ANCHOR_LAT - LAT_SPAN;
const PAD_LNG = LNG_SPAN * 0.1;
const PAD_LAT = LAT_SPAN * 0.1;
const BOUNDS: LngLatBoundsLike = [WEST, SOUTH, EAST, NORTH];
const MAX_BOUNDS: LngLatBoundsLike = [
  [WEST - PAD_LNG, SOUTH - PAD_LAT],
  [EAST + PAD_LNG, NORTH + PAD_LAT],
];
// The map view is never rotated (square by construction). The poster's "up" edge is
// ~5° east of true north, so offset the live heading arrow by that to point correctly.
const MAP_BEARING = 0;
const POSTER_NORTH_OFFSET = baseMeta.bearing;

export function ReserveMap(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [ready, setReady] = useState(false);

  // Latest props for marker click handlers (avoids stale closures).
  const propsRef = useRef(props);
  propsRef.current = props;

  // Marker registries.
  const userMarker = useRef<maplibregl.Marker | null>(null);
  const poiMarkers = useRef(new Map<string, { marker: maplibregl.Marker; el: HTMLDivElement }>());

  // Photoshop-style layer visibility + base-map opacity, driven by the layers panel.
  const [layers, setLayers] = useState<LayerState>({
    base: true,
    places: SHOW_POIS,
    routes: SHOW_ROUTE,
  });
  const [baseOpacity, setBaseOpacity] = useState(1);

  // ---- Map setup ----------------------------------------------------------
  useEffect(() => {
    if (!containerRef.current) return;
    // Absolute tile URL against the page's base, so tiles resolve whether served
    // at the domain root, a GitHub Pages subpath (/repo/), or file:// (Capacitor).
    const tileBase = new URL(".", document.baseURI).href;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: {
        version: 8,
        sources: {
          // Raster-tile pyramid of the poster (see tools/basemap/make_tiles.py).
          // Only the visible tiles load, so pan/zoom is instant and deep zoom stays
          // crisp; every tile is 256px, well within any GPU's texture limit. The
          // tiles are pinned to the same synthetic display box, so overlays (toDisplay)
          // still land on their drawn features exactly as with the old image source.
          solio: {
            type: "raster",
            tiles: [`${tileBase}tiles/{z}/{x}/{y}.jpg`],
            tileSize: tilesMeta.tileSize,
            minzoom: tilesMeta.minzoom,
            maxzoom: tilesMeta.maxzoom,
            bounds: tilesMeta.bounds as [number, number, number, number],
            scheme: "xyz",
            attribution: "Illustration © Solio Game Reserve — Jen Carr-Hartley, Kim K’ Art",
          },
        },
        layers: [
          { id: "bg", type: "background", paint: { "background-color": "#f2efe6" } },
          { id: "solio", type: "raster", source: "solio", paint: { "raster-fade-duration": 0 } },
        ],
      },
      bounds: BOUNDS,
      fitBoundsOptions: { padding: 16, bearing: MAP_BEARING },
      bearing: MAP_BEARING,
      maxBounds: MAX_BOUNDS,
      minZoom: 11.5,
      maxZoom: 18,
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      renderWorldCopies: false,
    });
    mapRef.current = map;
    map.touchZoomRotate.disableRotation();
    map.keyboard.disable();
    map.addControl(new maplibregl.ScaleControl({ maxWidth: 90, unit: "metric" }), "bottom-left");

    // Start the artist/illustration credit collapsed behind the ⓘ. MapLibre's
    // compact attribution adds `maplibregl-compact-show` when the credit first
    // populates (after the source loads), so collapse it once things settle;
    // it won't be re-added, and the ⓘ still expands it on tap.
    const collapseAttribution = () => {
      map.getContainer()
        .querySelector(".maplibregl-ctrl-attrib")
        ?.classList.remove("maplibregl-compact-show");
    };
    map.on("load", collapseAttribution);
    map.once("idle", collapseAttribution);

    // A user-initiated pan drops "follow" mode.
    map.on("dragstart", () => propsRef.current.onUserPan());

    map.on("load", () => {
      // Authoritative GIS reserve outline, drawn UNDER everything else.
      if (SHOW_BOUNDARY) {
        map.addSource("boundary", { type: "geojson", data: boundaryFC() });
        map.addLayer({
          id: "boundary-line",
          type: "line",
          source: "boundary",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#7a3b2e", "line-opacity": 0.7, "line-width": 2, "line-dasharray": [3, 2] },
        });
      }

      // Alternative routes, drawn dimmed + dashed UNDER the active route.
      map.addSource("alt-routes", { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: "alt-line",
        type: "line",
        source: "alt-routes",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#5a6b8c", "line-width": 3.5, "line-opacity": 0.55, "line-dasharray": [1.5, 1.6] },
      });

      // Active route line (casing + surface).
      map.addSource("route", { type: "geojson", data: emptyFC() });
      map.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        // Bright halo so the route reads over green forest/plains, not just tan tracks.
        paint: { "line-color": "#ffffff", "line-opacity": 0.95, "line-width": 11 },
      });
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: { "line-cap": "round", "line-join": "round" },
        // Warm high-contrast core — distinct from the blue "you are here" dot and
        // the cool grey-blue alternatives.
        paint: { "line-color": "#f2600c", "line-width": 6 },
      });

      // Road network (off unless real vectors arrive; the illustration draws its own).
      if (SHOW_ROADS) {
        map.addSource("roads", { type: "geojson", data: roadsFC() });
        map.addLayer({
          id: "roads-line",
          type: "line",
          source: "roads",
          layout: { "line-cap": "round", "line-join": "round" },
          paint: { "line-color": "#6b4f32", "line-opacity": 0.55, "line-width": 2.5 },
        });
      }

      setReady(true);
      // Signal "fully ready" only once the first frame + tiles have rendered, so
      // the app reveals an already-interactive map (no dead first second).
      map.once("idle", () => propsRef.current.onLoaded?.());
    });

    return () => {
      map.remove();
      mapRef.current = null;
      userMarker.current = null;
      poiMarkers.current.clear();
    };
  }, []);

  // ---- POIs (static set) --------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !SHOW_POIS) return;
    for (const p of POIS) {
      if (poiMarkers.current.has(p.id)) continue;
      const el = document.createElement("div");
      el.className = "mk-poi";
      el.setAttribute("role", "button");
      el.setAttribute("aria-label", p.name);
      el.innerHTML = poiPinSVG(p.kind);
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        propsRef.current.onSelectPoi(p);
      });
      const world = pixelWorld(p.pixel.x, p.pixel.y);
      const marker = new maplibregl.Marker({ element: el, anchor: "bottom" })
        .setLngLat(toDisplay(world.lng, world.lat))
        .addTo(map);
      poiMarkers.current.set(p.id, { marker, el });
    }
  }, [ready]);

  // ---- User "you are here" marker ----------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (!props.user) {
      userMarker.current?.remove();
      userMarker.current = null;
      return;
    }
    if (!userMarker.current) {
      const el = document.createElement("div");
      el.className = "mk-user";
      el.innerHTML = `<div class="mk-user-arrow"></div><div class="mk-user-dot"></div>`;
      userMarker.current = new maplibregl.Marker({ element: el, anchor: "center" })
        .setLngLat(toDisplay(props.user.lng, props.user.lat))
        .addTo(map);
    } else {
      userMarker.current.setLngLat(toDisplay(props.user.lng, props.user.lat));
    }
    const arrow = userMarker.current.getElement().querySelector<HTMLElement>(".mk-user-arrow");
    if (arrow) {
      if (props.heading == null) {
        arrow.style.display = "none";
      } else {
        arrow.style.display = "block";
        // Device heading is from true north; the poster's "up" is ~5° east of north,
        // so offset the arrow by that to point correctly on the square poster.
        arrow.style.setProperty("--hdg", `${props.heading - POSTER_NORTH_OFFSET}deg`);
      }
    }
  }, [ready, props.user, props.heading]);

  // ---- Route line ---------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const src = map.getSource("route") as GeoJSONSource | undefined;
    if (!src) return;
    const path = SHOW_ROUTE && props.route && props.route.path.length > 1 ? props.route.path : null;
    src.setData(
      path
        ? {
            type: "Feature",
            geometry: { type: "LineString", coordinates: path.map((p) => toDisplay(p.lng, p.lat)) },
            properties: {},
          }
        : emptyFC(),
    );
  }, [ready, props.route]);

  // ---- Alternative routes (dimmed, before you set off) --------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const src = map.getSource("alt-routes") as GeoJSONSource | undefined;
    if (!src) return;
    const alts = SHOW_ROUTE ? props.altRoutes.filter((p) => p.length > 1) : [];
    src.setData({
      type: "FeatureCollection",
      features: alts.map((p) => ({
        type: "Feature",
        geometry: { type: "LineString", coordinates: p.map((q) => toDisplay(q.lng, q.lat)) },
        properties: {},
      })),
    });
  }, [ready, props.altRoutes]);

  // ---- Follow mode --------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !props.follow || !props.user) return;
    map.easeTo({ center: toDisplay(props.user.lng, props.user.lat), duration: 600 });
  }, [ready, props.follow, props.user?.lat, props.user?.lng]);

  // ---- Selection styling --------------------------------------------------
  useEffect(() => {
    poiMarkers.current.forEach(({ el }, id) => el.classList.toggle("sel", id === props.selectedPoiId));
  }, [props.selectedPoiId, ready]);

  // ---- Layer visibility + base opacity (driven by the layers panel) -------
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const vis = (id: string, on: boolean) => {
      if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none");
    };
    vis("solio", layers.base);
    if (map.getLayer("solio")) map.setPaintProperty("solio", "raster-opacity", baseOpacity);
    vis("route-casing", layers.routes);
    vis("route-line", layers.routes);
    vis("alt-line", layers.routes);
    poiMarkers.current.forEach(({ el }) => (el.style.display = layers.places ? "" : "none"));
  }, [ready, layers, baseOpacity]);

  return (
    <div className="map-wrap">
      <div ref={containerRef} className="map-gl" />

      {/* Layers panel (Photoshop-style: toggle each layer, dim the base map) */}
      <LayersPanel layers={layers} setLayers={setLayers} baseOpacity={baseOpacity} setBaseOpacity={setBaseOpacity} />

      {/* Zoom controls */}
      <div className="map-controls">
        <button onClick={() => mapRef.current?.zoomIn()} aria-label="Zoom in">＋</button>
        <button onClick={() => mapRef.current?.zoomOut()} aria-label="Zoom out">－</button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Layers panel */

function LayersPanel(props: {
  layers: LayerState;
  setLayers: (updater: (l: LayerState) => LayerState) => void;
  baseOpacity: number;
  setBaseOpacity: (n: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const { layers, setLayers } = props;
  const row = (key: keyof LayerState, label: string) => (
    <label className="layer-row">
      <input
        type="checkbox"
        checked={layers[key]}
        onChange={() => setLayers((l) => ({ ...l, [key]: !l[key] }))}
      />
      <span>{label}</span>
    </label>
  );
  return (
    <div className="layers-wrap">
      <button
        className={`layers-toggle ${open ? "open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Hide layers" : "Show layers"}
      >
        {open ? "✕" : "☰ Layers"}
      </button>
      {open && (
        <div className="layers-panel">
          <div className="layers-head">Layers</div>
          {row("base", "Base map")}
          <div className="layer-sub">
            <span>Opacity</span>
            <input
              type="range"
              min={0}
              max={100}
              aria-label="Base map opacity"
              value={Math.round(props.baseOpacity * 100)}
              onChange={(e) => props.setBaseOpacity(Number(e.target.value) / 100)}
              disabled={!layers.base}
            />
          </div>
          {row("places", "Places")}
          {row("routes", "Routes")}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- helpers */

function emptyFC(): GeoJSON.FeatureCollection {
  return { type: "FeatureCollection", features: [] };
}

/** Road network as GeoJSON (used only when SHOW_ROADS). */
function roadsFC(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: ROAD_GEOMS.map((r) => ({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: r.pixels.map((px) => {
          const w = pixelWorld(px.x, px.y);
          return toDisplay(w.lng, w.lat);
        }),
      },
      properties: { name: r.name, type: r.type },
    })),
  };
}

/** Reserve boundary as GeoJSON (used only when SHOW_BOUNDARY). */
function boundaryFC(): GeoJSON.FeatureCollection {
  return {
    type: "FeatureCollection",
    features: RESERVE_BOUNDARY.map((poly) => ({
      type: "Feature",
      geometry: {
        type: "Polygon",
        coordinates: [poly.outer, ...poly.holes].map((ring) => {
          const pts = ring.map((p) => toDisplay(p.lng, p.lat));
          return [...pts, pts[0]]; // close the ring for drawing
        }),
      },
      properties: {},
    })),
  };
}

/** SVG teardrop pin for a POI, coloured + glyphed by kind. */
function poiPinSVG(kind: string): string {
  const color = POI_COLOR[kind] ?? "#A6442E";
  const glyph = POI_GLYPH[kind] ?? "◉";
  return (
    `<svg class="mk-poi-pin" viewBox="-13 -30 26 34" xmlns="http://www.w3.org/2000/svg">` +
    `<ellipse cx="0" cy="2" rx="6" ry="2.4" fill="#000" opacity="0.18"/>` +
    `<path d="M0,2 C-9,-9 -9,-22 0,-22 C9,-22 9,-9 0,2 Z" fill="${color}" stroke="#fff" stroke-width="2.2"/>` +
    `<text x="0" y="-9" font-size="12" text-anchor="middle">${glyph}</text>` +
    `</svg>`
  );
}

