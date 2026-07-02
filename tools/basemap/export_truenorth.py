# Exports the compass-corrected true-north GeoTIFF as the app basemap:
#   * a web-friendly JPEG (src/assets/solio-truenorth.jpg), and
#   * src/assets/solio-truenorth.json holding the image's four WGS84 corners,
#     the display `bearing`, `merc2px` (EPSG:3857 -> pixel) and pixel size.
#
# Two raster clean-ups happen here, BOTH kept exactly consistent with the
# georeference so GPS accuracy is preserved (rigid ops + rebuilt transform):
#   1. WEDGE FILL: straightening the poster left pure-black rotation-fill in the
#      corners + a thin frame; we repaint the border-connected black with paper.
#      (colour-only, geometry untouched.)
#   2. RESIDUAL DE-SKEW: the supplied "straightened" poster still carries a small
#      (~0.6 deg) tilt, so the frame/text render sloped when pinned axis-aligned.
#      We rigidly rotate the raster to level it AND compose the same rotation into
#      the geotransform, so every real lng/lat still lands on the same drawn
#      feature (rigid rotation preserves scale + relative positions exactly).
import os, json, math
import numpy as np
import cv2
import rasterio
from affine import Affine
from pyproj import Transformer
from PIL import Image
Image.MAX_IMAGE_PIXELS = None

HERE = os.path.dirname(os.path.abspath(__file__))
TIF = os.path.expanduser("~/Downloads/SOLIO_MAP_FINAL_straightened_georef_compass_true_north.tif")
OUT_IMG = os.path.join(HERE, "..", "..", "src", "assets", "solio-truenorth.jpg")
OUT_JSON = os.path.join(HERE, "..", "..", "src", "assets", "solio-truenorth.json")

ds = rasterio.open(TIF)
T = ds.transform
W, H = ds.width, ds.height
to4326 = Transformer.from_crs(ds.crs, "EPSG:4326", always_xy=True)

# Bearing of the ORIGINAL straighten (poster "up" vs true north) -- only used to
# size the wedge-fill edge band below; the final JSON bearing is recomputed after
# the de-skew from the rebuilt transform.
orig_bearing = math.degrees(math.atan2(-T.b, -T.e))

img = Image.open(TIF).convert("RGB")
arr = np.asarray(img).copy()

# --- 1. Fill the rotation "wedges" ----------------------------------------
black = (arr.max(axis=2) < 40).astype(np.uint8)  # near-black mask (fill is [0,0,0])
n, labels = cv2.connectedComponents(black, connectivity=8)
border = set(labels[0, :]) | set(labels[-1, :]) | set(labels[:, 0]) | set(labels[:, -1])
border.discard(0)
fill = np.isin(labels, list(border))
# grow a few px so the anti-aliased dark rim at the wedge/paper boundary is covered too
fill = cv2.dilate(fill.astype(np.uint8), np.ones((5, 5), np.uint8), iterations=1).astype(bool)
# Guard: confine the repaint to an EDGE BAND so a border-connected black region can
# never chain inland and recolor legitimately-dark map artwork (roads/rivers/labels).
theta = math.radians(abs(orig_bearing))
margin = max(48, int(round(max(arr.shape) * math.sin(theta) * 1.3)))
band = np.zeros(black.shape, dtype=bool)
band[:margin, :] = band[-margin:, :] = True
band[:, :margin] = band[:, -margin:] = True
dropped = int((fill & ~band).sum())
fill &= band
paper = np.median(arr[(arr.sum(axis=2) > 640) & ~fill].reshape(-1, 3), axis=0).astype(np.uint8)
arr[fill] = paper
print(f"wedge fill: repainted {int(fill.sum())} px to paper {paper.tolist()}; "
      f"edge band {margin}px (dropped {dropped} inland px outside band)")

# --- 2. Residual de-skew (level the frame/text) ---------------------------
def measure_tilt(gray):
    """Angle (deg, + = right-side-down) of the top & bottom frame lines."""
    h, w = gray.shape
    def band_tilt(y0, y1):
        xs, ys = [], []
        for c in range(int(w * 0.06), int(w * 0.94), 6):
            seg = gray[y0:y1, c]
            idx = int(np.argmin(seg))
            if seg[idx] < 130:
                xs.append(c); ys.append(y0 + idx)
        if len(xs) < 50:
            return None
        xs = np.array(xs, float); ys = np.array(ys, float)
        m, b = np.polyfit(xs, ys, 1)
        r = np.abs(ys - (m * xs + b)); k = r < np.percentile(r, 85)
        m, _ = np.polyfit(xs[k], ys[k], 1)
        return math.degrees(math.atan(m))
    vals = [v for v in (band_tilt(20, 160), band_tilt(h - 160, h - 8)) if v is not None]
    return sum(vals) / len(vals) if vals else 0.0

gray0 = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY)
tilt = measure_tilt(gray0)
M = None
if abs(tilt) >= 0.05 and abs(tilt) < 3.0:
    center = ((W - 1) / 2.0, (H - 1) / 2.0)
    # Pick the rotation sign that actually minimises the residual (guards sign convention).
    cand = []
    for ang in (tilt, -tilt):
        Mm = cv2.getRotationMatrix2D(center, ang, 1.0)
        out = cv2.warpAffine(arr, Mm, (W, H), flags=cv2.INTER_LANCZOS4,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=[int(x) for x in paper])
        res = measure_tilt(cv2.cvtColor(out, cv2.COLOR_RGB2GRAY))
        cand.append((abs(res), ang, Mm, out, res))
    cand.sort(key=lambda t: t[0])
    _, ang, M, arr, res = cand[0]
    print(f"de-skew: residual tilt {tilt:+.3f} deg -> applied {ang:+.3f} deg -> now {res:+.3f} deg")
    # Rebuild the geotransform to match the pixel rotation: a source pixel s now sits
    # at dst = M.s, so new_pixel -> mercator is  T_new = T . M^-1  (exact, rigid).
    Mh = np.vstack([M, [0, 0, 1]])
    Minv = np.linalg.inv(Mh)
    Th = np.array([[T.a, T.b, T.c], [T.d, T.e, T.f], [0, 0, 1]])
    Tn = Th @ Minv
    T = Affine(Tn[0, 0], Tn[0, 1], Tn[0, 2], Tn[1, 0], Tn[1, 1], Tn[1, 2])
else:
    print(f"de-skew: measured tilt {tilt:+.3f} deg -- no correction applied")

# --- 2b. Un-shear (make the vertical borders actually vertical) ------------
# The georeference is non-orthogonal (its two axes are ~0.6 deg off square), so
# after levelling the horizontals the frame is still a parallelogram: the left/
# right borders lean. Correct it with a horizontal shear and compose that into
# the transform too (exact affine -> GPS still lands on the same feature).
def measure_shear(gray):
    """Angle (deg) of the left & right frame lines from vertical."""
    h, w = gray.shape
    def band_shear(x0, x1):
        xs, ys = [], []
        for r in range(int(h * 0.06), int(h * 0.94), 6):
            seg = gray[r, x0:x1]
            idx = int(np.argmin(seg))
            if seg[idx] < 130:
                xs.append(x0 + idx); ys.append(r)
        if len(xs) < 50:
            return None
        xs = np.array(xs, float); ys = np.array(ys, float)
        m, b = np.polyfit(ys, xs, 1)
        r = np.abs(xs - (m * ys + b)); k = r < np.percentile(r, 85)
        m, _ = np.polyfit(ys[k], xs[k], 1)
        return math.degrees(math.atan(m))
    vals = [v for v in (band_shear(8, 160), band_shear(w - 160, w - 8)) if v is not None]
    return sum(vals) / len(vals) if vals else 0.0

shear = measure_shear(cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY))
if abs(shear) >= 0.05 and abs(shear) < 3.0:
    cy = (H - 1) / 2.0
    cand = []
    for sg in (shear, -shear):
        s = math.tan(math.radians(sg))
        Sm = np.array([[1.0, -s, s * cy], [0.0, 1.0, 0.0]])
        out = cv2.warpAffine(arr, Sm, (W, H), flags=cv2.INTER_LANCZOS4,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=[int(x) for x in paper])
        res = measure_shear(cv2.cvtColor(out, cv2.COLOR_RGB2GRAY))
        cand.append((abs(res), Sm, out, res))
    cand.sort(key=lambda t: t[0])
    _, Sm, arr, res = cand[0]
    print(f"un-shear: residual shear {shear:+.3f} deg -> now {res:+.3f} deg")
    Sh = np.vstack([Sm, [0, 0, 1]])
    Sinv = np.linalg.inv(Sh)
    Th = np.array([[T.a, T.b, T.c], [T.d, T.e, T.f], [0, 0, 1]])
    Tn = Th @ Sinv
    T = Affine(Tn[0, 0], Tn[0, 1], Tn[0, 2], Tn[1, 0], Tn[1, 1], Tn[1, 2])
else:
    print(f"un-shear: measured shear {shear:+.3f} deg -- no correction applied")

img = Image.fromarray(arr)

# --- Georeference outputs (from the possibly-rebuilt transform T) ----------
def corner(px, py):
    X = T.a * px + T.b * py + T.c
    Y = T.d * px + T.e * py + T.f
    lng, lat = to4326.transform(X, Y)
    return [round(lng, 7), round(lat, 7)]

# MapLibre image-source order: [top-left, top-right, bottom-right, bottom-left]
corners = {"tl": corner(0, 0), "tr": corner(W, 0), "br": corner(W, H), "bl": corner(0, H)}
bearing = round(math.degrees(math.atan2(-T.b, -T.e)), 3)
inv = ~T
merc2px = [inv.a, inv.b, inv.c, inv.d, inv.e, inv.f]

maxdim = 6774  # ship native resolution (poster is 4202x6774) for crisp deep zoom
if max(img.size) > maxdim:
    s = maxdim / max(img.size)
    img = img.resize((round(img.width * s), round(img.height * s)), Image.LANCZOS)
img.save(OUT_IMG, quality=86, optimize=True)

meta = {
    "corners": corners,
    "bearing": bearing,          # poster "up" vs true north; used to orient the heading arrow
    "merc2px": merc2px,          # EPSG:3857 (X,Y) -> poster pixel
    "px": [W, H],
    "note": "Poster is pinned AXIS-ALIGNED in the app (always square). Real lng/lat "
            "are projected to EPSG:3857 then to pixel via `merc2px`, then to the "
            "display box, so overlays stay on-feature. `bearing` orients the compass/heading.",
    "source": os.path.basename(TIF),
}
json.dump(meta, open(OUT_JSON, "w"), indent=2)
print("image", img.size, "->", os.path.relpath(OUT_IMG, HERE))
print("bearing (deg from north):", bearing)
print(json.dumps(corners, indent=2))
