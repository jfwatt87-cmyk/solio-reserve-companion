/**
 * Georeferencing — the heart of "show me on their map".
 *
 * Given a set of Ground Control Points (GCPs) that tie pixel positions on the
 * reserve image to real-world coordinates, we fit a least-squares affine
 * transform in BOTH directions:
 *
 *    pixel  (x, y)  <->  world (lng, lat)
 *
 * An affine transform handles translation, scale, rotation and shear, which is
 * what you get when a map image is photographed/scanned slightly off-axis or
 * drawn to a consistent (if rotated) scale. For a hand-drawn / artistic map
 * with local distortion you would extend this with more GCPs and a thin-plate
 * spline; the public API here would not change.
 *
 * When Solio supply their real high-resolution map, only the GCP table in
 * `data/reserve.ts` needs to be re-measured — everything downstream is identical.
 */

import type { LatLng } from "./geo";

export interface Pixel {
  x: number;
  y: number;
}

export interface ControlPoint {
  /** Pixel position on the source image. */
  pixel: Pixel;
  /** The real-world coordinate that pixel represents. */
  world: LatLng;
  /** Optional human label, e.g. "Main Gate". */
  label?: string;
}

/**
 * Solve A·x = b (least squares) for the affine coefficients mapping
 * (u, v) -> w. Uses the normal equations on a 3x3 system — robust and tiny
 * for the handful of control points a map needs.
 */
function fitAxis(us: number[], vs: number[], ws: number[]): [number, number, number] {
  // Design matrix rows are [u, v, 1]; solve (AᵀA) c = Aᵀw.
  let s_uu = 0, s_uv = 0, s_u = 0, s_vv = 0, s_v = 0, s_1 = 0;
  let b_u = 0, b_v = 0, b_1 = 0;
  for (let i = 0; i < us.length; i++) {
    const u = us[i], v = vs[i], w = ws[i];
    s_uu += u * u; s_uv += u * v; s_u += u;
    s_vv += v * v; s_v += v; s_1 += 1;
    b_u += u * w; b_v += v * w; b_1 += w;
  }
  // Symmetric normal matrix.
  const N: number[][] = [
    [s_uu, s_uv, s_u],
    [s_uv, s_vv, s_v],
    [s_u, s_v, s_1],
  ];
  const b = [b_u, b_v, b_1];
  return solve3(N, b);
}

/** Gaussian elimination with partial pivoting for a 3x3 system. */
function solve3(M: number[][], b: number[]): [number, number, number] {
  const a = M.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++) {
      if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    }
    [a[col], a[pivot]] = [a[pivot], a[col]];
    const div = a[col][col] || 1e-12;
    for (let c = col; c < 4; c++) a[col][c] /= div;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = a[r][col];
      for (let c = col; c < 4; c++) a[r][c] -= f * a[col][c];
    }
  }
  return [a[0][3], a[1][3], a[2][3]];
}

export class GeoReference {
  private toWorldLng: [number, number, number];
  private toWorldLat: [number, number, number];
  private toPixelX: [number, number, number];
  private toPixelY: [number, number, number];

  /** RMS residual of the fit, in metres — a quick honesty check on accuracy. */
  readonly rmsErrorMeters: number;

  constructor(
    readonly imageWidth: number,
    readonly imageHeight: number,
    points: ControlPoint[],
  ) {
    if (points.length < 3) {
      throw new Error("Georeferencing needs at least 3 control points.");
    }
    const px = points.map((p) => p.pixel.x);
    const py = points.map((p) => p.pixel.y);
    const lng = points.map((p) => p.world.lng);
    const lat = points.map((p) => p.world.lat);

    // pixel -> world
    this.toWorldLng = fitAxis(px, py, lng);
    this.toWorldLat = fitAxis(px, py, lat);
    // world -> pixel
    this.toPixelX = fitAxis(lng, lat, px);
    this.toPixelY = fitAxis(lng, lat, py);

    // Residual, expressed in metres at this latitude for an intuitive number.
    const mPerDegLat = 111_320;
    const midLat = lat.reduce((a, b) => a + b, 0) / lat.length;
    const mPerDegLng = 111_320 * Math.cos((midLat * Math.PI) / 180);
    let sq = 0;
    for (const p of points) {
      const w = this.pixelToWorld(p.pixel);
      const dx = (w.lng - p.world.lng) * mPerDegLng;
      const dy = (w.lat - p.world.lat) * mPerDegLat;
      sq += dx * dx + dy * dy;
    }
    this.rmsErrorMeters = Math.sqrt(sq / points.length);
  }

  pixelToWorld(p: Pixel): LatLng {
    const [a, b, c] = this.toWorldLng;
    const [d, e, f] = this.toWorldLat;
    return { lng: a * p.x + b * p.y + c, lat: d * p.x + e * p.y + f };
  }

  worldToPixel(w: LatLng): Pixel {
    const [a, b, c] = this.toPixelX;
    const [d, e, f] = this.toPixelY;
    return { x: a * w.lng + b * w.lat + c, y: d * w.lng + e * w.lat + f };
  }

  /** Is a world coordinate within the bounds of the image? */
  contains(w: LatLng, marginPx = 0): boolean {
    const p = this.worldToPixel(w);
    return (
      p.x >= -marginPx &&
      p.y >= -marginPx &&
      p.x <= this.imageWidth + marginPx &&
      p.y <= this.imageHeight + marginPx
    );
  }
}
