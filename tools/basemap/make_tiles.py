# Slice the true-north poster into an XYZ raster-tile pyramid for the app.
#
# WHY: the poster is 4202x6774 (28.5 MP). Shipping it as ONE MapLibre image
# source means a single giant GPU texture -> slow to decode on open and, worse,
# it exceeds the 4096px max-texture size most phone GPUs enforce. A tile pyramid
# loads only the visible tiles (instant pan/zoom), stays crisp on deep zoom, and
# every tile is 256px (well within any GPU limit).
#
# ACCURACY: the poster is displayed AXIS-ALIGNED, pinned to a synthetic display
# box (see ReserveMap.tsx BASE_COORDS). MapLibre draws the image FLAT between the
# box's four mercator corners. We reproduce that EXACTLY: give the poster a LINEAR
# EPSG:3857 transform matching the box's mercator rectangle and cut standard XYZ
# tiles from it (windowed resample, no warp). So a tile shows the same poster pixel
# at the same place the old image source did -> every GPS overlay (toDisplay) still
# lands on its drawn feature, to the pixel.
import os, json, math, shutil
from PIL import Image
from pyproj import Transformer

Image.MAX_IMAGE_PIXELS = None
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "src", "assets", "solio-truenorth.jpg")
META = os.path.join(HERE, "..", "..", "src", "assets", "solio-truenorth.json")
OUT = os.path.join(HERE, "..", "..", "public", "tiles")

ZOOM_MIN, ZOOM_MAX = 11, 16   # native detail ~3.6 m/px ≈ z15.4; z16 is the crisp ceiling
TILE = 256
QUALITY = 82
ORIGIN = 20037508.342789244   # half the web-mercator world extent (m)

# --- Reproduce ReserveMap.tsx's synthetic display box, exactly -------------
meta = json.load(open(META))
W, H = meta["px"]
m = meta["merc2px"]
MA, MB, MD, ME = m[0], m[1], m[3], m[4]
M_PER_PX_X = math.hypot(ME, MD) / abs(MA * ME - MB * MD)      # ~3.61 m/px
DEG_PER_PX = M_PER_PX_X / 110574
ANCHOR_LNG, ANCHOR_LAT = 36.85, -0.09
LNG_SPAN = (W * DEG_PER_PX) / math.cos(math.radians(ANCHOR_LAT))
LAT_SPAN = H * DEG_PER_PX
west, east = ANCHOR_LNG, ANCHOR_LNG + LNG_SPAN
north, south = ANCHOR_LAT, ANCHOR_LAT - LAT_SPAN

to3857 = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
minx, maxy = to3857.transform(west, north)
maxx, miny = to3857.transform(east, south)
print(f"box 4326: [{west:.6f},{south:.6f},{east:.6f},{north:.6f}]")
print(f"box 3857: [{minx:.2f},{miny:.2f},{maxx:.2f},{maxy:.2f}]  span {maxx-minx:.0f}x{maxy-miny:.0f} m")

img = Image.open(SRC).convert("RGB")
paper = img.getpixel((4, 4))  # cream corner -> fill for tile area outside the poster

def merc_x_to_px(mx):
    return (mx - minx) / (maxx - minx) * W
def merc_y_to_px(my):
    return (maxy - my) / (maxy - miny) * H  # y flips: north (maxy) -> pixel 0

if os.path.isdir(OUT):
    shutil.rmtree(OUT)

total = 0
for z in range(ZOOM_MIN, ZOOM_MAX + 1):
    tsm = 2 * ORIGIN / (2 ** z)                       # tile size in mercator metres
    x0 = int((minx + ORIGIN) / tsm)
    x1 = int((maxx - 1e-6 + ORIGIN) / tsm)
    y0 = int((ORIGIN - maxy) / tsm)                   # north edge -> smallest y (XYZ)
    y1 = int((ORIGIN - miny - 1e-6) / tsm)
    zcount = 0
    for xt in range(x0, x1 + 1):
        for yt in range(y0, y1 + 1):
            t_minx = -ORIGIN + xt * tsm
            t_maxx = t_minx + tsm
            t_maxy = ORIGIN - yt * tsm
            t_miny = t_maxy - tsm
            # This tile's footprint in source-pixel space.
            sx0, sx1 = merc_x_to_px(t_minx), merc_x_to_px(t_maxx)
            sy0, sy1 = merc_y_to_px(t_maxy), merc_y_to_px(t_miny)  # top,bottom
            # Overlap with the actual image [0,W]x[0,H].
            ox0, oy0 = max(sx0, 0.0), max(sy0, 0.0)
            ox1, oy1 = min(sx1, float(W)), min(sy1, float(H))
            if ox1 - ox0 < 0.5 or oy1 - oy0 < 0.5:
                continue                              # tile lies outside the poster
            tile = Image.new("RGB", (TILE, TILE), paper)
            crop = img.resize(
                (TILE, TILE), Image.LANCZOS,
                box=(sx0, sy0, sx1, sy1),             # sample the tile's footprint (may exceed image)
            ) if 0 <= sx0 and 0 <= sy0 and sx1 <= W and sy1 <= H else None
            if crop is not None:
                tile = crop
            else:
                # Partial-edge tile: place the resampled overlap onto the cream tile.
                spx = (sx1 - sx0) / TILE
                spy = (sy1 - sy0) / TILE
                sub_w = max(1, round((ox1 - ox0) / spx))
                sub_h = max(1, round((oy1 - oy0) / spy))
                sub = img.resize((sub_w, sub_h), Image.LANCZOS, box=(ox0, oy0, ox1, oy1))
                tile.paste(sub, (round((ox0 - sx0) / spx), round((oy0 - sy0) / spy)))
            d = os.path.join(OUT, str(z), str(xt))
            os.makedirs(d, exist_ok=True)
            tile.save(os.path.join(d, f"{yt}.jpg"), quality=QUALITY, optimize=True)
            zcount += 1
    total += zcount
    print(f"  z{z}: {zcount} tiles  (x {x0}..{x1}, y {y0}..{y1})")

# Size on disk
size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(OUT) for f in fs)
print(f"total {total} tiles, {size/1e6:.1f} MB -> {os.path.relpath(OUT, HERE)}")

# Emit the tile-source metadata the app needs (bounds + zoom range).
srcmeta = {
    "bounds": [round(west, 7), round(south, 7), round(east, 7), round(north, 7)],
    "minzoom": ZOOM_MIN,
    "maxzoom": ZOOM_MAX,
    "tileSize": TILE,
    "scheme": "xyz",
}
json.dump(srcmeta, open(os.path.join(HERE, "..", "..", "src", "assets", "tiles-meta.json"), "w"), indent=2)
print("wrote tiles-meta.json:", srcmeta)
