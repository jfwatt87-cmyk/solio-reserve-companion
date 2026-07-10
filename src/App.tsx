import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ReserveMap } from "./components/ReserveMap";
import coverLogo from "./assets/solio-logo.png";
import { createGeoReference, pixelWorld, MAP_MARGIN, NAV_ENABLED } from "./data/reserve";
import { insideReserveBuffered } from "./data/boundary";
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
import { stepInstruction, type Route, type RouteStep } from "./lib/routing";
import { pathLength, poseAlong } from "./lib/sim";
import { precacheTiles, tilesAlreadyCached, verifyTilesCached, invalidateTileCache, requestPersistentStorage } from "./lib/precache";
import { navAuthCached, refreshNavAuth } from "./lib/navAuth";
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
  // Lazy routing graph: building it (thousands of nodes, per-segment haversine)
  // costs real main-thread time on low-end phones, and a guest with navigation
  // held (NAV_ENABLED=false, no ?demo) never routes at all — so the graph is
  // constructed on the first actual call, not at startup.
  const network = useMemo(() => {
    type Net = ReturnType<typeof createRoadNetwork>;
    let real: Net | null = null;
    const get = () => (real ??= createRoadNetwork());
    return {
      route: (...args: Parameters<Net["route"]>) => get().route(...args),
      alternatives: (...args: Parameters<Net["alternatives"]>) => get().alternatives(...args),
      nearestNode: (...args: Parameters<Net["nearestNode"]>) => get().nearestNode(...args),
    };
  }, []);

  const patrolPath = useMemo<LatLng[]>(() => {
    // Demo-only: the sim patrol is unreachable in guest mode, so don't pay for
    // routing its legs (which would force the lazy graph to build) at startup.
    if (!IS_DEMO) return [];
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
    // ?nav= must respect the navigation hold like every other entry point —
    // otherwise a shared/bookmarked URL draws a route no UI can dismiss. At
    // first paint the runtime authorization is whatever verdict is stored
    // (default-deny); the refresh effect below re-checks the server.
    () => (typeof window === "undefined" || !NAV_ENABLED || !navAuthCached() ? null : new URLSearchParams(window.location.search).get("nav")),
  );
  // Mid-drive waypoints (POI ids, in order) visited before the destination.
  const [stops, setStops] = useState<string[]>([]);

  const [showWelcome, setShowWelcome] = useState(
    () => typeof window === "undefined" || !new URLSearchParams(window.location.search).has("skipWelcome"),
  );
  // In-app browser guard (§3.11): detect once; the guest can dismiss and browse
  // online, but offline caching won't survive an in-app webview, so we warn.
  const inAppInfo = useMemo<InAppInfo>(() => detectInApp(), []);
  const [guardDismissed, setGuardDismissed] = useState(false);
  const showGuard = inAppInfo.degraded && !guardDismissed;

  // Add-to-Home-Screen hint (§3.4): installed PWAs get durable storage + one-tap
  // launch. Android/Chrome fires beforeinstallprompt (native button); iOS and
  // prompt-less Android get per-platform manual steps. Shown on every fresh visit
  // (dismissal is session-only, never persisted) but never in an already-installed
  // (standalone) window or an in-app webview.
  const [installEvt, setInstallEvt] = useState<BeforeInstallPromptEvent | null>(null);
  const [a2hsDismissed, setA2hsDismissed] = useState(false);
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
    (inAppInfo.platform === "ios" || inAppInfo.platform === "android");
  function dismissA2HS() {
    setA2hsDismissed(true);
  }
  const [toast, setToast] = useState<string | null>(null);
  // Toasts are transient by definition: auto-dismiss after 6 s (a new toast
  // re-arms the timer). Nothing else ever clears them.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);
  // Transient notice when a live guest crosses the reserve boundary (buffered).
  const [reserveAlert, setReserveAlert] = useState<string | null>(null);
  const wasInReserve = useRef<boolean | null>(null);
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  // Whether a service worker currently controls this page — a prerequisite for
  // precaching. On a FIRST launch the SW registers, activates and claims the
  // page only AFTER the initial load, so this starts false and flips true once
  // control arrives (see the effect below), letting the save start on THIS open
  // rather than requiring a second launch.
  const [swControlled, setSwControlled] = useState(
    () => typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller,
  );
  // Offline precache progress: "saving" while pulling the pyramid, "saved" once
  // the whole reserve is on the device. Drives the quiet status-chip messaging.
  const [precache, setPrecache] = useState<{ state: "idle" | "saving" | "saved"; pct: number }>(
    () => ({ state: tilesAlreadyCached() ? "saved" : "idle", pct: 0 }),
  );
  // Briefly hold the download bar at 100% "saved" after a save we watched, so the
  // completion is visible rather than the bar vanishing at the last percent.
  const [justSaved, setJustSaved] = useState(false);
  // Bumped when a launch-time integrity check finds the saved cache was evicted,
  // to re-trigger the precache effect (a plain state change won't, since its
  // deps are connectivity-only).
  const [cacheNonce, setCacheNonce] = useState(0);
  // Whether the browser granted persistent storage. Best-effort request, but
  // the RESULT matters: without it the saved map is evictable, so the "works
  // offline" claim is qualified and the Home-Screen tip carries real weight.
  const [persisted, setPersisted] = useState(false);
  // Runtime navigation authorization (default-deny, expiring — see lib/navAuth).
  // Compile-time NAV_ENABLED remains the master hold; this is the revocable half.
  const [navAuthed, setNavAuthed] = useState(() => navAuthCached());
  const navOn = NAV_ENABLED && navAuthed;
  // Saved-map durability: persistent storage granted, or installed to the Home
  // Screen (which WebKit exempts from eviction). Anything else is best-effort,
  // so the offline claim is softened and the Home-Screen tip shown.
  const storageDurable = persisted || isStandalone;

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
  // Watch for the service worker taking control (first launch claims the page
  // asynchronously, after load), so the proactive precache below can start on
  // this open instead of waiting for the next one.
  const precacheStarted = useRef(false);
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    if (navigator.serviceWorker.controller) setSwControlled(true);
    const onChange = () => {
      setSwControlled(!!navigator.serviceWorker.controller);
      // A new service worker just took control (a release happened mid-session).
      // A tile release empties the old tile cache, so the "saved" claim must be
      // re-validated NOW — not at next launch — or the chip lies in the bush.
      verifyTilesCached().then((ok) => {
        if (!ok) {
          invalidateTileCache();
          precacheStarted.current = false;
          setPrecache({ state: "idle", pct: 0 });
        }
        setCacheNonce((n) => n + 1); // let the precache effect re-evaluate
      });
    };
    navigator.serviceWorker.addEventListener("controllerchange", onChange);
    // `ready` resolves once a worker is active — a backstop in case control
    // arrived before this listener attached.
    navigator.serviceWorker.ready
      .then(() => { if (navigator.serviceWorker.controller) setSwControlled(true); })
      .catch(() => {});
    return () => navigator.serviceWorker.removeEventListener("controllerchange", onChange);
  }, []);

  useEffect(() => {
    // Not gated on mapLoaded: the tile pyramid is fetched directly, so the save
    // can begin during the "preparing" splash rather than after the map shows.
    if (precacheStarted.current || !online || !swControlled) return;
    if (tilesAlreadyCached()) return;
    if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) return;
    precacheStarted.current = true;
    const ac = new AbortController();
    setPrecache({ state: "saving", pct: 0 });
    precacheTiles(
      import.meta.env.BASE_URL,
      // Progress never claims "saved" — only the verified final result may.
      ({ done, total }) => setPrecache({ state: "saving", pct: total ? done / total : 0 }),
      ac.signal,
    )
      .then((r) => {
        if (r.saved) {
          setPrecache({ state: "saved", pct: 1 });
          return;
        }
        // Aborted (connectivity flip / unmount) or tiles genuinely failed:
        // clear the started latch so the effect can run again — the old code
        // left it set and the save could never resume within the session.
        precacheStarted.current = false;
        if (!r.aborted) setPrecache({ state: "idle", pct: r.total ? r.done / r.total : 0 });
      })
      .catch(() => {
        precacheStarted.current = false;
        setPrecache({ state: "idle", pct: 0 });
      });
    return () => ac.abort();
  }, [online, swControlled, cacheNonce]);

  // Gentle self-heal: while the map is NOT saved but we look online with a
  // controlling SW, retry every 20 s (covers captive-portal wifi, upstream
  // outages and failed-tile runs) and on returning to the foreground. Cheap:
  // already-cached tiles are skipped, so a retry only pulls what's missing.
  useEffect(() => {
    if (precache.state !== "idle" || !online || !swControlled) return;
    if (tilesAlreadyCached()) return;
    const t = setTimeout(() => setCacheNonce((n) => n + 1), 20_000);
    const onVis = () => {
      if (document.visibilityState === "visible") setCacheNonce((n) => n + 1);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearTimeout(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [precache.state, online, swControlled, cacheNonce]);

  // Integrity guard for silent eviction. iOS can drop the tile cache under
  // storage pressure while leaving the "saved" flag behind, so a returning guest
  // could open the app in a dead zone believing the map is downloaded. On launch,
  // verify the saved tiles still exist; if they don't, stop claiming "saved"
  // (honest messaging) and re-pull whenever there's signal. Since iOS can't
  // re-download in the background, every foreground open is our chance to heal.
  useEffect(() => {
    if (precache.state !== "saved") return;
    let cancelled = false;
    verifyTilesCached().then((ok) => {
      if (cancelled || ok) return;
      invalidateTileCache();
      precacheStarted.current = false;
      setPrecache({ state: "idle", pct: 0 });
      setCacheNonce((n) => n + 1); // re-run the precache effect (deps changed)
    });
    return () => { cancelled = true; };
    // once on launch — later state flips to "saved" are our own doing, not eviction
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ask for persistent storage — WebKit favours Home Screen apps and exempts
  // persistent origins from eviction. Never blocks, but the verdict drives the
  // qualified messaging: only a persistent (or installed) origin gets the
  // unhedged "works offline".
  useEffect(() => {
    requestPersistentStorage().then(setPersisted).catch(() => setPersisted(false));
  }, []);

  // Re-validate the saved map whenever it's about to matter: returning to the
  // foreground (iOS evicts while the app is backgrounded) and the moment
  // connectivity drops (the last chance to warn honestly). Launch-time and
  // controllerchange checks exist above; this closes the long-session gap.
  const lastVerify = useRef(0);
  useEffect(() => {
    if (precache.state !== "saved") return;
    const recheck = () => {
      if (Date.now() - lastVerify.current < 30_000) return; // visibility+online can fire together
      lastVerify.current = Date.now();
      verifyTilesCached().then((ok) => {
        if (ok) return;
        invalidateTileCache();
        precacheStarted.current = false;
        setPrecache({ state: "idle", pct: 0 });
        setCacheNonce((n) => n + 1);
      });
    };
    const onVis = () => { if (document.visibilityState === "visible") recheck(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("offline", recheck);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("offline", recheck);
    };
  }, [precache.state]);

  // Refresh the navigation authorization on launch and whenever we come back
  // online. While NAV_ENABLED is false this resolves to false without fetching.
  useEffect(() => {
    if (!NAV_ENABLED) return;
    let cancelled = false;
    refreshNavAuth(import.meta.env.BASE_URL).then((ok) => { if (!cancelled) setNavAuthed(ok); });
    return () => { cancelled = true; };
  }, [online]);

  // If authorization lapses mid-session (revoked or expired), end any active
  // drive cleanly — otherwise the banner disappears but the route lives on.
  useEffect(() => {
    if (navOn || (!driving && !destPoiId && !tour)) return;
    drivingNav.current = false;
    tourDriving.current = false;
    setTour(null);
    setTourAtStop(false);
    setDriving(false);
    setActiveRoute(null);
    setDestPoiId(null);
    setStops([]);
  }, [navOn, driving, destPoiId, tour]);

  // Flash "Map saved" on the download bar for a moment once a save we started
  // this session completes (not when tiles were already cached on open).
  useEffect(() => {
    if (precache.state !== "saved" || !precacheStarted.current) return;
    setJustSaved(true);
    const t = setTimeout(() => setJustSaved(false), 3000);
    return () => clearTimeout(t);
  }, [precache.state]);

  // Reveal the app (dismiss the "preparing" splash) once the map is interactive
  // AND the offline save has SETTLED: saved, not possible now (offline), or never
  // going to start (no controlling service worker). While a save is actively
  // running we hold the splash so preparing genuinely includes the download; the
  // Continue button and the failsafe below ensure a guest is never trapped.
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    if (revealed || !mapLoaded) return;
    if (precache.state === "saved" || !online) { setRevealed(true); return; }
    if (precache.state === "idle") {
      // no save has started shortly after the map is ready → none will (no SW)
      const t = setTimeout(() => setRevealed(true), 6000);
      return () => clearTimeout(t);
    }
    // precache.state === "saving": hold the splash until it saves (or the user
    // taps Continue / the failsafe fires).
  }, [revealed, mapLoaded, precache.state, online]);
  // Failsafe: never hold the splash indefinitely on a slow or stuck save.
  useEffect(() => {
    if (!mapLoaded || revealed) return;
    const t = setTimeout(() => setRevealed(true), 30000);
    return () => clearTimeout(t);
  }, [mapLoaded, revealed]);

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
    setStops([]);
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

  // Notify once when a live guest crosses the reserve boundary (either way). The
  // buffered test keeps a guest at a gate — which sits on the fence — "inside",
  // and only a sustained crossing past the grace band flips the state, so GPS
  // jitter at the edge doesn't flap the alert. Sim/demo drives never trigger it.
  useEffect(() => {
    if (source !== "gps" || showWelcome || !user) {
      wasInReserve.current = null;
      return;
    }
    const inside = insideReserveBuffered(user);
    const prev = wasInReserve.current;
    wasInReserve.current = inside;
    if (prev === true && !inside) setReserveAlert("You're leaving Solio Game Reserve");
    else if (prev === false && inside) setReserveAlert("Welcome back to Solio Game Reserve");
  }, [user, source, showWelcome]);

  // The boundary notice persists (it's a standing safety state) until the guest
  // dismisses it or a new crossing replaces it — no auto-timeout.

  const openPoi = openPoiId ? POIS.find((p) => p.id === openPoiId) ?? null : null;

  // In full-screen map mode the place popup and the toast both sit at the bottom
  // of the screen, so a toast would land on top of the popup's buttons. Measure
  // the open popup and lift the toast(s) to sit clear above it. (In windowed mode
  // the panel separates them, so no lift is needed.)
  const poiPopRef = useRef<HTMLDivElement | null>(null);
  const [popH, setPopH] = useState(0);
  useLayoutEffect(() => {
    setPopH(openPoiId && poiPopRef.current ? poiPopRef.current.offsetHeight : 0);
  }, [openPoiId, Boolean(user), destPoiId, stops]);
  const toastLift = mapFull && popH ? popH + 24 : 0;

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
    // With stops, offer the single via-route; without, offer alternatives.
    const opts = stops.length
      ? [multiStopRoute(start.id, [...stops, destPoiId])].filter((r): r is Route => !!r)
      : network.alternatives(start.id, dest.nodeId, 3);
    if (!opts.length || opts[0].path.length < 2) {
      // No route can also mean the POI isn't bound to a road (e.g. the airstrip
      // until Callan adds its track) — don't tell a guest 10 km away they've
      // "arrived"; be honest about the missing road instead.
      const near = distanceMeters(from, poiWorld(dest)) < 250;
      setToast(near ? `You're already at ${dest.name}` : `No drivable route to ${dest.name} yet`);
      setDestPoiId(null);
      setStops([]);
      setRouteOptions([]);
      return;
    }
    setRouteOptions(opts);
    setSelectedRouteIdx(0);
  }, [destPoiId, driving, network, stops]);

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
        : step.maneuver === "stop"
        ? `Stop at ${step.road}`
        : stepInstruction(step.maneuver, step.road);
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
        line: first ? stepInstruction(first.maneuver, first.road) : "Start drive",
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
    if (!navOn) return; // navigation held for Phase 1 — reserve.ts NAV_ENABLED + runtime navAuth
    setDestPoiId(p.id);
    setSelectedPoiId(p.id);
    setTab("explore");
    setFollow(true);
    setSelectedRouteIdx(0);
    // Preview the route(s) first; hold the demo dot still while you choose, then
    // ▶ Drive sets off. (The preview effect computes the options.)
    if (source === "sim") setPlaying(false);
  }

  // Route through an ordered list of POIs (waypoints then destination), joining
  // the per-leg routes into one drive with a "Stop at …" step at each waypoint.
  function multiStopRoute(fromNodeId: string, poiIds: string[]): Route | null {
    const wps = poiIds.map((id) => POIS.find((p) => p.id === id)).filter((p): p is Poi => !!p);
    if (!wps.length) return null;
    const nodeSeq = [fromNodeId, ...wps.map((w) => w.nodeId)];
    const legs: Route[] = [];
    for (let i = 0; i < nodeSeq.length - 1; i++) {
      const leg = network.route(nodeSeq[i], nodeSeq[i + 1]);
      if (!leg || leg.path.length < 2) return null;
      legs.push(leg);
    }
    const path = [...legs[0].path];
    const nodeIds = [...legs[0].nodeIds];
    const steps: RouteStep[] = [];
    legs.forEach((leg, i) => {
      if (i > 0) { path.push(...leg.path.slice(1)); nodeIds.push(...leg.nodeIds.slice(1)); }
      if (i === legs.length - 1) {
        steps.push(...leg.steps);
      } else {
        steps.push(...leg.steps.slice(0, -1)); // drop this leg's "arrive"
        const at = leg.path[leg.path.length - 1];
        steps.push({ maneuver: "stop", road: wps[i].name, roadClass: "graded", distanceM: 0, at });
      }
    });
    return { nodeIds, path, steps, totalM: legs.reduce((s, l) => s + l.totalM, 0) };
  }

  // Apply a new stop order. Recomputes the live route from the current position
  // when already driving; otherwise the preview effect rebuilds from `stops`.
  function replan(next: string[]) {
    setStops(next);
    if (driving && user && destPoiId) {
      const r = multiStopRoute(network.nearestNode(user).id, [...next, destPoiId]);
      if (r && r.path.length >= 2) {
        setActiveRoute(r);
        setSimPath(r.path);
        setSimDist(source === "gps" ? projectOnPath(user, r.path).along : 0);
        if (source === "sim") setPlaying(true);
      }
    }
  }
  function addStop(id: string) {
    if (!destPoiId || id === destPoiId || stops.includes(id)) return;
    replan([...stops, id]);
    setToast(`Stop added · ${POIS.find((p) => p.id === id)?.name ?? ""}`);
  }
  function removeStop(id: string) {
    replan(stops.filter((s) => s !== id));
  }
  function moveStop(i: number, dir: -1 | 1) {
    const j = i + dir;
    if (j < 0 || j >= stops.length) return;
    const next = [...stops];
    [next[i], next[j]] = [next[j], next[i]];
    replan(next);
  }

  // Replace the whole drive with a fresh destination (clearing any stops).
  function startNewDrive(p: Poi) {
    drivingNav.current = false;
    setDriving(false);
    setActiveRoute(null);
    setStops([]);
    navigateTo(p);
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
      if (destPoi) {
        const near = !!user && distanceMeters(user, poiWorld(destPoi)) < 250;
        setToast(near ? `You're already at ${destPoi.name}` : `No drivable route to ${destPoi.name} yet`);
      }
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
    setStops([]);
    drivingNav.current = false;
    setDriving(false);
    setActiveRoute(null);
    setSimPath(patrolPath);
  }

  // ---- Self-guided tours ---------------------------------------------------
  const currentStop = tour ? tour.stops[tourStop] ?? null : null;

  function driveToStop(t: Tour, idx: number) {
    if (!navOn) return; // tours drive the nav/sim engine — held with navigation
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
      if (distanceMeters(user, poiWorld(poi)) > 250) {
        // Unroutable stop (POI not bound to a road) — say so, don't fake arrival.
        setToast(`No drivable route to ${poi.name} yet`);
        return;
      }
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
    if (!navOn) return; // tours drive the nav/sim engine — held with navigation
    if (!user) { setToast("Waiting for your location…"); return; }
    setStops([]); // a tour is its own itinerary — drop any custom waypoints
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
        <div className="pitch-eyebrow">Solio Game Reserve · Guest Companion</div>
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
          {/* Loading gate — hold until the map is interactive AND the offline map
              has saved (or settled), so opening the app leads with the download. */}
          <div className={`app-splash${revealed ? " done" : ""}`} aria-hidden={revealed}>
            <img className="splash-logo" src={coverLogo} alt="" />
            <div className="splash-title">Solio Game Reserve</div>
            {precache.state === "saving" || justSaved ? (
              <>
                <div className="splash-dl">
                  <div className="splash-dl-row">
                    <span>{justSaved ? "Map saved" : "Saving the map for offline use"}</span>
                    <span className="splash-dl-pct">
                      {justSaved ? "✓" : `${Math.round(precache.pct * 100)}%`}
                    </span>
                  </div>
                  <div className="map-dl-track">
                    <div
                      className={`map-dl-fill${justSaved ? " done" : ""}`}
                      style={{ width: `${justSaved ? 100 : Math.round(precache.pct * 100)}%` }}
                    />
                  </div>
                </div>
                <div className="splash-note">
                  {justSaved ? "Ready to explore, even with no signal." : "So the reserve works with no phone signal."}
                </div>
                {mapLoaded && !justSaved && (
                  <button className="splash-skip" onClick={() => setRevealed(true)}>
                    Continue without waiting
                  </button>
                )}
              </>
            ) : (
              <>
                <div className="splash-spinner" />
                <div className="splash-note">Preparing the reserve map…</div>
              </>
            )}
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

          {showWelcome && (
            <Welcome
              isDemo={IS_DEMO}
              onStart={() => setShowWelcome(false)}
              saveState={precache.state}
              savePct={precache.pct}
              online={online}
              durable={storageDurable}
            />
          )}

          <header className="topbar">
            <div className="brand">
              <img className="brand-mark" src={coverLogo} alt="Solio Game Reserve" />
              <div>
                <div className="brand-name">SOLIO</div>
                <div className="brand-sub">Game Reserve · Companion</div>
              </div>
            </div>
            <div className="topbar-actions">
              <span
                className={`status-chip ${
                  precache.state === "saved" ? "" : !online ? "warn" : "off"
                }`}
              >
                <i className="status-dot" />
                {precache.state === "saved"
                  ? storageDurable ? "Map saved · works offline" : "Map saved · works offline for now"
                  : precache.state === "saving"
                  ? `Saving map… ${Math.round(precache.pct * 100)}%`
                  : online
                  ? "Map not saved yet"
                  : "Map not saved · offline"}
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

          {/* Danger case: offline with the map not fully saved. This is the exact
              trap — a guest who left before the save finished, now in a dead zone.
              Say so plainly rather than letting the map look complete. */}
          {!online && precache.state !== "saved" && (
            <div className="offline-warn" role="alert">
              <b>⚠ Map not fully saved</b>
              <span>
                You're offline, so parts of the reserve may not load here. Reconnect to
                WiFi or mobile data and wait for “Map saved” before heading out.
              </span>
            </div>
          )}

          {/* Offline map download progress — visible on first load while the
              whole tile pyramid is pulled into the cache, so guests can see the
              reserve is saving for offline use before they drive out of signal. */}
          {(precache.state === "saving" || justSaved) && (
            <div className="map-dl" role="status" aria-live="polite">
              <div className="map-dl-row">
                <span className="map-dl-label">
                  {justSaved ? "Map saved · works offline" : "Downloading map for offline use"}
                </span>
                <span className="map-dl-pct">
                  {justSaved ? "✓" : `${Math.round(precache.pct * 100)}%`}
                </span>
              </div>
              <div className="map-dl-track">
                <div
                  className={`map-dl-fill${justSaved ? " done" : ""}`}
                  style={{ width: `${justSaved ? 100 : Math.round(precache.pct * 100)}%` }}
                />
              </div>
            </div>
          )}

          {/* Live navigation banner */}
          {navOn && destPoi && banner && (
            <div className="nav-banner">
              <div className="nav-step">
                <div className="nav-maneuver">{banner.icon}</div>
                <div className="nav-text">
                  <div className="nav-instruction">
                    {banner.distToNext != null && banner.distToNext > 60 && (
                      <span className="nav-in">In {formatDistance(banner.distToNext)} · </span>
                    )}
                    {banner.line}
                  </div>
                  <div className="nav-meta">
                    To {destPoi.name} · {formatDistance(banner.remaining)} · ~{etaMinutes(banner.remaining)} min
                    {" · arrive "}{arrivalClock(etaMinutes(banner.remaining))}
                  </div>
                </div>
              </div>
              {/* Stops — reorder (◀ ▶) or remove (✕); re-plans the route. */}
              {stops.length > 0 && (
                <div className="nav-stops">
                  {stops.map((id, i) => (
                    <div className="stop-chip" key={id}>
                      <span className="stop-num">{i + 1}</span>
                      <span className="stop-name">{POIS.find((p) => p.id === id)?.name ?? id}</span>
                      <button className="stop-btn" disabled={i === 0} onClick={() => moveStop(i, -1)} aria-label="Move earlier">◀</button>
                      <button className="stop-btn" disabled={i === stops.length - 1} onClick={() => moveStop(i, 1)} aria-label="Move later">▶</button>
                      <button className="stop-btn" onClick={() => removeStop(id)} aria-label="Remove stop">✕</button>
                    </div>
                  ))}
                </div>
              )}
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
            <div className="poi-pop" ref={poiPopRef}>
              <button className="pop-close dark" onClick={() => setOpenPoiId(null)} aria-label="Close">×</button>
              <div className="poi-pop-title">{openPoi.name}</div>
              <div className="poi-pop-note">{openPoi.blurb}</div>
              {/* Distance is always shown; the navigate/drive actions are held for
                  Phase 1 (NAV_ENABLED + runtime navAuth) — see reserve.ts. */}
              {(user || navOn) && (
                <div className="poi-pop-actions">
                  {user && <span className="poi-pop-dist">{formatDistance(distanceMeters(user, poiWorld(openPoi)))} away</span>}
                  {navOn &&
                    (destPoiId && destPoiId !== openPoi.id && !stops.includes(openPoi.id) ? (
                      <>
                        <button
                          className="btn btn-ghost sm"
                          onClick={() => { const id = openPoi.id; setOpenPoiId(null); addStop(id); }}
                        >
                          Add as stop
                        </button>
                        <button
                          className="btn btn-accent sm"
                          onClick={() => { const p = openPoi; setOpenPoiId(null); startNewDrive(p); }}
                        >
                          Start new drive
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn btn-accent sm"
                        onClick={() => { const p = openPoi; setOpenPoiId(null); navigateTo(p); }}
                      >
                        Navigate here
                      </button>
                    ))}
                </div>
              )}
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
                  <button
                    className={source === "gps" ? "on" : ""}
                    onClick={() => {
                      // Leaving sim: drop the simulated position/heading so the
                      // first REAL fix starts clean — otherwise the stale sim
                      // pose lingers on the dot and can fire a bogus
                      // boundary alert when the real fix lands elsewhere.
                      setSource("gps");
                      setUser(null);
                      setHeading(null);
                    }}
                  >Use my GPS</button>
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
                navEnabled={navOn}
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

          {toast && (
            <div
              className="toast"
              style={toastLift ? { bottom: toastLift } : undefined}
              role="status"
              aria-live="polite"
            >
              ✓ {toast}
            </div>
          )}
          {reserveAlert && (
            <div
              className="toast toast-warn"
              style={toastLift ? { bottom: toastLift + 46 } : undefined}
              role="status"
              aria-live="polite"
            >
              <span>⚑ {reserveAlert}</span>
              <button className="toast-dismiss" onClick={() => setReserveAlert(null)} aria-label="Dismiss">✕</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Welcome */

function Welcome(props: {
  isDemo: boolean;
  onStart: () => void;
  saveState: "idle" | "saving" | "saved";
  savePct: number;
  online: boolean;
  durable: boolean;
}) {
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

        {/* Offline-save status, shown here (before "Show me on the map") so a
            returning guest sees the map is ready — and the no-signal warning is
            hidden once it's saved, since it no longer applies. */}
        {props.saveState === "saved" ? (
          <>
            <div className="welcome-save-ok">✓ Map saved — works offline</div>
            {/* Honest durability note: without persistent storage (or a Home
                Screen install) the phone may clear the saved map over time. */}
            {!props.durable && (
              <p className="welcome-save-tip">
                Phones can clear saved data over time — add this page to your Home
                Screen to keep the map saved.
              </p>
            )}
          </>
        ) : props.saveState === "saving" ? (
          <div className="welcome-save-note">
            <div className="welcome-save-row">
              <span>Saving the map for offline use…</span>
              <b>{Math.round(props.savePct * 100)}%</b>
            </div>
            <div className="map-dl-track">
              <div className="map-dl-fill" style={{ width: `${Math.round(props.savePct * 100)}%` }} />
            </div>
            <span className="welcome-save-sub">
              The reserve has little or no signal — keep this open until it finishes.
            </span>
          </div>
        ) : props.online ? (
          <p className="welcome-save-note">
            The reserve has little or no phone signal. Keep this open on WiFi until it
            says <b>“Map saved”</b> so the whole map works offline once you're inside.
          </p>
        ) : (
          <p className="welcome-save-note warn">
            You're offline and the map isn't saved yet. Connect to WiFi and wait for
            <b> “Map saved”</b> before heading into the reserve.
          </p>
        )}

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
          ) : props.platform === "ios" ? (
            <div className="a2hs-note">
              Tap <span className="a2hs-share" aria-label="the Share icon">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 15V3M8 7l4-4 4 4" /><path d="M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7" />
                </svg>
              </span> then <b>“Add to Home Screen”</b> — the map stays one tap away and saved offline.
            </div>
          ) : (
            <div className="a2hs-note">
              Tap the <span className="a2hs-share" aria-label="the menu icon">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor">
                  <circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" />
                </svg>
              </span> menu, then <b>“Add to Home screen”</b> — the map stays one tap away and saved offline.
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
  navEnabled: boolean;
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
      <p className="hint">
        {props.navEnabled
          ? "Tap a place to see it, or navigate there along the reserve tracks."
          : "Tap a place to see it on the map."}
      </p>
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
            {props.navEnabled && (
              <button
                className="btn btn-accent sm"
                onClick={(e) => { e.stopPropagation(); props.onNavigate(poi); }}
              >
                Navigate
              </button>
            )}
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

/** Clock time of arrival, `minutes` from now (e.g. "2:32 pm" / "14:32" per locale). */
function arrivalClock(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000)
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase();
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
    case "stop": return "⚑";
    default: return "↑";
  }
}
