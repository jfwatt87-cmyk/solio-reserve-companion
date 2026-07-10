#!/usr/bin/env python3
"""Re-render 2-network-from-artwork.png: the shipped road network (orange)
on the true-north basemap, same style as map 1."""
from PIL import Image, ImageDraw, ImageFont
import json, math, re

ROOT = "/Users/jameswattwork/Work Docs 2026/Personal/Solio map app"
POC = f"{ROOT}/solio-poc"
OUT = f"{ROOT}/Callan Pack - Road Data 2026-07-09/2-network-from-artwork.png"
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

src = open(f"{POC}/src/data/roads.gis.ts").read()
nodes = {m.group(1): (float(m.group(2)), float(m.group(3)))
         for m in re.finditer(r'\{ id: "([^"]+)", pixel: \{ x: ([\d.]+), y: ([\d.]+) \} \}', src)}
edges = []
for m in re.finditer(r'\{\s*a: "([^"]+)",\s*b: "([^"]+)",(.*?)\n  \},', src, re.S):
    a, b, body = m.group(1), m.group(2), m.group(3)
    via = [(float(x), float(y)) for x, y in re.findall(r"\{ x: ([\d.]+), y: ([\d.]+) \}", body)]
    edges.append([app2p(*nodes[a]), *[app2p(*v) for v in via], app2p(*nodes[b])])
print(f"{len(nodes)} nodes, {len(edges)} edges")

xs = [x for E in edges for x, _ in E]
ys = [y for E in edges for _, y in E]
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

ORANGE = "#e2571b"
for E in edges:
    pts = [A(p) for p in E]
    d.line(pts, fill="white", width=16, joint="curve")
for E in edges:
    pts = [A(p) for p in E]
    d.line(pts, fill=ORANGE, width=8, joint="curve")

def font(size, bold=True):
    for path, idx in [("/System/Library/Fonts/HelveticaNeue.ttc", 1 if bold else 0),
                      ("/System/Library/Fonts/Helvetica.ttc", 1 if bold else 0)]:
        try:
            return ImageFont.truetype(path, size, index=idx)
        except Exception:
            continue
    return ImageFont.load_default()

TS = 170
final = Image.new("RGB", (CW, CH + TS), "#4a533b")
final.paste(base, (0, TS))
fd = ImageDraw.Draw(final)
fd.text((50, TS // 2 - 8), "Where the app can navigate — traced from the printed map", font=font(84), fill="#f4efe6", anchor="lm")
fd.text((CW - 50, TS // 2 - 8), "the app's current road network", font=font(46, bold=False), fill="#cfc9b8", anchor="rm")

final = final.resize((OUTW, int(final.height * OUTW / final.width)), Image.LANCZOS)
final.save(OUT, optimize=True)
print("saved", OUT, final.size)
