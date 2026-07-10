#!/usr/bin/env python3
"""Re-render 1-road-layer-gaps.png as an action map on the app's true-north
basemap: delete / decide / reconnect / confirm, with the 7 crossings marked."""
from PIL import Image, ImageDraw, ImageFont
import json, math
from collections import defaultdict

ROOT = "/Users/jameswattwork/Work Docs 2026/Personal/Solio map app"
POC = f"{ROOT}/solio-poc"
OUT = f"{ROOT}/Callan Pack - Road Data 2026-07-09/1-road-layer-gaps.png"
Image.MAX_IMAGE_PIXELS = None

meta = json.load(open(f"{POC}/src/assets/solio-truenorth.json"))
MA, MB, MC, MD, ME, MF = meta["merc2px"]
PW, PH = meta["px"]

def w2p(lng, lat):  # WGS84 -> truenorth px via EPSG:3857 + merc2px affine
    mx = lng * 20037508.342789244 / 180.0
    my = math.log(math.tan((90 + lat) * math.pi / 360.0)) / math.pi * 20037508.342789244
    return (MA * mx + MB * my + MC, MD * mx + ME * my + MF)

# app-frame (2400x3601) -> world, for POI anchors (mirrors src/data/reserve.ts)
LNG0, LNG1, LAT0, LAT1, IW, IH = 36.849258, 37.002478, -0.090041, -0.305231, 2400, 3601
def app2p(x, y):
    return w2p(LNG0 + x / IW * (LNG1 - LNG0), LAT0 + y / IH * (LAT1 - LAT0))

fixes = json.load(open(f"{POC}/tools/gis/Solio_Roads_Suggested_Fixes.geojson"))["features"]
joins = json.load(open(f"{POC}/tools/gis/Solio_Joins_Best_Guess.geojson"))["features"]

lines = defaultdict(list)
points = defaultdict(list)
for f in fixes:
    p, g = f["properties"], f["geometry"]
    cat = p.get("fix") or p.get("type")
    if g["type"] == "LineString":
        lines[cat].append([w2p(*c) for c in g["coordinates"]])
    else:
        points[cat].append(w2p(*g["coordinates"]))

site_pts, site_ok = defaultdict(list), {}
for f in joins:
    p = f["properties"]
    if not p.get("on_river"):
        continue
    cs = f["geometry"]["coordinates"]
    if f["geometry"]["type"] == "Point":
        cs = [cs]
    site_pts[p["site"]].extend(w2p(*c) for c in cs)
    site_ok[p["site"]] = site_ok.get(p["site"], False) or bool(p.get("site_confirmed"))
sites = {s: (sum(x for x, _ in v) / len(v), sum(y for _, y in v) / len(v))
         for s, v in site_pts.items()}

# label, side (+1 right / -1 left), extra y-offset (canvas px, applied later)
SITE_LABEL = {"S05": ("S05", 1, 0), "S06": ("S06 · Browns Bridge", 1, 0),
              "S16": ("S16", 1, 0), "S18": ("S18", -1, 0),
              "S20": ("S20 · by JW Marriott", 1, 0),
              "S21": ("S21 · Waterbuck Bridge?", 1, 0),
              "S22": ("S22 · by Main Gate", 1, -70)}

# ---- canvas ----------------------------------------------------------------
xs = [x for L in sum(lines.values(), []) for x, _ in L] + [x for x, _ in sites.values()]
ys = [y for L in sum(lines.values(), []) for _, y in L] + [y for _, y in sites.values()]
cx0, cy0, cx1, cy1 = 62, 1328, 4168, 5432  # shared crop, both maps
OUTW = 2200
SS = 2
K = OUTW * SS / (cx1 - cx0)
CW, CH = int((cx1 - cx0) * K), int((cy1 - cy0) * K)

def A(pt):
    return ((pt[0] - cx0) * K, (pt[1] - cy0) * K)

base_img = Image.open(f"{POC}/src/assets/solio-truenorth.jpg").convert("RGB")
sx, sy = base_img.width / PW, base_img.height / PH
base = base_img.crop((int(cx0 * sx), int(cy0 * sy), int(cx1 * sx), int(cy1 * sy))).resize((CW, CH), Image.LANCZOS)
base = Image.blend(base, Image.new("RGB", (CW, CH), "white"), 0.42)
d = ImageDraw.Draw(base)

def font(size, bold=True):
    for path, idx in [("/System/Library/Fonts/HelveticaNeue.ttc", 1 if bold else 0),
                      ("/System/Library/Fonts/Helvetica.ttc", 1 if bold else 0)]:
        try:
            return ImageFont.truetype(path, size, index=idx)
        except Exception:
            continue
    return ImageFont.load_default()

def polyline(pts, colour, w):
    pts = [A(p) for p in pts]
    d.line(pts, fill="white", width=w + 10, joint="curve")
    d.line(pts, fill=colour, width=w, joint="curve")

RED, AMBER, PURPLE, BLUE, GREEN, YELLOW = "#d32f2f", "#e08a00", "#7b1fa2", "#1565c0", "#1e7d32", "#ffd23f"

for L in lines["remove_fence"]:
    polyline(L, RED, 14)
for L in lines["check_perimeter"]:
    polyline(L, AMBER, 16)
for L in lines["confirm_undrawn"]:
    polyline(L, PURPLE, 12)
for L in lines["missing_connection"]:
    polyline(L, BLUE, 20)
for x, y in points["dead_end"]:
    x, y = A((x, y))
    r = 34
    d.ellipse([x - r - 5, y - r - 5, x + r + 5, y + r + 5], outline="white", width=16)
    d.ellipse([x - r, y - r, x + r, y + r], outline=BLUE, width=10)

for s, ok in site_ok.items():
    if not ok:
        continue
    x, y = A(sites[s])
    r = 26
    d.ellipse([x - r, y - r, x + r, y + r], fill=GREEN, outline="white", width=6)
    d.line([(x - 12, y + 1), (x - 3, y + 10), (x + 13, y - 9)], fill="white", width=8, joint="curve")

fq, fl = font(52), font(46)
def halo_text(xy, text, fnt, fill="#1a1a1a", anchor="la"):
    x, y = xy
    for dx in (-3, 0, 3):
        for dy in (-3, 0, 3):
            d.text((x + dx, y + dy), text, font=fnt, fill="white", anchor=anchor)
    d.text((x, y), text, font=fnt, fill=fill, anchor=anchor)

for s, ok in sorted(site_ok.items()):
    if ok:
        continue
    x, y = A(sites[s])
    r = 44
    d.ellipse([x - r - 6, y - r - 6, x + r + 6, y + r + 6], fill="white")
    d.ellipse([x - r, y - r, x + r, y + r], fill=YELLOW, outline="#1a1a1a", width=7)
    d.text((x, y - 2), "?", font=fq, fill="#1a1a1a", anchor="mm")
    lbl, side, dy = SITE_LABEL[s]
    halo_text((x + side * (r + 22), y + dy), lbl, fl, anchor="lm" if side > 0 else "rm")

# ---- callouts --------------------------------------------------------------
fc = font(46)
def callout(anchor_px, text, box_off, align="left"):
    ax, ay = A(anchor_px)
    bx, by = ax + box_off[0], ay + box_off[1]
    ls = text.split("\n")
    wmax = max(d.textlength(t, font=fc) for t in ls)
    lh, pad = 58, 22
    x0, y0 = bx, by
    if align == "right":
        x0 = bx - wmax - 2 * pad
    x0 = min(max(20, x0), CW - wmax - 2 * pad - 20)
    y0 = min(max(20, y0), CH - lh * len(ls) - 2 * pad - 20)
    x1, y1 = x0 + wmax + 2 * pad, y0 + lh * len(ls) + 2 * pad - 10
    d.line([(ax, ay), ((x0 + x1) / 2, (y0 + y1) / 2)], fill="#1a1a1a", width=6)
    d.rounded_rectangle([x0, y0, x1, y1], radius=18, fill="white", outline="#1a1a1a", width=5)
    for i, t in enumerate(ls):
        d.text((x0 + pad, y0 + pad + i * lh), t, font=fc, fill="#1a1a1a")

def linelen(L):
    return sum(math.hypot(x2 - x1, y2 - y1) for (x1, y1), (x2, y2) in zip(L, L[1:]))
orph = max(lines["missing_connection"], key=linelen)
om = orph[len(orph) // 2]
callout(om, "Missing orphanage access (~800 m)\n— caused the 11 km routing", (170, 150))
callout(app2p(2044, 906), "Rhino Gate access: on the\nprinted map, not in the layer", (-160, 170), align="right")
callout(app2p(485, 2666), "Airstrip track: missing\nfrom every source", (-260, 240), align="right")

# ---- legend (empty SE corner) ----------------------------------------------
LG = [("line", RED,    "DELETE — fence in the layer as road (16 lines, ~25 km)"),
      ("line", AMBER,  "DECIDE — drawn as perimeter road: keep or delete (8, ~1.3 km)"),
      ("line", PURPLE, "DECIDE — in the layer, not on the printed map (28, ~34 km)"),
      ("line", BLUE,   "RECONNECT — near-miss gap (5)"),
      ("ring", BLUE,   "RECONNECT — dead end (17)"),
      ("q",    YELLOW, "CONFIRM — river crossing, the 7 places (file 4)"),
      ("tick", GREEN,  "Crossing already proven by our GPX drives (15)")]
flg = font(44)
lh = 76
wmax = max(d.textlength(t, font=flg) for _, _, t in LG)
pad = 30
LW, LH_ = 150 + wmax + pad, pad * 2 + lh * len(LG)
LX, LY = CW - LW - 50, CH - LH_ - 50
d.rounded_rectangle([LX, LY, LX + LW, LY + LH_], radius=24, fill="white", outline="#4a533b", width=6)
for i, (kind, col, txt) in enumerate(LG):
    cy = LY + pad + lh * i + lh // 2
    x0, x1 = LX + pad, LX + pad + 80
    if kind == "line":
        d.line([(x0, cy), (x1, cy)], fill=col, width=14)
    elif kind == "ring":
        m = (x0 + x1) // 2
        d.ellipse([m - 24, cy - 24, m + 24, cy + 24], outline=col, width=9)
    elif kind == "q":
        m = (x0 + x1) // 2
        d.ellipse([m - 30, cy - 30, m + 30, cy + 30], fill=col, outline="#1a1a1a", width=5)
        d.text((m, cy - 2), "?", font=font(38), fill="#1a1a1a", anchor="mm")
    elif kind == "tick":
        m = (x0 + x1) // 2
        d.ellipse([m - 24, cy - 24, m + 24, cy + 24], fill=col)
        d.line([(m - 11, cy + 1), (m - 3, cy + 9), (m + 12, cy - 8)], fill="white", width=7, joint="curve")
    d.text((LX + pad + 110, cy), txt, font=flg, fill="#2b2b26", anchor="lm")

# ---- title strip + downscale ----------------------------------------------
TS = 170
final = Image.new("RGB", (CW, CH + TS), "#4a533b")
final.paste(base, (0, TS))
fd = ImageDraw.Draw(final)
fd.text((50, TS // 2 - 8), "Roads layer — what needs fixing", font=font(84), fill="#f4efe6", anchor="lm")
fd.text((CW - 50, TS // 2 - 8), "colours match the fields in files 3 & 4", font=font(46, bold=False), fill="#cfc9b8", anchor="rm")

final = final.resize((OUTW, int(final.height * OUTW / final.width)), Image.LANCZOS)
final.save(OUT, optimize=True)
print("saved", OUT, final.size)
