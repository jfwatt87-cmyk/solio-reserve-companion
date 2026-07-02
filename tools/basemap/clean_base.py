# Builds a clean, professional reserve-only basemap for the app:
#   * reserve terrain copied VERBATIM from the GeoTIFF (no inpaint smudges),
#   * the baked marginal text lists (BRIDGES/DAMS/... ) are excluded (they become
#     crisp app UI instead), transparent outside the reserve,
#   * cropped tight to the reserve, with the crop's WGS84 corners for MapLibre.
import cv2, numpy as np, os, json
from PIL import Image
Image.MAX_IMAGE_PIXELS=None
HERE=os.path.dirname(os.path.abspath(__file__))
TIF=os.path.join(HERE,"..","..","..","SOLIO_MAP_FINAL.tif")
OUT=os.path.join(HERE,"..","..","src","assets","solio-base-clean.png")
JSON=os.path.join(HERE,"..","..","src","assets","solio-base-clean.json")

O=cv2.cvtColor(np.array(Image.open(TIF).convert("RGB")),cv2.COLOR_RGB2BGR)
H,W=O.shape[:2]
M=np.load(os.path.join(HERE,"reserve-mask.npy")).astype(np.uint8)

# The BRIDGES list's right-hand words poke onto the reserve's pale western edge.
# Inpaint just those brown letters (not the grey roads / dark boundary) so the
# clean basemap has no stray text.
b,g,r=O[:,:,0].astype(int),O[:,:,1].astype(int),O[:,:,2].astype(int)
brown=(r>g+12)&(g>b+3)&(r>60)&(r<185)
box=np.zeros((H,W),bool); box[3120:3970,840:1270]=True
tmask=((brown)&box&(M>0)).astype(np.uint8)
tmask=cv2.dilate(tmask,np.ones((7,7),np.uint8))
O=cv2.inpaint(O,tmask,6,cv2.INPAINT_TELEA)

# full-image georeference corners (from data/reserve.ts CONTROL_POINTS)
WEST,EAST,NORTH,SOUTH=36.849258,37.002478,-0.090041,-0.305231

# soft alpha: reserve interior opaque, feathered edge, transparent beyond
alpha=cv2.GaussianBlur((M*255).astype(np.uint8),(0,0),3)
ys,xs=np.where(M>0)
pad=30
x0,x1=max(0,xs.min()-pad),min(W,xs.max()+pad)
y0,y1=max(0,ys.min()-pad),min(H,ys.max()+pad)
crop=O[y0:y1,x0:x1]; ca=alpha[y0:y1,x0:x1]
rgba=cv2.cvtColor(crop,cv2.COLOR_BGR2BGRA); rgba[:,:,3]=ca
cv2.imwrite(OUT,rgba)

def lng(x): return WEST+(x/W)*(EAST-WEST)
def lat(y): return NORTH+(y/H)*(SOUTH-NORTH)
corners={
 "bbox":[int(x0),int(y0),int(x1),int(y1)],
 "corners":{"nw":[lng(x0),lat(y0)],"ne":[lng(x1),lat(y0)],
            "se":[lng(x1),lat(y1)],"sw":[lng(x0),lat(y1)]}}
json.dump(corners,open(JSON,"w"))
print("clean base",x1-x0,"x",y1-y0,"->",OUT)
print(json.dumps(corners["corners"]))
