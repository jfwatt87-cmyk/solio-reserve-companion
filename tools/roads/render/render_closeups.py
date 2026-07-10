#!/usr/bin/env python3
"""Contact sheet: one zoomed panel per unconfirmed crossing site (the 7),
join lines drawn on the artwork, coords in the header, how-to cell."""
from PIL import Image, ImageDraw, ImageFont
import json, math
from collections import defaultdict

ROOT = "/Users/jameswattwork/Work Docs 2026/Personal/Solio map app"
POC = f"{ROOT}/solio-poc"
OUT = f"{ROOT}/Callan Pack - Road Data 2026-07-09/5-crossings-closeup.png"
Image.MAX_IMAGE_PIXELS = None

meta = json.load(open(f"{POC}/src/assets/solio-truenorth.json"))
MA, MB, MC, MD, ME, MF = meta["merc2px"]
PW, PH = meta["px"]
PX_PER_M = math.hypot(MA, MD)

def w2p(lng, lat):
    mx = lng * 20037508.342789244 / 180.0
    my = math.log(math.tan((90 + lat) * math.pi / 360.0)) / math.pi * 20037508.342789244
    return (MA * mx + MB * my + MC, MD * mx + ME * my + MF)

joins = json.load(open(f"{POC}/tools/gis/Solio_Joins_Best_Guess.geojson"))["features"]
site_lines, site_pts, site_ok, site_ll = defaultdict(list), defaultdict(list), {}, {}
for f in joins:
    p = f["properties"]
    if not p.get("on_river"):
        continue
    s = p["site"]
    cs = f["geometry"]["coordinates"]
    if f["geometry"]["type"] == "Point":
        cs = [cs]
    site_lines[s].append([w2p(*c) for c in cs])
    site_pts[s].extend(w2p(*c) for c in cs)
    site_ll[s] = site_ll.get(s, []) + list(cs)
    site_ok[s] = site_ok.get(s, False) or bool(p.get("site_confirmed"))
cent = {s: (sum(x for x, _ in v) / len(v), sum(y for _, y in v) / len(v))
        for s, v in site_pts.items()}
cent_ll = {s: (sum(c[0] for c in v) / len(v), sum(c[1] for c in v) / len(v))
           for s, v in site_ll.items()}

TITLES = {"S05": "S05 — unnamed crossing, north-west",
          "S06": "S06 — Browns Bridge",
          "S16": "S16 — unnamed crossing, mid-reserve",
          "S18": "S18 — unnamed crossing, west arm",
          "S20": "S20 — unnamed crossing by JW Marriott",
          "S21": "S21 — Waterbuck Bridge?",
          "S22": "S22 — unnamed crossing by Main Gate"}
ORDER = ["S05", "S06", "S16", "S18", "S20", "S21", "S22"]

base_img = Image.open(f"{POC}/src/assets/solio-truenorth.jpg").convert("RGB")
bsx, bsy = base_img.width / PW, base_img.height / PH

def font(size, bold=True):
    for path, idx in [("/System/Library/Fonts/HelveticaNeue.ttc", 1 if bold else 0),
                      ("/System/Library/Fonts/Helvetica.ttc", 1 if bold else 0)]:
        try:
            return ImageFont.truetype(path, size, index=idx)
        except Exception:
            continue
    return ImageFont.load_default()

CELL_W, IMG_H, HDR = 980, 700, 128
YELLOW, GREEN = "#ffd23f", "#1e7d32"

def panel(s):
    cx, cy = cent[s]
    # window: at least ±280 m, grown to fit the site's own joins
    spread = max([math.hypot(x - cx, y - cy) for x, y in site_pts[s]] + [0])
    half_m = max(430, spread / PX_PER_M * 1.35 + 150)
    hw = half_m * PX_PER_M
    hh = hw * IMG_H / CELL_W
    x0, y0, x1, y1 = cx - hw, cy - hh, cx + hw, cy + hh
    K = CELL_W / (2 * hw)
    img = base_img.crop((int(x0 * bsx), int(y0 * bsy), int(x1 * bsx), int(y1 * bsy))).resize(
        (CELL_W, IMG_H), Image.LANCZOS)
    d = ImageDraw.Draw(img)
    def A(pt):
        return ((pt[0] - x0) * K, (pt[1] - y0) * K)
    # nearby proven sites for context
    for o, ok in site_ok.items():
        if not ok:
            continue
        ox, oy = cent[o]
        if x0 < ox < x1 and y0 < oy < y1:
            px, py = A((ox, oy))
            r = 22
            d.ellipse([px - r, py - r, px + r, py + r], fill=GREEN, outline="white", width=5)
            d.line([(px - 10, py + 1), (px - 2, py + 8), (px + 11, py - 8)], fill="white", width=6, joint="curve")
            d.text((px + r + 8, py), f"{o} · proven", font=font(30), fill=GREEN, anchor="lm",
                   stroke_width=3, stroke_fill="white")
    # the proposed join lines
    for L in site_lines[s]:
        pts = [A(p) for p in L]
        if len(pts) == 1:
            pts = [pts[0], (pts[0][0] + 1, pts[0][1] + 1)]
        d.line(pts, fill="#1a1a1a", width=16, joint="curve")
        d.line(pts, fill=YELLOW, width=8, joint="curve")
    # centre marker
    px, py = A((cx, cy))
    r = 30
    d.ellipse([px - r - 4, py - r - 4, px + r + 4, py + r + 4], fill="white")
    d.ellipse([px - r, py - r, px + r, py + r], fill=YELLOW, outline="#1a1a1a", width=5)
    d.text((px, py - 1), "?", font=font(38), fill="#1a1a1a", anchor="mm")
    # scale bar: 200 m
    bar = 200 * PX_PER_M * K
    bx, by = 30, IMG_H - 40
    d.line([(bx, by), (bx + bar, by)], fill="#1a1a1a", width=6)
    for e in (bx, bx + bar):
        d.line([(e, by - 10), (e, by + 10)], fill="#1a1a1a", width=6)
    d.text((bx + bar / 2, by - 18), "200 m", font=font(28), fill="#1a1a1a", anchor="mb",
           stroke_width=3, stroke_fill="white")
    # header
    cell = Image.new("RGB", (CELL_W, HDR + IMG_H), "#4a533b")
    cell.paste(img, (0, HDR))
    cd = ImageDraw.Draw(cell)
    cd.text((24, 38), TITLES[s], font=font(40), fill="#f4efe6", anchor="lm")
    lng, lat = cent_ll[s]
    cd.text((24, 92), f"{lat:.5f}, {lng:.5f}", font=font(30, bold=False),
            fill="#cfc9b8", anchor="lm")
    return cell

def howto():
    cell = Image.new("RGB", (CELL_W, HDR + IMG_H), "#f4efe6")
    cd = ImageDraw.Draw(cell)
    cd.rectangle([0, 0, CELL_W, HDR], fill="#4a533b")
    cd.text((24, 38), "How to answer — for each place", font=font(40), fill="#f4efe6", anchor="lm")
    lines = [
        ("", ""),
        ("YES", "there's a crossing here — we switch it on"),
        ("NO", "no crossing — we delete the join"),
        ("MOVE", "crossing exists but not here — mark roughly"),
        ("", "where (a scribble on this sheet is fine)"),
        ("", ""),
        ("", "Yellow line = the join we guessed from the"),
        ("", "printed map. Green ticks = crossings nearby"),
        ("", "already proven by our GPX drives."),
        ("", ""),
        ("", "Same ids (site field) in 4-joins-to-confirm."),
    ]
    y = HDR + 50
    for k, t in lines:
        if k:
            cd.text((40, y), k, font=font(38), fill="#b98029")
            cd.text((190, y), t, font=font(34, bold=False), fill="#2b2b26")
        elif t:
            cd.text((190, y), t, font=font(34, bold=False), fill="#2b2b26")
        y += 52
    return cell

cells = [panel(s) for s in ORDER] + [howto()]
GAP = 26
COLS = 2
rows = (len(cells) + COLS - 1) // COLS
TS = 150
W = COLS * CELL_W + (COLS + 1) * GAP
H = TS + rows * (HDR + IMG_H) + (rows + 1) * GAP
sheet = Image.new("RGB", (W, H), "#e9e4d7")
sd = ImageDraw.Draw(sheet)
sd.rectangle([0, 0, W, TS], fill="#4a533b")
sd.text((40, TS // 2), "The 7 crossings — close-ups for approval", font=font(66), fill="#f4efe6", anchor="lm")
sd.text((W - 40, TS // 2), "approve / delete / move each one", font=font(38, bold=False), fill="#cfc9b8", anchor="rm")
for i, c in enumerate(cells):
    r, col = divmod(i, COLS)
    sheet.paste(c, (GAP + col * (CELL_W + GAP), TS + GAP + r * (HDR + IMG_H + GAP)))
sheet = sheet.resize((1700, int(sheet.height * 1700 / sheet.width)), Image.LANCZOS)
sheet.save(OUT, optimize=True)
print("saved", OUT, sheet.size)
