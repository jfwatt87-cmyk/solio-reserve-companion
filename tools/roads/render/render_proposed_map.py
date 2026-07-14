#!/usr/bin/env python3
"""'The map we believe is right': v2 network as the definitive layer, the 7
proposed crossings flagged, GIS-only tracks pending, judgements in the legend."""
from PIL import Image, ImageDraw, ImageFont
import json, math
from collections import defaultdict

ROOT = "/Users/jameswattwork/Work Docs 2026/Personal/Solio map app"
POC = f"{ROOT}/solio-poc"
OUT = f"{ROOT}/Solio Roads V2 — Proposed Map.png"
Image.MAX_IMAGE_PIXELS = None

meta = json.load(open(f"{POC}/src/assets/solio-truenorth.json"))
MA, MB, MC, MD, ME, MF = meta["merc2px"]
PW, PH = meta["px"]

def w2p(lng, lat):
    mx = lng * 20037508.342789244 / 180.0
    my = math.log(math.tan((90 + lat) * math.pi / 360.0)) / math.pi * 20037508.342789244
    return (MA * mx + MB * my + MC, MD * mx + ME * my + MF)

LNG0, LNG1, LAT0, LAT1, IW, IH = 36.849258, 37.002478, -0.090041, -0.305231, 2400, 3601
def app2p(x, y):
    return w2p(LNG0 + x / IW * (LNG1 - LNG0), LAT0 + y / IH * (LAT1 - LAT0))

v2 = json.load(open(f"{POC}/tools/gis/Solio_Roads_V2_WGS84.geojson"))["features"]
fixes = json.load(open(f"{POC}/tools/gis/Solio_Roads_Suggested_Fixes.geojson"))["features"]
joins = json.load(open(f"{POC}/tools/gis/Solio_Joins_Best_Guess.geojson"))["features"]

# Three buckets, not two. Anything that isn't `ok` must be visibly NOT a normal
# road — bucketing the Marriotts private road with roads_ok would draw a road
# guests must never be sent down in the same orange as one they should. (D80)
roads_ok, roads_unc, roads_priv = [], [], []
for f in v2:
    L = [w2p(*c) for c in f["geometry"]["coordinates"]]
    st = f["properties"]["status"]
    (roads_unc if st == "unconfirmed_crossing"
     else roads_priv if st == "private_no_guest_routing"
     else roads_ok).append(L)
undrawn = [[w2p(*c) for c in f["geometry"]["coordinates"]]
           for f in fixes if f["properties"].get("fix") == "confirm_undrawn"]

site_pts, site_ok, site_private = defaultdict(list), {}, set()
for f in joins:
    p = f["properties"]
    if not p.get("on_river"):
        continue
    cs = f["geometry"]["coordinates"]
    if f["geometry"]["type"] == "Point":
        cs = [cs]
    site_pts[p["site"]].extend(w2p(*c) for c in cs)
    site_ok[p["site"]] = site_ok.get(p["site"], False) or bool(p.get("site_confirmed"))
    # "confirmed" and "guests may drive it" are different claims. S18/S20 are
    # confirmed real AND closed — a green tick there would read as "all good"
    # on the one road we must never route a guest down.
    if p.get("guest_routable") is False and p.get("access") == "private":
        site_private.add(p["site"])
sites = {s: (sum(x for x, _ in v) / len(v), sum(y for _, y in v) / len(v))
         for s, v in site_pts.items()}

cx0, cy0, cx1, cy1 = 62, 1328, 4168, 5432  # shared crop, matches the pack maps
OUTW = 2200
SS = 2
K = OUTW * SS / (cx1 - cx0)
CW, CH = int((cx1 - cx0) * K), int((cy1 - cy0) * K)

def A(pt):
    return ((pt[0] - cx0) * K, (pt[1] - cy0) * K)

base_img = Image.open(f"{POC}/src/assets/solio-truenorth.jpg").convert("RGB")
bsx, bsy = base_img.width / PW, base_img.height / PH
base = base_img.crop((int(cx0 * bsx), int(cy0 * bsy), int(cx1 * bsx), int(cy1 * bsy))).resize((CW, CH), Image.LANCZOS)
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

ORANGE, YELLOW, PURPLE, GREEN = "#e2571b", "#f5a800", "#7b1fa2", "#1e7d32"
RED = "#c62828"   # private / closed to guests — never a route

def dashed(pts, colour, w, dash=34, gap=26, casing=None):
    # walk the polyline emitting dash segments
    segs = []
    dist_on, drawing, carry = 0.0, True, 0.0
    cur = [pts[0]]
    for (x1, y1), (x2, y2) in zip(pts, pts[1:]):
        seg = math.hypot(x2 - x1, y2 - y1)
        t = 0.0
        while t < seg:
            step = (dash if drawing else gap) - carry
            if t + step >= seg:
                carry += seg - t
                if drawing:
                    cur.append((x2, y2))
                t = seg
            else:
                t += step
                px, py = x1 + (x2 - x1) * t / seg, y1 + (y2 - y1) * t / seg
                if drawing:
                    cur.append((px, py))
                    segs.append(cur)
                    cur = []
                else:
                    cur = [(px, py)]
                drawing = not drawing
                carry = 0.0
    if drawing and len(cur) > 1:
        segs.append(cur)
    for sgm in segs:
        if casing:
            d.line(sgm, fill=casing, width=w + 8, joint="curve")
    for sgm in segs:
        d.line(sgm, fill=colour, width=w, joint="curve")

# GIS-only tracks first (underneath), then the network
for L in undrawn:
    dashed([A(p) for p in L], PURPLE, 8, casing="white")
for L in roads_ok:
    pts = [A(p) for p in L]
    d.line(pts, fill="white", width=15, joint="curve")
for L in roads_ok:
    pts = [A(p) for p in L]
    d.line(pts, fill=ORANGE, width=7, joint="curve")
for L in roads_unc:
    pts = [A(p) for p in L]
    d.line(pts, fill="white", width=20, joint="curve")
    d.line(pts, fill=YELLOW, width=12, joint="curve")
# private road: drawn (it exists, and Callan's GIS should show it) but dashed red
# so it can never be mistaken for a road the app will send a guest along
for L in roads_priv:
    dashed([A(p) for p in L], RED, 11, casing="white")

# crossing markers
fq = font(44)
fid = font(38)
for s, c in sites.items():
    ok = site_ok[s]
    x, y = A(c)
    if s in site_private:
        # confirmed, but closed: a "no entry" bar, never a tick
        r = 26
        d.ellipse([x - r - 5, y - r - 5, x + r + 5, y + r + 5], fill="white")
        d.ellipse([x - r, y - r, x + r, y + r], fill=RED, outline="white", width=5)
        d.line([(x - 13, y), (x + 13, y)], fill="white", width=8)
    elif ok:
        r = 24
        d.ellipse([x - r, y - r, x + r, y + r], fill=GREEN, outline="white", width=6)
        d.line([(x - 11, y + 1), (x - 3, y + 9), (x + 12, y - 8)], fill="white", width=7, joint="curve")
    else:
        r = 38
        d.ellipse([x - r - 5, y - r - 5, x + r + 5, y + r + 5], fill="white")
        d.ellipse([x - r, y - r, x + r, y + r], fill=YELLOW, outline="#1a1a1a", width=6)
        d.text((x, y - 2), "?", font=fq, fill="#1a1a1a", anchor="mm")
        side = -1 if x > CW * 0.62 else 1
        for dx in (-3, 0, 3):
            for dy in (-3, 0, 3):
                d.text((x + side * (r + 18) + dx, y + dy), s, font=fid, fill="white",
                       anchor="lm" if side > 0 else "rm")
        d.text((x + side * (r + 18), y), s, font=fid, fill="#1a1a1a",
               anchor="lm" if side > 0 else "rm")

# callouts
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

callout(app2p(601, 2671), "Orphanage & gate river roads restored\n— gate to orphanage now 2.4 km", (190, 60))
callout(app2p(2044, 906), "Rhino Gate access restored", (-160, 170), align="right")
callout(app2p(485, 2666), "Airstrip track still missing —\nthe one road no source has", (-280, 250), align="right")

# legend
# counts derived, not typed — a hand-written "7 places" went stale the day Callan
# answered, and a stale legend on a map called "the map we believe is right" is
# worse than no legend
n_green = sum(1 for s in sites if site_ok.get(s) and s not in site_private)
n_amber = sum(1 for s in sites if not site_ok.get(s) and s not in site_private)
n_red = len(site_private)
LG = [("line",  ORANGE, "Roads — traced from the printed map, GPX-checked (~249 km)"),
      ("tick",  GREEN,  f"Crossings confirmed ({n_green}) — our GPX drives + Solio, 14 Jul"),
      ("thick", YELLOW, f"Crossings unconfirmed ({n_amber}) — the app will not route over these"),
      ("priv",  RED,    f"Marriotts private road ({n_red} crossings) — closed to guests, Solio's call"),
      ("dash",  PURPLE, "In GIS only (~34 km) — management tracks unless told otherwise"),
      ("none",  None,   "Fence excluded everywhere — it is not a road")]
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
        d.line([(x0, cy), (x1, cy)], fill=col, width=10)
    elif kind == "thick":
        d.line([(x0, cy), (x1, cy)], fill=col, width=16)
        m = (x0 + x1) // 2
        d.ellipse([m - 22, cy - 22, m + 22, cy + 22], fill=col, outline="#1a1a1a", width=4)
        d.text((m, cy - 1), "?", font=font(30), fill="#1a1a1a", anchor="mm")
    elif kind == "tick":
        m = (x0 + x1) // 2
        d.ellipse([m - 24, cy - 24, m + 24, cy + 24], fill=col)
        d.line([(m - 11, cy + 1), (m - 3, cy + 9), (m + 12, cy - 8)], fill="white", width=7, joint="curve")
    elif kind == "priv":
        for a_, b_ in [(x0, x0 + 22), (x0 + 34, x0 + 56)]:
            d.line([(a_, cy), (b_, cy)], fill=col, width=9)
        m = x1 + 4
        d.ellipse([m - 20, cy - 20, m + 20, cy + 20], fill=col, outline="white", width=4)
        d.line([(m - 10, cy), (m + 10, cy)], fill="white", width=6)
    elif kind == "dash":
        for a_, b_ in [(x0, x0 + 26), (x0 + 42, x0 + 68)]:
            d.line([(a_, cy), (b_, cy)], fill=col, width=8)
    d.text((LX + pad + 110, cy), txt, font=flg, fill="#2b2b26", anchor="lm")

TS = 170
final = Image.new("RGB", (CW, CH + TS), "#4a533b")
final.paste(base, (0, TS))
fd = ImageDraw.Draw(final)
fd.text((50, TS // 2 - 8), "The road map we believe is right", font=font(84), fill="#f4efe6", anchor="lm")
fd.text((CW - 50, TS // 2 - 8), "printed map + GPX drives + GIS layer, reconciled", font=font(46, bold=False), fill="#cfc9b8", anchor="rm")

final = final.resize((OUTW, int(final.height * OUTW / final.width)), Image.LANCZOS)
final.save(OUT, optimize=True)
print("saved", OUT, final.size)
