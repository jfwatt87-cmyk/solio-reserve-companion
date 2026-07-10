/* Runtime navigation authorization — default-deny, independently expiring.
 *
 * NAV_ENABLED (src/data/reserve.ts) is the compile-time master hold, but it is
 * baked into the cached app shell: a phone that goes offline keeps whatever
 * shell it last downloaded, so a build flag alone can never REVOKE navigation
 * in the field. This layer adds the runtime half:
 *
 * - The app fetches nav-auth.json (which the service worker deliberately never
 *   caches) and stores the verdict WITH a timestamp.
 * - Navigation is allowed only while the stored verdict is BOTH positive AND
 *   fresh (NAV_AUTH_TTL_MS). No file, no storage, malformed data, expired
 *   verdict — all deny.
 *
 * Net effect once navigation launches: flipping public/nav-auth.json to
 * {"navigation": false} and redeploying switches navigation off on every
 * installed shell at its next online moment, and an offline shell's
 * authorization lapses by itself when the TTL runs out.
 */

import { NAV_ENABLED } from "../data/reserve";

const KEY = "solio-nav-auth"; // JSON {enabled: boolean, at: epoch-ms}

// 72 h: long enough that a guest's multi-day stay in the signal-poor reserve
// isn't interrupted, short enough that a revocation can't be outrun for long.
export const NAV_AUTH_TTL_MS = 72 * 3_600_000;

/** The stored verdict, applied strictly: positive AND fresh, else deny. */
export function navAuthCached(): boolean {
  if (!NAV_ENABLED) return false;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return false;
    const { enabled, at } = JSON.parse(raw) as { enabled?: unknown; at?: unknown };
    return enabled === true && typeof at === "number" && Date.now() - at < NAV_AUTH_TTL_MS;
  } catch {
    return false;
  }
}

/**
 * Re-check the server flag. Network success (either verdict) refreshes the
 * stored timestamp; any failure leaves the stored verdict to run out its TTL.
 */
export async function refreshNavAuth(base: string): Promise<boolean> {
  if (!NAV_ENABLED) return false;
  try {
    const resp = await fetch(base + "nav-auth.json", { cache: "no-store" });
    if (!resp.ok) return navAuthCached();
    const body = (await resp.json()) as { navigation?: unknown };
    const enabled = body?.navigation === true;
    try {
      localStorage.setItem(KEY, JSON.stringify({ enabled, at: Date.now() }));
    } catch {
      /* storage unavailable — the in-memory result still applies this session */
    }
    return enabled;
  } catch {
    return navAuthCached();
  }
}
