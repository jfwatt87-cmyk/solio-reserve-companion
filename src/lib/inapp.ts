/* In-app browser detection (Phase 1 §3.11).
 *
 * Opening the map from a chat/social in-app browser (WhatsApp, Instagram,
 * Facebook, TikTok, Line…) silently defeats offline caching: those webviews
 * either can't register a service worker or give it ephemeral storage, so the
 * map loads fine online and dies in the first dead zone — the exact failure
 * Phase 1 exists to prevent. The QR-via-camera path opens the real browser, but
 * *shared links* don't, so we detect the degraded context and offer an escape.
 *
 * Two detection layers: user-agent tokens (the InAppSpy pattern set — catches
 * webviews that nominally register a SW but store it ephemerally) and a plain
 * feature check (no serviceWorker support at all).
 */

export type Platform = "ios" | "android" | "other";

// Known in-app webview UA tokens. Deliberately excludes Android Chrome Custom
// Tabs (real Chrome, full SW support) to avoid nagging a perfectly fine context.
const IN_APP_TOKENS = [
  "FBAN", "FBAV", "FB_IAB", "FBIOS", // Facebook / Messenger
  "Instagram",
  "WhatsApp",
  "Line/",
  "MicroMessenger",                   // WeChat
  "TikTok", "musical_ly", "Bytedance", "trill",
  "Snapchat",
  "Twitter",
  "LinkedInApp",
  "Pinterest",
];

export type InAppInfo = {
  platform: Platform;
  inApp: boolean;
  swSupported: boolean;
  /** A mobile guest whose offline caching will silently fail — show the guard. */
  degraded: boolean;
};

function detectPlatform(ua: string): Platform {
  if (/iPad|iPhone|iPod/.test(ua)) return "ios";
  if (/Macintosh/.test(ua) && typeof document !== "undefined" && "ontouchend" in document) return "ios";
  if (/Android/.test(ua)) return "android";
  return "other";
}

export function detectInApp(): InAppInfo {
  if (typeof navigator === "undefined") {
    return { platform: "other", inApp: false, swSupported: false, degraded: false };
  }
  const ua = navigator.userAgent;
  const platform = detectPlatform(ua);
  const inApp = IN_APP_TOKENS.some((t) => ua.includes(t));
  const swSupported = "serviceWorker" in navigator;
  // Only guests on a phone care about offline; desktop is the pitch/explore path.
  const mobile = platform === "ios" || platform === "android";
  return { platform, inApp, swSupported, degraded: mobile && (inApp || !swSupported) };
}
