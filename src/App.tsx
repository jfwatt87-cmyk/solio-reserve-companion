import { useEffect, useMemo, useRef, useState } from "react";
import { ReserveMap } from "./components/ReserveMap";
import coverLogo from "./assets/solio-logo.png";
import { createGeoReference, pixelWorld, MAP_MARGIN } from "./data/reserve";
import { createRoadNetwork, NODE_PIXEL } from "./data/roadSource";
import { POIS, poiWorld, type Poi } from "./data/pois";
import { TOURS, type Tour } from "./data/tours";
import {
  distanceMeters,
  destinationPoint,
  pointToPathMeters,
  projectOnPath,
  formatDistance,
  type LatLng,
} from "./lib/geo";
import { maneuverLabel, type Route } from "./lib/routing";
import { pathLength, poseAlong } from "./lib/sim";
import { precacheTiles, tilesAlreadyCached } from "./lib/precache";
import { detectInApp, type InAppInfo } from "./lib/inapp";

type Tab = "explore" | "drives" | "about";
type Source = "sim" | "gps";
// A guest-friendly rendering of a GeolocationPositionError: a short headline plus
// (for permission-denied) the exact per-OS steps to switch location back on.
type GpsError = { title: string; detail: string; steps?: string[] };

// The Chromium install prompt event (not in the TS DOM lib) + iOS Safari's
// non-standard navigator.standalone, both used by the Add-to-Home-Screen hint.
type BeforeInstallPromptEvent = Event & { prompt: () => Promise<void> };
type NavigatorStandalone = Navigator & { standalone?: boolean };

const SPEED_MPS = 15; // simulated game-drive speed (~54 km/h peak on tracks)
const ETA_MPS = 7;    // display-only ETA speed (~25 km/h — realistic on game-drive tracks)
const GOOD_FIX_M = 50; // accuracy threshold: below this we treat the GPS fix as precise
// A looping demo patrol through network nodes (see data/roadSource.ts). Each leg
// is routed along the traced roads, so the demo dot drives the drawn tracks.
const PATROL = ["gate", "j1", "jw", "j2", "j3", "j4", "naribo", "j5", "choroa", "j2", "j1", "gate"];

// Guest mode (the QR / plain URL) is the default: real GPS, no simulator. Demo
// mode (?demo) keeps the patrol dot + speed/detour controls for pitching and for
// anyone exploring from home. Everything else (?tab, ?poi, ?nav, ?skipWelcome) is
// unchanged. Read once at module load so it's stable for the whole session.
const IS_DEMO =
  typeof window !== "undefined" && new URLSearchParams(window.location.search).has("demo");

// Platform sniff for the per-OS "re-enable location" instructions (display only).
const UA = typeof navigator === "undefined" ? "" : navigator.userAgent;
const IS_IOS = /iPad|iPhone|iPod/.test(UA) || (/Macintosh/.test(UA) && typeof document !== "undefined" && "ontouchend" in document);

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
    return t === "drives" || t === "about" ? t : "explore";
  });
  const [source, setSource] = useState<Source>(IS_DEMO ? "sim" : "gps");
  // Start with the camera NOT chasing the demo dot, so the map is immediately
  // draggable on open. Following turns on when you drive (or tap ◎ Recentre).
  const [follow, setFollow] = useState(false);

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

  const [driving, setDriving] = useState(false);
  const [activeRoute, setActiveRoute] = useState<Route | null>(null);
  // Route choices for the current destination (best first); index of the picked one.
  const [routeOptions, setRouteOptions] = useState<Route[]>([]);
  const [selectedRouteIdx, setSelectedRouteIdx] = useState(0);
  const detouring = useRef(false);   // sim is off-route (demo detour) — pause the on-rail pose
  const lastReroute = useRef(0);     // debounce live re-routing
  const [mapFull, setMapFull] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false); // gate the splash until the map is interactive
  const panelBodyRef = useRef<HTMLDivElement>(null);

  // Live position + heading. Demo starts on the patrol dot; a guest starts with
  // no position (null) until their first real GPS fix lands.
  const [user, setUser] = useState<LatLng | null>(() => (IS_DEMO ? poseAlong(patrolPath, 0).pos : null));
  const [heading, setHeading] = useState<number | null>(() => (IS_DEMO ? poseAlong(patrolPath, 0).heading : null));
  // GPS state for the guest onboarding UX: a friendly error (denied/unavailable/
  // timeout) and the latest fix accuracy in metres (null until the first fix).
  const [gpsError, setGpsError] = useState<GpsError | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
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
  // In-app browser guard (§3.11): detect once; the guest can dismiss and browse
  // online, but offline caching won't survive an in-app webview, so we warn.
  const inAppInfo = useMemo<InAppInfo>(() => detectInApp(), []);
  const [guardDismissed, setGuardDismissed] = useState(false);
  const showGuard = inAppInfo.degraded && !guardDismissed;

  // Add-to-Home-Screen hint (§3.4): installed PWAs get durable storage + one-tap
  // launch. Android/Chrome fires beforeinstallprompt (native button); iOS needs a
  // manual Share → Add to Home Screen, so we show instructions. Never in an
  // already-installed (standalone) window, an in-app webview, or once dismissed.
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [a2hsDismissed, setA2hsDismissed] = useState(() => {
    try { return localStorage.getItem("solio-a2hs-dismissed") === "1"; } catch { return false; }
  });
  useEffect(() => {
    const onBip = (e: Event) => { e.preventDefault(); setInstallEvt(e as BeforeInstallPromptEvent); };
    window.addEventListener("beforeinstallprompt", onBip);
    return () => window.removeEventListener("beforeinstallprompt", onBip);
  }, []);
  const isStandalone =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(display-mode: standalone)").matches || (navigator as NavigatorStandalone).standalone === true);
  const showA2HS =
    !a2hsDismissed && !isStandalone && !showGuard && !showWelcome && mapLoaded && !inAppInfo.inApp &&
    (inAppInfo.platform === "ios" || !!installEvt);
  function dismissA2HS() {
    setA2hsDismissed(true);
    try { localStorage.setItem("solio-a2hs-dismissed", "1"); } catch { /* ignore */ }
  }
  const [toast, setToast] = useState<string | null>(null);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  // Offline precache progress: "saving" while pulling the pyramid, "saved" once
  // the whole reserve is on the device. Drives the quiet status-chip messaging.
  const [precache, setPrecache] = useState<{ state: "idle" | "saving" | "saved"; pct: number }>(
    () => ({ state: tilesAlreadyCached() ? "saved" : "idle", pct: 0 }),
  );

  // Failsafe: never let the loading splash outstay its welcome if the map's
  // "idle" event is slow (or never fires on a flaky tile fetch).
  useEffect(() => {
    const t = setTimeout(() => setMapLoaded(true), 6000);
    return () => clearTimeout(t);
  }, []);

  // Connectivity indicator — reinforces the "works offline" story.
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => { window.removeEventListener("online", up); window.removeEventListener("offline", down); };
  }, []);

  // Proactive offline precache — once the map is interactive and we're online,
  // pull the whole tile pyramid into the SW cache so the reserve works in dead
  // zones, not just where the guest happened to pan. Runs once per tile version
  // (guarded by localStorage); needs a controlling service worker to be cached,
  // so it's a no-op in dev where the SW is intentionally unregistered.
  const precacheStarted = useRef(false);
  useEffect(() => {
    if (precacheStarted.current || !mapLoaded || !online) return;
    if (tilesAlreadyCached()) return;
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return;
    precacheStarted.current = true;
    const ac = new AbortController();
    setPrecache({ state: "saving", pct: 0 });
    precacheTiles(
      import.meta.env.BASE_URL,
      ({ done, total }) => setPrecache({ state: done >= total ? "saved" : "saving", pct: total ? done / total : 0 }),
      ac.signal,
    ).catch(() => { precacheStarted.current = false; setPrecache({ state: "idle", pct: 0 }); });
    return () => ac.abort();
  }, [mapLoaded, online]);

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
  // Held until the welcome is dismissed so the browser's permission prompt is a
  // direct consequence of the guest's tap (primed = far better grant rates).
  useEffect(() => {
    if (source !== "gps" || showWelcome) return;
    if (!("geolocation" in navigator)) {
      setGpsError({
        title: "This phone can't show your location",
        detail: "Your device or browser doesn't support GPS on the web — you can still explore the map freely.",
      });
      return;
    }
    setGpsError(null);
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setGpsError(null);
        setAccuracy(typeof p.coords.accuracy === "number" ? p.coords.accuracy : null);
        setUser({ lat: p.coords.latitude, lng: p.coords.longitude });
        if (p.coords.heading != null && !Number.isNaN(p.coords.heading)) {
          setHeading(p.coords.heading);
        }
      },
      (err) => setGpsError(friendlyGpsError(err)),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [source, showWelcome]);

  const openPoi = openPoiId ? POIS.find((p) => p.id === openPoiId) ?? null : null;

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
  // Guest GPS onboarding states (display only — never change how position is used).
  const liveGps = source === "gps" && !showWelcome;
  const waitingForFix = liveGps && !gpsError && user == null;
  const poorAccuracy = liveGps && user != null && accuracy != null && accuracy > GOOD_FIX_M;

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

  return (
    <div className="stage">
      <aside className="pitch">
        <img className="pitch-logo" src={coverLogo} alt="Solio Game Reserve" />
        <div className="pitch-eyebrow">Solio Game Reserve · Companion concept</div>
        <h1 className="pitch-title">Find your way<br />through the wild.</h1>
        <p className="pitch-lead">
          A companion app for Solio Game Reserve — guests see themselves on the
          reserve's own map and navigate the tracks. Built to put conservation
          in every visitor's pocket.
        </p>
        <ul className="pitch-points">
          <li><span>◎</span><div><b>You-are-here</b><br />on Solio's own map, even offline.</div></li>
          <li><span>↱</span><div><b>Guided navigation</b><br />turn-by-turn along the reserve roads.</div></li>
          <li><span>◈</span><div><b>Self-guided drives</b><br />guided reserve tours — coming soon.</div></li>
        </ul>
        <div className="pitch-foot">Solio Game Reserve · the reserve's own map, in your pocket</div>
      </aside>

      <div className="device">
        <div className="app">
          {/* Loading gate — hold until the map is fully rendered + interactive. */}
          <div className={`app-splash${mapLoaded ? " done" : ""}`} aria-hidden={mapLoaded}>
            <img className="splash-logo" src={coverLogo} alt="" />
            <div className="splash-title">Solio Game Reserve</div>
            <div className="splash-spinner" />
            <div className="splash-note">Preparing the reserve map…</div>
          </div>

          {showGuard && <InAppGuard info={inAppInfo} onDismiss={() => setGuardDismissed(true)} />}

          {showA2HS && (
            <A2HSHint
              platform={inAppInfo.platform}
              installEvt={installEvt}
              onInstalled={() => setInstallEvt(null)}
              onDismiss={dismissA2HS}
            />
          )}

          {showWelcome && <Welcome isDemo={IS_DEMO} onStart={() => setShowWelcome(false)} />}

          <header className="topbar">
            <div className="brand">
              <img className="brand-mark" src={coverLogo} alt="Solio Game Reserve" />
              <div>
                <div className="brand-name">SOLIO</div>
                <div className="brand-sub">Game Reserve · Companion</div>
              </div>
            </div>
            <div className="topbar-actions">
              <span className={`status-chip ${online && precache.state !== "saved" ? "" : "off"}`}>
                <i className="status-dot" />
                {precache.state === "saving"
                  ? `Saving map… ${Math.round(precache.pct * 100)}%`
                  : precache.state === "saved"
                  ? "Map saved · works offline"
                  : online
                  ? "Online"
                  : "Offline-ready"}
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
            selectedPoiId={selectedPoiId}
            follow={follow}
            onSelectPoi={(p) => { setSelectedPoiId(p.id); setOpenPoiId(p.id); }}
            onUserPan={() => setFollow(false)}
            onLoaded={() => setMapLoaded(true)}
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
                      Detour
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
              <b>You're outside Solio</b>
              {IS_DEMO ? (
                <>
                  <span>Switch to “Demo drive” to explore the reserve.</span>
                  <button className="btn btn-accent sm" onClick={() => setSource("sim")}>Demo drive</button>
                </>
              ) : (
                <span>Your dot will appear here when you arrive. Meanwhile, explore the map.</span>
              )}
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
          </div>

          {/* Tour commentary at each stop */}
          {tour && tourAtStop && currentStop && (
            <div className="tour-card">
              <button className="pop-close" onClick={endTour} aria-label="End tour">×</button>
              <div className="tour-card-kicker">{tour.name} · Stop {tourStop + 1} of {tour.stops.length}</div>
              <div className="tour-card-title">{currentStop.title}</div>
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

        </section>

        <aside className="panel">
          <nav className="tabs">
            <button className={tab === "explore" ? "active" : ""} onClick={() => setTab("explore")}>Explore</button>
            <button className={tab === "drives" ? "active" : ""} onClick={() => setTab("drives")}>Drives</button>
            <button className={tab === "about" ? "active" : ""} onClick={() => setTab("about")}>About</button>
          </nav>

          {/* Location source + status (only where the live map matters) */}
          {(tab === "explore" || tab === "drives") && (
            IS_DEMO ? (
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
            ) : (
              // Guest mode: a quiet live-GPS status line, no controls.
              (waitingForFix || poorAccuracy) && (
                <div className="gps-status">
                  <i className="gps-status-dot" />
                  {waitingForFix ? "Getting a precise fix…" : "Improving your GPS accuracy…"}
                </div>
              )
            )
          )}
          {gpsError && (
            <div className="gps-error">
              <div className="gps-error-title">⚠ {gpsError.title}</div>
              <div className="gps-error-detail">{gpsError.detail}</div>
              {gpsError.steps && (
                <ol className="gps-error-steps">
                  {gpsError.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              )}
            </div>
          )}

          <div className="panel-body" ref={panelBodyRef}>
            {tab === "explore" && (
              <ExploreTab
                pois={POIS}
                user={user}
                selectedPoiId={selectedPoiId}
                onSelect={(p) => { setSelectedPoiId(p.id); setOpenPoiId(p.id); }}
                onNavigate={navigateTo}
              />
            )}
            {tab === "drives" && (
              // Shows "Coming soon" while TOURS is empty. Real, Solio-authored
              // rhino-safe drives drop into TOURS later as a pure data swap.
              <DrivesTab
                tours={TOURS}
                activeTourId={tour?.id ?? null}
                tourStop={tourStop}
                onStart={startTour}
                onEnd={endTour}
              />
            )}
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

function Welcome(props: { isDemo: boolean; onStart: () => void }) {
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

        {/* Plain-English safety notes — pending Callan's confirmation of wording. */}
        <ul className="welcome-rules">
          <li>Stay in your vehicle and keep to the tracks — no off-road driving.</li>
          <li>Keep your distance from wildlife and drive slowly.</li>
          <li>Reserve gate hours are 6:30 am – 5:00 pm.</li>
          <li>Your location stays on your phone — nothing is sent anywhere.</li>
        </ul>

        {/* Location primer — the button tap is what triggers the permission prompt. */}
        {!props.isDemo && (
          <p className="welcome-primer">
            To show you on the map, your phone will ask to share your location.
            It stays on your device.
          </p>
        )}

        <button className="btn btn-accent block" onClick={props.onStart}>
          {props.isDemo ? "Explore the demo →" : "Show me on the map →"}
        </button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------- In-app browser guard */

function InAppGuard(props: { info: InAppInfo; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const href = typeof window === "undefined" ? "" : window.location.href;

  function openInBrowser() {
    if (props.info.platform === "android") {
      // Well-supported by Android in-app browsers — opens the default browser.
      const u = new URL(href);
      window.location.href = `intent://${u.host}${u.pathname}${u.search}${u.hash}#Intent;scheme=https;end`;
    } else {
      // iOS has no reliable programmatic escape; x-safari- works in some apps and
      // is patched in others — attempt it, the instruction text is the real path.
      window.location.href = `x-safari-${href}`;
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard blocked — the on-screen link + instructions still work */
    }
  }

  return (
    <div className="guard">
      <div className="guard-card">
        <div className="guard-title">Open in your browser for the offline map</div>
        <p className="guard-lead">
          You've opened this inside another app. To save the reserve map so it works
          with no phone signal, open it in your normal browser.
        </p>
        {props.info.platform === "ios" && (
          <p className="guard-steps">
            Tap the <b>•••</b> menu (usually top-right), then choose{" "}
            <b>“Open in Safari”</b> or <b>“Open in external browser”</b>.
          </p>
        )}
        <div className="guard-actions">
          <button className="btn btn-accent sm" onClick={openInBrowser}>Open in browser</button>
          <button className="btn btn-ghost-dark sm" onClick={copyLink}>
            {copied ? "Link copied ✓" : "Copy link"}
          </button>
        </div>
        <button className="guard-dismiss" onClick={props.onDismiss}>Continue here anyway</button>
      </div>
    </div>
  );
}

/* ----------------------------------------------------- Add to Home Screen */

function A2HSHint(props: {
  platform: InAppInfo["platform"];
  installEvt: BeforeInstallPromptEvent | null;
  onInstalled: () => void;
  onDismiss: () => void;
}) {
  async function install() {
    if (!props.installEvt) return;
    try { await props.installEvt.prompt(); } catch { /* dismissed */ }
    props.onInstalled();
  }
  const canPrompt = !!props.installEvt; // Android/Chrome
  return (
    <div className="a2hs">
      <button className="a2hs-close" onClick={props.onDismiss} aria-label="Dismiss">×</button>
      <div className="a2hs-body">
        <img className="a2hs-mark" src={coverLogo} alt="" />
        <div>
          <div className="a2hs-title">Add Solio to your Home Screen</div>
          {canPrompt ? (
            <div className="a2hs-note">Install the map for one-tap access — and it stays saved for offline use.</div>
          ) : (
            <div className="a2hs-note">
              Tap <span className="a2hs-share" aria-label="the Share icon">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 15V3M8 7l4-4 4 4" /><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" />
                </svg>
              </span> then <b>“Add to Home Screen”</b> — the map stays one tap away and saved offline.
            </div>
          )}
        </div>
      </div>
      {canPrompt && (
        <button className="btn btn-accent sm block" onClick={install}>Install the app</button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Explore */

function ExploreTab(props: {
  pois: Poi[];
  user: LatLng | null;
  selectedPoiId: string | null;
  onSelect: (p: Poi) => void;
  onNavigate: (p: Poi) => void;
}) {
  const list = useMemo(() => {
    const withDist = props.pois.map((p) => ({
      poi: p,
      dist: props.user ? distanceMeters(props.user, poiWorld(p)) : 0,
    }));
    return props.user ? withDist.sort((a, b) => a.dist - b.dist) : withDist;
  }, [props.pois, props.user]);

  return (
    <div className="list">
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
  if (props.tours.length === 0) return <DrivesComingSoon />;
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

/* Placeholder for the guest build until Solio's own guides author the drives. */
function DrivesComingSoon() {
  return (
    <div className="list">
      <div className="card coming-soon">
        <div className="coming-soon-tag">Coming soon</div>
        <div className="card-title">Self-guided game drives</div>
        <div className="card-sub">
          Curated drives along the reserve tracks, with commentary from Solio's
          guides on what to look for and where. We're putting these together with
          the team — check back soon.
        </div>
      </div>
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
        <li><b>Self-guided drives</b> — guided reserve tours, coming soon.</li>
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

function etaMinutes(meters: number): number {
  return Math.max(1, Math.round(meters / ETA_MPS / 60));
}

// Turn a raw GeolocationPositionError into friendly, actionable guest copy. The
// denied case carries the exact re-enable steps for the guest's platform.
function friendlyGpsError(err: GeolocationPositionError): GpsError {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return {
        title: "Location is switched off for this map",
        detail: "To see yourself on the map, allow location and reload:",
        steps: IS_IOS
          ? [
              "Open iPhone Settings → Privacy & Security → Location Services (make sure it's on)",
              "Scroll to Safari Websites → set to “While Using the App”",
              "Come back here and reload the page",
            ]
          : [
              "Tap the padlock (or ⓘ) at the top of the browser address bar",
              "Open Permissions → Location → set to Allow",
              "Reload the page",
            ],
      };
    case err.POSITION_UNAVAILABLE:
      return {
        title: "Can't get a location fix right now",
        detail: "Your phone can't reach GPS at the moment — this often clears under open sky. The map still works while you wait.",
      };
    case err.TIMEOUT:
      return {
        title: "Still finding you…",
        detail: "Getting a GPS fix is taking a while. Keep the app open under open sky — you can explore the map meanwhile.",
      };
    default:
      return {
        title: "Location unavailable",
        detail: "We couldn't read your location, but you can still explore the map freely.",
      };
  }
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
