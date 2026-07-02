# Rebuilds the leveled app basemap from the full-res GeoTIFF render, keeping the
# reserve terrain pixels byte-identical and rotating all margin text/artwork +
# on-map numbers to horizontal. See memory: solio-golden-rules. Run from repo root:
#   python solio-poc/tools/basemap/compose.py   (needs opencv-python, numpy)
import cv2, numpy as np, os
from PIL import Image
Image.MAX_IMAGE_PIXELS=None
HERE=os.path.dirname(os.path.abspath(__file__))
SP=HERE                                   # reserve-mask.npy + paper.npy live here
TIF=os.path.join(HERE,"..","..","..","SOLIO_MAP_FINAL.tif")   # raw georeferenced source
OUT=os.path.join(HERE,"..","..","src","assets","solio-basemap.jpg")
ANG=5.254
# input = full-res GeoTIFF render (the leveling must run on the RAW poster, not
# on an already-leveled basemap, or it will double-level).
O=cv2.cvtColor(np.array(Image.open(TIF).convert("RGB")),cv2.COLOR_RGB2BGR); H,W=O.shape[:2]
paper=np.load(f"{SP}/paper.npy"); M=np.load(f"{SP}/reserve-mask.npy").astype(np.uint8)
BROWN=(49,85,145)

def block_ink(x0,y0,x1,y1,thr=28):
    d=np.linalg.norm(O[y0:y1,x0:x1].astype(int)-paper,axis=2); mx=O[y0:y1,x0:x1].max(2)
    m=np.zeros((H,W),np.uint8); m[y0:y1,x0:x1]=((d>thr)&(mx>40)).astype(np.uint8)
    return m

BLOCKS=[
 # name, x0,y0,x1,y1, dx, over_map
 ("title",     900, 170,2120,1160, 0,0),
 ("compass",  3950, 540,4520,1110, 0,0),
 ("birds_tc", 2680, 630,3520,1010, 0,0),
 ("birds_l",  1200,1120,2400,1490, 0,0),
 ("birds_b2", 2260,4810,2780,5340, 0,0),
 ("bird_br",  3860,5110,4250,5440, 0,0),
 ("bridges",   380,3130,1185,3930, 0,1),
 ("dams",     2820,3280,3520,4095, 0,0),
 ("lodges",   2820,4110,3520,4700, 0,0),
 ("grass",    3560,2970,4600,4790, 0,0),
 ("legend",    210,5110,1130,6360, 0,0),
 ("scale",     120,6300,2090,6640, 0,0),
 ("rhinos",   2020,5360,3900,6610, 0,0),
 ("credits",  1280,6650,3720,6810, 0,0),
 ("rhino_gate",3760,1600,4210,1720, 0,0),
 ("airstrip",  740,5140,1180,5280, 0,1),
 ("main_gate", 800,5285,1260,5470, 0,1),
]

# terrain stamp, but NOT where block text overlaps it (so no tilted residue)
Md=cv2.dilate(M,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(23,23)))
allink=np.zeros((H,W),np.uint8)
for n,x0,y0,x1,y1,dx,om in BLOCKS: allink|=block_ink(x0,y0,x1,y1)
allink=cv2.dilate(allink,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(27,27)))
# over_map blocks fully own their bbox (erase+paste); never stamp inside them.
# ownzone (padded) excludes them from the stamp + letter-circle detection;
# ownink (tight) stops OTHER blocks from leveling their labels.
ownzone=np.zeros((H,W),np.uint8); ownink=np.zeros((H,W),np.uint8)
for n,x0,y0,x1,y1,dx,om in BLOCKS:
    if om:
        ownzone[y0-100:y1+100,x0-100:x1+100]=1
        ownink[y0:y1,x0:x1]=1
out=np.zeros_like(O); out[:]=paper
stamp=(Md>0)&(allink==0)&(ownzone==0)
out[stamp]=O[stamp]

def level_block(x0,y0,x1,y1,dx=0,dy=0,over_map=0,pad=100,thr=28):
    X0,Y0=max(0,x0-pad),max(0,y0-pad); X1,Y1=min(W,x1+pad),min(H,y1+pad)
    crop=O[Y0:Y1,X0:X1].copy()
    dist=np.linalg.norm(crop.astype(int)-paper,axis=2); mx=crop.max(2)
    ink=((dist>thr)&(mx>40)).astype(np.uint8)
    ink[:y0-Y0,:]=0; ink[y1-Y0:,:]=0; ink[:,:x0-X0]=0; ink[:,x1-X0:]=0
    if not over_map:            # don't level labels owned by an over_map block
        ink[ownink[Y0:Y1,X0:X1]>0]=0
    regMd=Md[Y0:Y1,X0:X1]
    # erase this block's ORIGINAL footprint first (kills ghosts/residue). For
    # margin blocks that's paper->paper; for over_map blocks it also clears the
    # tilted original off the reserve's pale edge.
    er=cv2.dilate(ink,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(21,21)))>0
    ermask=er if over_map else (er&(regMd==0))
    sub=out[Y0:Y1,X0:X1]; sub[ermask]=paper
    cx,cy=crop.shape[1]/2.0,crop.shape[0]/2.0
    Rm=cv2.getRotationMatrix2D((cx,cy),ANG,1.0); Rm[0,2]+=dx; Rm[1,2]+=dy
    rc=cv2.warpAffine(crop,Rm,(crop.shape[1],crop.shape[0]),borderValue=[float(v) for v in paper])
    ri=cv2.warpAffine(ink,Rm,(crop.shape[1],crop.shape[0]),flags=cv2.INTER_NEAREST)>0
    place=ri if over_map else (ri&(regMd==0))
    sub[place]=rc[place]; out[Y0:Y1,X0:X1]=sub

for n,x0,y0,x1,y1,dx,om in BLOCKS: level_block(x0,y0,x1,y1,dx=dx,over_map=om)

# on-map numbered circles: rotate digit in place.
# Real number circles have a bright CREAM interior + brown ring; filter out
# false Hough hits on rivers/tree-clumps so terrain is never disturbed.
gray=cv2.cvtColor(O,cv2.COLOR_BGR2GRAY)
circ=cv2.HoughCircles(gray,cv2.HOUGH_GRADIENT,dp=1.2,minDist=70,param1=110,param2=30,minRadius=16,maxRadius=34)
kept=[]
if circ is not None:
    for cx,cy,r in np.round(circ[0]).astype(int):
        if not(0<=cy<H and 0<=cx<W) or M[cy,cx]==0: continue
        if ownzone[cy,cx]: continue          # not the round letters of over-map text
        ri=max(4,r-7)
        ym,yM,xm,xM=cy-ri,cy+ri,cx-ri,cx+ri
        if ym<0 or xm<0 or yM>H or xM>W: continue
        inner=O[ym:yM,xm:xM].reshape(-1,3).astype(int)
        mask=((np.arange(2*ri)[:,None]-ri)**2+(np.arange(2*ri)[None,:]-ri)**2)<=ri*ri
        vals=inner[mask.reshape(-1)]
        mean=vals.mean(0); bright=mean.min()  # cream interior -> all channels high
        # ring darker than interior
        ann=O[cy-r-3:cy+r+3,cx-r-3:cx+r+3]
        if bright>188 and ann.size>0:
            kept.append((cx,cy,r))
nc=0
for cx,cy,r in kept:
    r2=r+6; x0,y0,x1,y1=cx-r2,cy-r2,cx+r2,cy+r2
    if x0<0 or y0<0 or x1>W or y1>H: continue
    patch=O[y0:y1,x0:x1].copy()
    Rm=cv2.getRotationMatrix2D((patch.shape[1]/2.0,patch.shape[0]/2.0),ANG,1.0)
    rp=cv2.warpAffine(patch,Rm,(patch.shape[1],patch.shape[0]),borderValue=[float(v) for v in paper])
    cm=np.zeros(patch.shape[:2],np.uint8); cv2.circle(cm,(patch.shape[1]//2,patch.shape[0]//2),r,1,-1)
    sub=out[y0:y1,x0:x1]; sub[cm>0]=rp[cm>0]; out[y0:y1,x0:x1]=sub; nc+=1
print("circles rotated:",nc)

for inset,th in [(58,7),(96,4)]:
    cv2.rectangle(out,(inset,inset),(W-1-inset,H-1-inset),BROWN,th)
L=170
for cxs,cys,sx,sy in [(58,58,1,1),(W-59,58,-1,1),(58,H-59,1,-1),(W-59,H-59,-1,-1)]:
    cv2.line(out,(cxs,cys),(cxs+sx*L,cys),BROWN,10); cv2.line(out,(cxs,cys),(cxs,cys+sy*L),BROWN,10)

cv2.imwrite(OUT,out,[cv2.IMWRITE_JPEG_QUALITY,92,cv2.IMWRITE_JPEG_OPTIMIZE,1])
cv2.imwrite(os.path.join(HERE,"leveled-preview.png"),cv2.resize(out,(945,1418)))
diff=np.abs(out.astype(int)-O.astype(int)).max(2)
# reserve INTERIOR (exclude the pale-edge label overlaps + rotated number circles)
interior=cv2.erode(M,cv2.getStructuringElement(cv2.MORPH_ELLIPSE,(9,9)))
prot=((interior>0)&(allink==0)).astype(np.uint8)
for cx,cy,r in kept: cv2.circle(prot,(cx,cy),r+8,0,-1)
print("reserve interior max diff:",int(diff[prot>0].max()),
      "| edge-label px changed:",int(((diff>0)&(M>0)).sum()))
