import { useEffect, useMemo, useRef, useState } from "react";
import { ReserveMap } from "./components/ReserveMap";
import { BirdsTab } from "./components/BirdsTab";
import coverLogo from "./assets/solio-logo.png";
import { createGeoReference, pixelWorld, MAP_MARGIN } from "./data/reserve";
import { createRoadNetwork, NODE_PIXEL } from "./data/roadSource";
import { POIS, poiWorld, type Poi } from "./data/pois";
import { TOURS, type Tour } from "./data/tours";
import {
  SIGHTING_KINDS,
  kindOf,
  loadSightings,
  saveSightings,
  newSighting,
  seedSightings,
  type Sighting,
} from "./lib/sightings";
import {
  distanceMeters,
  destinationPoint,
  pointToPathMeters,
  projectOnPath,
  formatDistance,
  timeAgo,
  type LatLng,
} from "./lib/geo";
import { maneuverLabel, type Route } from "./lib/routing";
import { pathLength, poseAlong } from "./lib/sim";

type Tab = "explore" | "drives" | "birds" | "about";
type Source = "sim" | "gps";

const SPEED_MPS = 15; // simulated game-drive speed (~54 km/h peak on tracks)
// A looping demo patrol through network nodes (see data/roadSource.ts). Each leg
// is routed along the traced roads, so the demo dot drives the drawn tracks.
const PATROL = ["gate", "j1", "jw", "j2", "j3", "j4", "naribo", "j5", "choroa", "j2", "j1", "gate"];

export default function App() {
  const georef = useMemo(() => createGeoReference(), []);
  const network = useMemo(() => createRoadNetwork(), []);

  const patrolPath = useMemo<LatLng[]>(() => {
    // Waypoints present in the active network (GIS imports may name junctions
    // differently); route every leg on-road, falling back to the node points.
    const ids = PATROL.filter((id) => NODE_PIXEL.has(id));
    const path: LatLng[] = [];
    for (let i = 1; i < ids.length; i++) {
      const leg = network.route(ids[i - 1], ids[i]);
      const pts = leg
        ? leg.path
        : [ids[i - 1], ids[i]].map((id) => { const p = NODE_PIXEL.get(id)!; return pixelWorld(p.x, p.y); });
      path.push(...(path.length ? pts.slice(1) : pts));
    }
    return path;
  }, [network]);

  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "explore";
    const t = new URLSearchParams(window.location.search).get("tab");
    return t === "drives" || t === "birds" || t === "about" ? t : "explore";
  });
  const [source, setSource] = useState<Source>("sim");
  const [follow, setFollow] = useState(true);

  // Simulation state.
  const [simPath, setSimPath] = useState<LatLng[]>(patrolPath);
  const [simDist, setSimDist] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speedMult, setSpeedMult] = useState(1);
  const drivingNav = useRef(false);

  // Self-guided tour state.
  const [tour, setTour] = useState<Tour | null>(null);
  const [tourStop, setTourStop] = useState(0);
  const [tourAtStop, setTourAtStop] = useState(false);
  const tourDriving = useRef(false);

  // Wildlife sightings log (persisted offline in localStorage).
  const [sightings, setSightings] = useState<Sighting[]>(() => {
    const stored = loadSightings();
    if (stored.length) return stored;
    return seedSightings({
      waterholeS: poiWorld(POIS.find((p) => p.id === "choroa")!),
      waterholeE: poiWorld(POIS.find((p) => p.id === "naribo")!),
    });
  });
  const [logOpen, setLogOpen] = useState(false);
  const [logKind, setLogKind] = useState<string | null>(null); // chosen species awaiting an optional note
  const [logNote, setLogNote] = useState("");
  const [selectedSightingId, setSelectedSightingId] = useState<string | null>(null);
  const [driving, setDriving] = useState(false);
  const [activeRoute, setActiveRoute] = useState<Route | null>(null);
  // Route choices for the current destination (best first); index of the picked one.
  const [routeOptions, setRouteOptions] = useState<Route[]>([]);
  const [selectedRouteIdx, setSelectedRouteIdx] = useState(0);
  const detouring = useRef(false);   // sim is off-route (demo detour) — pause the on-rail pose
  const lastReroute = useRef(0);     // debounce live re-routing
  const [mapFull, setMapFull] = useState(false);
  const panelBodyRef = useRef<HTMLDivElement>(null);

  // Live position + heading (from sim or device GPS).
  const [user, setUser] = useState<LatLng | null>(() => poseAlong(patrolPath, 0).pos);
  const [heading, setHeading] = useState<number | null>(() => poseAlong(patrolPath, 0).heading);
  const [gpsError, setGpsError] = useState<string | null>(null);
  const userRef = useRef(user);
  userRef.current = user;

  const [selectedPoiId, setSelectedPoiId] = useState<string | null>(null);
  const [openPoiId, setOpenPoiId] = useState<string | null>(
    () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("poi")),
  );
  const [destPoiId, setDestPoiId] = useState<string | null>(
    () => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("nav")),
  );

  const [showWelcome, setShowWelcome] = useState(
    () => typeof window === "undefined" || !new URLSearchParams(window.location.search).has("skipWelcome"),
  );
  const [toast, setToast] = useState<string | null>(null);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  // Connectivity indicator — reinforces the "works offline" story.
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  // Auto-dismiss the arrival toast.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  // Persist the sightings log so it survives offline / across sessions.
  useEffect(() => { saveSightings(sightings); }, [sightings]);

  // Reset the panel scroll to the top whenever the tab changes.
  useEffect(() => { panelBodyRef.current?.scrollTo({ top: 0 }); }, [tab]);

  // ---- Simulation loop -----------------------------------------------------
  // The interval updater is PURE: it only computes the next distance (clamped at
  // the end of a driven route, looped on patrol). Arrival side-effects live in
  // the effect below, so StrictMode's double-invoked updaters can't desync state.
  useEffect(() => {
    if (source !== "sim" || !playing) return;
    const tick = 200; // 5 Hz — smooth enough for the demo, far lighter on the main thread
    const handle = setInterval(() => {
      setSimDist((d) => {
        const next = d + (SPEED_MPS * speedMult * tick) / 1000;
        const len = pathLength(simPath);
        if (next < len) return next;
        return drivingNav.current ? len : next - len; // park at the end / loop the patrol
      });
    }, tick);
    return () => clearInterval(handle);
  }, [source, playing, speedMult, simPath]);

  // Arrival handling — fires once when the destination is reached. In sim that's
  // the end of the driven path; on real GPS it's coming within ARRIVE_M of the POI.
  const ARRIVE_M = 45; // POIs can sit just off the road, so allow a small radius
  useEffect(() => {
    if (!drivingNav.current || !activeRoute || detouring.current) return;
    const dest = POIS.find((p) => p.id === destPoiId);
    const arrived =
      source === "sim"
        ? simPath.length >= 2 && simDist >= pathLength(simPath)
        : !!(user && dest && distanceMeters(user, poiWorld(dest)) < ARRIVE_M);
    if (!arrived) return;
    drivingNav.current = false;
    setDriving(false);
    setActiveRoute(null);
    if (tourDriving.current) {
      // Arrived at a tour stop — park here and show its commentary.
      tourDriving.current = false;
      setTourAtStop(true);
      setDestPoiId(null);
      setPlaying(false);
      return;
    }
    if (dest) setToast(`Arrived at ${dest.name}`);
    setDestPoiId(null);
    setSimPath(patrolPath); // reset the demo patrol (harmless on GPS; ready if you switch back)
    setSimDist(0);
  }, [source, simDist, simPath, destPoiId, patrolPath, user, activeRoute]);

  // Apply simulated pose (unless the demo detour has deliberately taken the dot
  // off the rail so the live re-router can pick it up).
  useEffect(() => {
    if (source !== "sim" || simPath.length < 2 || detouring.current) return;
    const pose = poseAlong(simPath, simDist);
    setUser(pose.pos);
    setHeading(pose.heading);
  }, [source, simPath, simDist]);

  // Real-GPS navigation progress: how far along the active route the live device
  // position is, so the turn-by-turn banner + remaining distance track reality.
  useEffect(() => {
    if (source !== "gps" || !driving || !activeRoute || !user) return;
    setSimDist(projectOnPath(user, activeRoute.path).along);
  }, [source, driving, activeRoute, user]);

  // ---- Live re-routing -----------------------------------------------------
  // While navigating, if the live position strays too far from the active route
  // (a real driver going off-track, or the demo "Detour"), recompute from where
  // we actually are. In a normal sim drive the dot rides the route, so the
  // deviation is ~0 and this never fires.
  const REROUTE_M = 60;
  useEffect(() => {
    if (!driving || !destPoiId || !activeRoute || !user) return;
    if (pointToPathMeters(user, activeRoute.path) <= REROUTE_M) return;
    if (Date.now() - lastReroute.current < 2500) return;
    const dest = POIS.find((p) => p.id === destPoiId);
    if (!dest) return;
    const start = network.nearestNode(user);
    const r = network.route(start.id, dest.nodeId);
    lastReroute.current = Date.now();
    detouring.current = false;
    if (!r || r.path.length < 2) { setPlaying(true); return; }
    setActiveRoute(r);
    setSimPath(r.path);
    setSimDist(0);
    setPlaying(true);
    setToast("Off route — recalculating…");
  }, [user, driving, destPoiId, activeRoute, network]);

  // ---- Device GPS ----------------------------------------------------------
  useEffect(() => {
    if (source !== "gps") return;
    if (!("geolocation" in navigator)) {
      setGpsError("This device has no geolocation support.");
      return;
    }
    setGpsError(null);
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setUser({ lat: p.coords.latitude, lng: p.coords.longitude });
        if (p.coords.heading != null && !Number.isNaN(p.coords.heading)) {
          setHeading(p.coords.heading);
        }
      },
      (err) => setGpsError(err.message || "Location unavailable."),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 10000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [source]);

  const openPoi = openPoiId ? POIS.find((p) => p.id === openPoiId) ?? null : null;
  const selectedSighting = selectedSightingId
    ? sightings.find((s) => s.id === selectedSightingId) ?? null
    : null;

  const destPoi = destPoiId ? POIS.find((p) => p.id === destPoiId) ?? null : null;

  // Compute the route choices when a destination is picked (before driving).
  // Uses the position at selection time (userRef) so the options don't churn as
  // the demo dot keeps moving.
  useEffect(() => {
    if (!destPoiId || driving) { setRouteOptions([]); return; }
    const dest = POIS.find((p) => p.id === destPoiId);
    const from = userRef.current;
    if (!dest || !from) return;
    const start = network.nearestNode(from);
    const opts = network.alternatives(start.id, dest.nodeId, 3);
    if (!opts.length || opts[0].path.length < 2) {
      setToast(`You're already at ${dest.name}`);
      setDestPoiId(null);
      setRouteOptions([]);
      return;
    }
    setRouteOptions(opts);
    setSelectedRouteIdx(0);
  }, [destPoiId, driving, network]);

  // The picked preview route, and the non-selected alternatives (drawn dimmed).
  const routePreview: Route | null = useMemo(
    () => routeOptions[selectedRouteIdx] ?? null,
    [routeOptions, selectedRouteIdx],
  );
  const altRoutePaths = useMemo<LatLng[][]>(
    () => (driving ? [] : routeOptions.filter((_, i) => i !== selectedRouteIdx).map((r) => r.path)),
    [driving, routeOptions, selectedRouteIdx],
  );

  // The route drawn on the map: the live one being driven, else the preview.
  const displayRoute = driving ? activeRoute : routePreview;

  // Live turn-by-turn driven by progress (simDist) along the active route.
  const banner = useMemo(() => {
    if (!destPoi) return null;
    if (driving && activeRoute && activeRoute.steps.length > 0) {
      // Distance along the route at which each step's maneuver occurs.
      let acc = 0;
      const offsets = activeRoute.steps.map((s) => { const o = acc; acc += s.distanceM; return o; });
      let idx = activeRoute.steps.findIndex((_, k) => offsets[k] > simDist + 10);
      if (idx === -1) idx = activeRoute.steps.length - 1; // arrival
      const step = activeRoute.steps[idx];
      const line = step.maneuver === "arrive"
        ? `Arrive at ${destPoi.name}`
        : `${maneuverLabel[step.maneuver]} ${step.road}`.trim();
      return {
        mode: "driving" as const,
        icon: maneuverIcon(step.maneuver),
        line,
        distToNext: Math.max(0, offsets[idx] - simDist),
        remaining: Math.max(0, activeRoute.totalM - simDist),
      };
    }
    if (routePreview) {
      const first = routePreview.steps.find((s, i) => i > 0 && s.maneuver !== "depart") ?? routePreview.steps[0];
      let remaining = routePreview.totalM;
      if (user) {
        if (routePreview.path.length === 0) remaining = distanceMeters(user, poiWorld(destPoi));
        else remaining += distanceMeters(user, routePreview.path[0])
          + distanceMeters(routePreview.path[routePreview.path.length - 1], poiWorld(destPoi));
      }
      return {
        mode: "preview" as const,
        icon: maneuverIcon(first?.maneuver),
        line: first ? `${maneuverLabel[first.maneuver]} ${first.road}`.trim() : "Start drive",
        distToNext: null as number | null,
        remaining,
      };
    }
    return null;
  }, [destPoi, driving, activeRoute, simDist, routePreview, user]);

  // When using real GPS away from Solio, the user falls outside the map.
  const userOutside = source === "gps" && user != null && !georef.contains(user, MAP_MARGIN);

  function navigateTo(p: Poi) {
    setDestPoiId(p.id);
    setSelectedPoiId(p.id);
    setTab("explore");
    setFollow(true);
    setSelectedRouteIdx(0);
    // Preview the route(s) first; hold the demo dot still while you choose, then
    // ▶ Drive sets off. (The preview effect computes the options.)
    if (source === "sim") setPlaying(false);
  }
  function simulateDetour() {
    // Demo: shove the dot ~130 m off the road so the live re-router kicks in.
    if (!driving || source !== "sim" || !activeRoute || !user) return;
    const side = ((heading ?? 0) + 90) % 360;
    detouring.current = true;
    setPlaying(false);
    setHeading(side);
    setUser(destinationPoint(user, 130, side));
  }
  function driveRoute() {
    const r = routePreview;
    if (!r || r.path.length < 2) {
      if (destPoi) setToast(`You're already at ${destPoi.name}`);
      setDestPoiId(null);
      return;
    }
    drivingNav.current = true;
    setDriving(true);
    setActiveRoute(r);
    setSimPath(r.path);
    setFollow(true);
    if (source === "gps") {
      // Navigate with the real device position — progress + arrival come from GPS,
      // and the live re-router recomputes if you actually drive off the route.
      setSimDist(user ? projectOnPath(user, r.path).along : 0);
    } else {
      setSimDist(0);
      setPlaying(true);
    }
  }
  function stopNav() {
    if (tour) { endTour(); return; }
    setDestPoiId(null);
    drivingNav.current = false;
    setDriving(false);
    setActiveRoute(null);
    setSimPath(patrolPath);
  }

  // ---- Self-guided tours ---------------------------------------------------
  const currentStop = tour ? tour.stops[tourStop] ?? null : null;

  function driveToStop(t: Tour, idx: number) {
    const stop = t.stops[idx];
    const poi = stop && POIS.find((p) => p.id === stop.poiId);
    if (!poi || !user) return;
    setTourStop(idx);
    setTourAtStop(false);
    setSelectedPoiId(poi.id);
    setOpenPoiId(null);
    setFollow(true);
    const start = network.nearestNode(user);
    const r = network.route(start.id, poi.nodeId);
    if (!r || r.path.length < 2) {
      // Already at this stop — go straight to the commentary.
      setTourAtStop(true);
      return;
    }
    setDestPoiId(poi.id);
    drivingNav.current = true;
    tourDriving.current = true;
    setDriving(true);
    setActiveRoute(r);
    setSimPath(r.path);
    setSimDist(0);
    setSource("sim");
    setPlaying(true);
  }
  function startTour(t: Tour) {
    if (!user) { setToast("Waiting for your location…"); return; }
    setTour(t);
    setTab("drives");
    driveToStop(t, 0);
  }
  function nextTourStop() {
    if (!tour) return;
    const next = tourStop + 1;
    if (next < tour.stops.length) {
      driveToStop(tour, next);
    } else {
      const name = tour.name;
      endTour();
      setToast(`Tour complete · ${name}`);
    }
  }
  function endTour() {
    setTour(null);
    setTourAtStop(false);
    tourDriving.current = false;
    drivingNav.current = false;
    setDriving(false);
    setActiveRoute(null);
    setDestPoiId(null);
    setSimPath(patrolPath);
    setSimDist(0);
    setPlaying(true);
  }

  // ---- Sightings log -------------------------------------------------------
  function openLog() { setLogKind(null); setLogNote(""); setLogOpen(true); }
  function closeLog() { setLogOpen(false); setLogKind(null); setLogNote(""); }
  function saveSighting() {
    if (!logKind) return;
    if (!user) { setToast("Waiting for your location…"); return; }
    setSightings((s) => [newSighting(logKind, user, logNote), ...s]);
    const label = kindOf(logKind).label;
    closeLog();
    setToast(`Logged ${label} sighting`);
  }
  function removeSighting(id: string) {
    setSightings((s) => s.filter((x) => x.id !== id));
  }
  function shareSighting(id: string) {
    // PoC: marks the sighting locally; a backend would transmit it to rangers.
    setSightings((s) => s.map((x) => (x.id === id ? { ...x, sharedAt: Date.now() } : x)));
    const sighting = sightings.find((x) => x.id === id);
    setToast(`Marked for rangers (demo)${sighting ? ` · ${kindOf(sighting.kindId).label}` : ""}`);
  }

  return (
    <div className="stage">
      <aside className="pitch">
        <img className="pitch-logo" src={coverLogo} alt="Solio Game Reserve" />
        <div className="pitch-eyebrow">Solio Game Reserve · Companion concept</div>
        <h1 className="pitch-title">Find your way<br />through the wild.</h1>
        <p className="pitch-lead">
          A companion app for Solio Game Reserve — guests see themselves on the
          reserve's own map, navigate the tracks, and log what they spot along
          the way. Built to put conservation in every visitor's pocket.
        </p>
        <ul className="pitch-points">
          <li><span>◎</span><div><b>You-are-here</b><br />on Solio's own map, even offline.</div></li>
          <li><span>↱</span><div><b>Guided navigation</b><br />turn-by-turn along the reserve roads.</div></li>
          <li><span>🧭</span><div><b>Self-guided drives</b><br />curated tours with commentary.</div></li>
        </ul>
        <div className="pitch-foot">Proof of concept · illustrative map &amp; data</div>
      </aside>

      <div className="device">
        <div className="app">
          {showWelcome && <Welcome onStart={() => setShowWelcome(false)} />}

          <header className="topbar">
            <div className="brand">
              <img className="brand-mark" src={coverLogo} alt="Solio Game Reserve" />
              <div>
                <div className="brand-name">SOLIO</div>
                <div className="brand-sub">Game Reserve · Companion</div>
              </div>
            </div>
            <div className="topbar-actions">
              <span className={`status-chip ${online ? "" : "off"}`}>
                <i className="status-dot" />
                {online ? "Online" : "Offline-ready"}
              </span>
            </div>
          </header>

          <main className={`layout${mapFull ? " map-full" : ""}`}>
            <section className="map-pane">
          <ReserveMap
            user={user}
            heading={heading}
            route={displayRoute}
            altRoutes={altRoutePaths}
            sightings={sightings}
            selectedPoiId={selectedPoiId}
            selectedSightingId={selectedSightingId}
            follow={follow}
            onSelectPoi={(p) => { setSelectedPoiId(p.id); setOpenPoiId(p.id); setSelectedSightingId(null); }}
            onSelectSighting={(id) => { setSelectedSightingId(id); setOpenPoiId(null); }}
            onUserPan={() => setFollow(false)}
          />

          {/* Live navigation banner */}
          {destPoi && banner && (
            <div className="nav-banner">
              <div className="nav-step">
                <div className="nav-maneuver">{banner.icon}</div>
                <div>
                  <div className="nav-instruction">
                    {banner.distToNext != null && banner.distToNext > 60 && (
                      <span className="nav-in">In {formatDistance(banner.distToNext)} · </span>
                    )}
                    {banner.line}
                  </div>
                  <div className="nav-meta">
                    To {destPoi.name} · {formatDistance(banner.remaining)} · ~{etaMinutes(banner.remaining)} min
                  </div>
                </div>
              </div>
              {/* Route choices (before setting off) */}
              {!driving && routeOptions.length > 1 && (
                <div className="nav-routes">
                  {routeOptions.map((r, i) => (
                    <button
                      key={i}
                      className={`route-chip${i === selectedRouteIdx ? " sel" : ""}`}
                      onClick={() => setSelectedRouteIdx(i)}
                    >
                      <b>{i === 0 ? "Fastest" : `Alt ${i}`}</b>
                      <span>{formatDistance(r.totalM)} · ~{etaMinutes(r.totalM)} min</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="nav-actions">
                {!driving ? (
                  <button className="btn btn-accent" onClick={driveRoute}>▶ Drive</button>
                ) : source === "sim" ? (
                  <>
                    <button className="btn" onClick={() => setPlaying((p) => !p)}>{playing ? "❚❚" : "▶"}</button>
                    <button className="btn btn-ghost" onClick={simulateDetour} title="Demo: leave the road to see live re-routing">
                      🔀 Detour
                    </button>
                  </>
                ) : (
                  <button className="btn" onClick={() => setFollow(true)}>◎ Recenter</button>
                )}
                <button className="btn btn-ghost" onClick={stopNav}>End</button>
              </div>
            </div>
          )}

          {/* Outside-reserve notice (real GPS away from Solio) */}
          {userOutside && (
            <div className="outside-note">
              <b>📍 You're outside Solio</b>
              <span>Switch to “Demo drive” to explore the reserve.</span>
              <button className="btn btn-accent sm" onClick={() => setSource("sim")}>Demo drive</button>
            </div>
          )}

          {/* Floating map buttons */}
          <div className="map-floating">
            <button className="fab fab-light" onClick={() => setMapFull((f) => !f)} title={mapFull ? "Exit full map" : "Full-screen map"} aria-label="Toggle full-screen map">
              {mapFull ? (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
                </svg>
              )}
            </button>
            {!follow && (
              <button className="fab" onClick={() => setFollow(true)} title="Recentre on me" aria-label="Recentre on me">
                <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <circle cx="12" cy="12" r="3.4" fill="currentColor" stroke="none" />
                  <circle cx="12" cy="12" r="7.5" />
                  <line x1="12" y1="1.5" x2="12" y2="4.5" />
                  <line x1="12" y1="19.5" x2="12" y2="22.5" />
                  <line x1="1.5" y1="12" x2="4.5" y2="12" />
                  <line x1="19.5" y1="12" x2="22.5" y2="12" />
                </svg>
              </button>
            )}
            <button className="fab fab-log" onClick={() => (logOpen ? closeLog() : openLog())} title="Log a sighting" aria-label="Log a sighting">
              <Binoculars />
            </button>
          </div>

          {/* Sighting logger — pick a species, then an optional note */}
          {logOpen && (
            <div className="log-sheet">
              {!logKind ? (
                <>
                  <div className="log-sheet-head">
                    <b>Log a sighting</b>
                    <button className="pop-close dark" onClick={closeLog} aria-label="Close">×</button>
                  </div>
                  <div className="log-sheet-sub">Pinned at your current location.</div>
                  <div className="log-grid">
                    {SIGHTING_KINDS.map((k) => (
                      <button key={k.id} className="log-chip" onClick={() => setLogKind(k.id)}>
                        <span>{k.icon}</span>{k.label}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <div className="log-sheet-head">
                    <b>{kindOf(logKind).icon} {kindOf(logKind).label}</b>
                    <button className="pop-close dark" onClick={closeLog} aria-label="Close">×</button>
                  </div>
                  <div className="log-sheet-sub">Add a note (optional) — how many, behaviour, anything notable.</div>
                  <textarea
                    className="log-note"
                    value={logNote}
                    onChange={(e) => setLogNote(e.target.value)}
                    placeholder="e.g. Bull with two cows, browsing acacia"
                    rows={2}
                    maxLength={140}
                    autoFocus
                  />
                  <div className="log-note-actions">
                    <button className="btn sm" onClick={() => { setLogKind(null); setLogNote(""); }}>← Back</button>
                    <button className="btn btn-accent sm" onClick={saveSighting}>Save sighting</button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Tour commentary at each stop */}
          {tour && tourAtStop && currentStop && (
            <div className="tour-card">
              <button className="pop-close" onClick={endTour} aria-label="End tour">×</button>
              <div className="tour-card-kicker">{tour.name} · Stop {tourStop + 1} of {tour.stops.length}</div>
              <div className="tour-card-title">🧭 {currentStop.title}</div>
              <div className="tour-card-note">{currentStop.commentary}</div>
              <div className="tour-card-actions">
                <button className="btn btn-ghost sm" onClick={endTour}>End tour</button>
                <button className="btn btn-accent sm" onClick={nextTourStop}>
                  {tourStop + 1 < tour.stops.length ? "Next stop →" : "Finish ✓"}
                </button>
              </div>
            </div>
          )}

          {/* Place info popup */}
          {openPoi && (
            <div className="poi-pop">
              <button className="pop-close dark" onClick={() => setOpenPoiId(null)} aria-label="Close">×</button>
              <div className="poi-pop-title">{openPoi.name}</div>
              <div className="poi-pop-note">{openPoi.blurb}</div>
              <div className="poi-pop-actions">
                {user && <span className="poi-pop-dist">{formatDistance(distanceMeters(user, poiWorld(openPoi)))} away</span>}
                <button
                  className="btn btn-accent sm"
                  onClick={() => { const p = openPoi; setOpenPoiId(null); navigateTo(p); }}
                >
                  Navigate here
                </button>
              </div>
            </div>
          )}

          {/* Sighting info popup */}
          {selectedSighting && (
            <div className="poi-pop sighting-pop">
              <button className="pop-close dark" onClick={() => setSelectedSightingId(null)} aria-label="Close">×</button>
              <div className="poi-pop-title">
                <span className="sighting-pop-ico">{kindOf(selectedSighting.kindId).icon}</span>
                {kindOf(selectedSighting.kindId).label}
              </div>
              {selectedSighting.note
                ? <div className="poi-pop-note sighting-note">“{selectedSighting.note}”</div>
                : <div className="poi-pop-note">No note added.</div>}
              <div className="poi-pop-dist sighting-pop-meta">
                {timeAgo(selectedSighting.at)}
                {user ? ` · ${formatDistance(distanceMeters(user, { lat: selectedSighting.lat, lng: selectedSighting.lng }))} away` : ""}
              </div>
              {selectedSighting.sharedAt && (
                <div className="shared-badge">🛡 Marked for rangers (demo) · {timeAgo(selectedSighting.sharedAt)}</div>
              )}
              <div className="sighting-pop-btns">
                {!selectedSighting.sharedAt && (
                  <button className="btn btn-accent sm" onClick={() => shareSighting(selectedSighting.id)}>
                    🛡 Share with rangers
                  </button>
                )}
                <button
                  className="btn sm"
                  onClick={() => { removeSighting(selectedSighting.id); setSelectedSightingId(null); }}
                >
                  Remove
                </button>
              </div>
              {!selectedSighting.sharedAt && (
                <div className="sighting-pop-hint">Proof of concept: marks this sighting for ranger handover on this device only — nothing is transmitted yet.</div>
              )}
            </div>
          )}
        </section>

        <aside className="panel">
          <nav className="tabs">
            <button className={tab === "explore" ? "active" : ""} onClick={() => setTab("explore")}>Explore</button>
            <button className={tab === "drives" ? "active" : ""} onClick={() => setTab("drives")}>Drives</button>
            <button className={tab === "birds" ? "active" : ""} onClick={() => setTab("birds")}>Birds</button>
            <button className={tab === "about" ? "active" : ""} onClick={() => setTab("about")}>About</button>
          </nav>

          {/* Location source + status (only where the live map matters) */}
          {(tab === "explore" || tab === "drives") && (
            <div className="status-row">
              <div className="seg">
                <button className={source === "sim" ? "on" : ""} onClick={() => setSource("sim")}>Demo drive</button>
                <button className={source === "gps" ? "on" : ""} onClick={() => setSource("gps")}>Use my GPS</button>
              </div>
              {source === "sim" && (
                <div className="seg small">
                  <button className={playing ? "on" : ""} onClick={() => setPlaying((p) => !p)}>{playing ? "Pause" : "Play"}</button>
                  <button className={speedMult === 3 ? "on" : ""} onClick={() => setSpeedMult((m) => (m === 1 ? 3 : 1))}>{speedMult}×</button>
                </div>
              )}
            </div>
          )}
          {gpsError && <div className="warn">⚠ {gpsError}</div>}

          <div className="panel-body" ref={panelBodyRef}>
            {tab === "explore" && (
              <ExploreTab
                pois={POIS}
                user={user}
                selectedPoiId={selectedPoiId}
                sightings={sightings}
                onSelect={(p) => { setSelectedPoiId(p.id); setOpenPoiId(p.id); }}
                onNavigate={navigateTo}
                onLog={openLog}
                onRemoveSighting={removeSighting}
              />
            )}
            {tab === "drives" && (
              <DrivesTab
                tours={TOURS}
                activeTourId={tour?.id ?? null}
                tourStop={tourStop}
                onStart={startTour}
                onEnd={endTour}
              />
            )}
            {tab === "birds" && <BirdsTab />}
            {tab === "about" && <AboutTab cpCount={4} />}
          </div>
        </aside>
          </main>

          {toast && <div className="toast" role="status" aria-live="polite">✓ {toast}</div>}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Welcome */

function Welcome(props: { onStart: () => void }) {
  return (
    <div className="welcome">
      <div className="welcome-card">
        <img className="brand-mark big" src={coverLogo} alt="Solio Game Reserve" />
        <div className="welcome-kicker">Karibu · Welcome to</div>
        <div className="welcome-brand">SOLIO</div>
        <div className="welcome-tag">The Heart of Conservation in Kenya</div>
        <p className="welcome-lead">
          Your companion for the reserve. See where you are on our map, find your
          way along the tracks, and discover the wildlife around you.
        </p>
        <div className="welcome-stats">
          <div><b>1970</b><span>First private rhino sanctuary</span></div>
          <div><b>200+</b><span>Rhinos protected</span></div>
          <div><b>45k</b><span>Acres of wilderness</span></div>
        </div>
        <button className="btn btn-accent block" onClick={props.onStart}>Enter the reserve →</button>
        <div className="welcome-foot">Proof of concept · illustrative data</div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Explore */

function ExploreTab(props: {
  pois: Poi[];
  user: LatLng | null;
  selectedPoiId: string | null;
  sightings: Sighting[];
  onSelect: (p: Poi) => void;
  onNavigate: (p: Poi) => void;
  onLog: () => void;
  onRemoveSighting: (id: string) => void;
}) {
  const list = useMemo(() => {
    const withDist = props.pois.map((p) => ({
      poi: p,
      dist: props.user ? distanceMeters(props.user, poiWorld(p)) : 0,
    }));
    return props.user ? withDist.sort((a, b) => a.dist - b.dist) : withDist;
  }, [props.pois, props.user]);

  const recent = useMemo(
    () => [...props.sightings].sort((a, b) => b.at - a.at),
    [props.sightings],
  );

  return (
    <div className="list">
      {/* Wildlife sightings log */}
      <div className="section-head">
        <span>Your sightings</span>
        <button className="btn btn-accent sm" onClick={props.onLog}>＋ Log a sighting</button>
      </div>
      {recent.length === 0 ? (
        <p className="hint">No sightings yet. Spot something? Tap “Log a sighting” to pin it on the map.</p>
      ) : (
        recent.slice(0, 6).map((s) => {
          const k = kindOf(s.kindId);
          const dist = props.user ? distanceMeters(props.user, { lat: s.lat, lng: s.lng }) : null;
          return (
            <div key={s.id} className="card sighting-card">
              <div className="sighting-ico">{k.icon}</div>
              <div className="card-main">
                <div className="card-title">
                  {k.label}
                  {s.sharedAt && <span className="tag shared-tag">🛡 Marked</span>}
                </div>
                {s.note && <div className="card-sub sighting-note">“{s.note}”</div>}
                <div className="card-sub mono">
                  {timeAgo(s.at)}{dist != null ? ` · ${formatDistance(dist)} away` : ""}
                </div>
              </div>
              <button className="btn sm" onClick={() => props.onRemoveSighting(s.id)} aria-label="Remove sighting">✕</button>
            </div>
          );
        })
      )}

      <div className="section-head">
        <span>Places</span>
      </div>
      <p className="hint">Tap a place to see it, or navigate there along the reserve tracks.</p>
      {list.map(({ poi, dist }) => (
        <div
          key={poi.id}
          className={`card ${props.selectedPoiId === poi.id ? "sel" : ""}`}
          role="button"
          tabIndex={0}
          aria-label={`${poi.name} — show on map`}
          onClick={() => props.onSelect(poi)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              props.onSelect(poi);
            }
          }}
        >
          <div className="card-main">
            <div className="card-title">{poi.name}</div>
            <div className="card-sub">{poi.blurb}</div>
          </div>
          <div className="card-side">
            {props.user && <div className="dist">{formatDistance(dist)}</div>}
            <button
              className="btn btn-accent sm"
              onClick={(e) => { e.stopPropagation(); props.onNavigate(poi); }}
            >
              Navigate
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ Drives */

function DrivesTab(props: {
  tours: Tour[];
  activeTourId: string | null;
  tourStop: number;
  onStart: (t: Tour) => void;
  onEnd: () => void;
}) {
  return (
    <div className="list">
      <p className="hint">
        Curated self-guided game drives along the reserve tracks. Start one and
        the app guides you stop to stop, with commentary on what to look for.
      </p>
      {props.tours.map((t) => {
        const active = props.activeTourId === t.id;
        return (
          <div key={t.id} className={`card tour-card-row ${active ? "sel" : ""}`}>
            <div className="tour-row-head">
              <div className="card-title">{t.name}</div>
              <span className={`tag diff-${t.difficulty === "4x4" ? "rough" : t.difficulty.toLowerCase()}`}>{t.difficulty}</span>
            </div>
            <div className="card-sub">{t.summary}</div>
            <div className="card-sub mono">~{t.durationMin} min · {t.stops.length} stops · {t.bestTime}</div>
            <ol className="tour-stops">
              {t.stops.map((s, i) => (
                <li key={i} className={active && i < props.tourStop ? "done" : active && i === props.tourStop ? "current" : ""}>
                  {s.title}
                </li>
              ))}
            </ol>
            {active ? (
              <button className="btn btn-ghost-dark sm block" onClick={props.onEnd}>End tour</button>
            ) : (
              <button className="btn btn-accent sm block" onClick={() => props.onStart(t)}>▶ Start drive</button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ About */

function AboutTab(props: { cpCount: number }) {
  return (
    <div className="about">
      <h3>How this works</h3>
      <p>
        Your position is drawn onto Solio's own <b>georeferenced</b> reserve map:
        its {props.cpCount} corner control points tie the picture to real-world GPS
        coordinates. Checked against satellite imagery, the map shows <b>no
        systematic offset</b> — it sits true to the ground, with the small local
        variation expected of a hand-drawn map.
      </p>
      <p>
        Points of interest are digitised from the georeferenced artwork and
        verified to sit on their drawn features. The road network behind
        navigation is traced from the drawn roads through the same
        georeference, so drives follow the real tracks — the reserve's own GIS
        road vectors will supersede it seamlessly when they arrive.
      </p>
      <h3>Capabilities</h3>
      <ul>
        <li><b>You-are-here</b> on Solio's real map, online or offline.</li>
        <li><b>Navigation &amp; points of interest</b> — turn-by-turn along the reserve's drawn roads.</li>
        <li><b>Self-guided drives</b> — curated tours with commentary along the tracks.</li>
      </ul>
      <h3 className="danger">Rhino safety by design</h3>
      <p>
        Live rhino locations are exactly what poachers want, so this app carries
        <b> no rhino tracking</b> — by design. Any operational tracking stays on
        ranger systems behind authentication, never on guest devices.
      </p>
    </div>
  );
}

/* ---------------------------------------------------------------- helpers */

/** Binoculars glyph for the "log a sighting" button. */
function Binoculars() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="6.5" cy="15" r="3.7" />
      <circle cx="17.5" cy="15" r="3.7" />
      <path d="M5 11.6 L6 6.4 a1.6 1.6 0 0 1 3 0 L9.6 12.2" />
      <path d="M19 11.6 L18 6.4 a1.6 1.6 0 0 0 -3 0 L14.4 12.2" />
      <path d="M9.6 13.4 q2.4 -1.4 4.8 0" />
    </svg>
  );
}

function etaMinutes(meters: number): number {
  return Math.max(1, Math.round(meters / SPEED_MPS / 60));
}

function maneuverIcon(m?: string): string {
  switch (m) {
    case "left": return "↰";
    case "slight-left": return "↖";
    case "right": return "↱";
    case "slight-right": return "↗";
    case "arrive": return "◎";
    default: return "↑";
  }
}
