/**
 * Self-guided game-drive tours — curated loops along the reserve tracks with
 * commentary at each stop. Each stop references a POI (`poiId`) so the app can
 * route between them on the real road network and narrate as you arrive.
 *
 * The demo tour set was removed 2026-07-08 (no longer required). Real,
 * Solio-authored and rhino-safe drives will populate TOURS later — a pure data
 * swap: the tour engine and the Drives tab compile and run unchanged, showing
 * "Coming soon" while TOURS is empty.
 */

export interface TourStop {
  /** POI id to navigate to for this stop. */
  poiId: string;
  /** Short stop heading shown on arrival. */
  title: string;
  /** What to look for — read aloud / shown when you arrive. */
  commentary: string;
}

export interface Tour {
  id: string;
  name: string;
  summary: string;
  /** Rough drive time at game-drive pace. */
  durationMin: number;
  difficulty: "Easy" | "Moderate" | "4x4";
  /** Best time of day to set out. */
  bestTime: string;
  stops: TourStop[];
}

export const TOURS: Tour[] = [];
