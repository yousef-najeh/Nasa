import io, urllib.request, numpy as np
from PIL import Image
from concurrent.futures import ThreadPoolExecutor

BASE=("https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02/"
      "1.0.0//default/default028mm/{z}/{r}/{c}.jpg")
Z=7; MW,MH=2**(Z+1),2**Z; deg=180.0/MH
# rows covering lat -90 .. -75
r0=int((90-(-75))/deg); rows=list(range(r0,MH))
cols=list(range(0,MW,MW//8))
def get(rc):
    r,c=rc
    try:
        with urllib.request.urlopen(BASE.format(z=Z,r=r,c=c),timeout=30) as f:
            return rc, np.array(Image.open(io.BytesIO(f.read())).convert("L"))
    except Exception as e:
        return rc, None
jobs=[(r,c) for r in rows for c in cols]
with ThreadPoolExecutor(16) as ex: res=dict(ex.map(get,jobs))
ok=sum(1 for v in res.values() if v is not None)
print(f"level {Z}, tile={deg:.4f} deg, rows {rows[0]}..{rows[-1]}, {ok}/{len(jobs)} tiles ok")
grid=np.zeros((len(rows)*256,len(cols)*256),np.uint8)
for i,r in enumerate(rows):
    for j,c in enumerate(cols):
        v=res[(r,c)]
        if v is not None: grid[i*256:(i+1)*256, j*256:(j+1)*256]=v
lat_lo=90-(rows[-1]+1)*deg; lat_hi=90-rows[0]*deg
print(f"lat span {lat_lo:.2f}..{lat_hi:.2f}")
print(f"brightness: mean={grid.mean():.1f} median={np.median(grid):.0f} "
      f"frac_black={(grid<12).mean()*100:.1f}% frac_blown={(grid>245).mean()*100:.1f}%")
Image.fromarray(grid).resize((len(cols)*256//2,len(rows)*256//2)).save("docs/wac_polar_sample_raw.png")
print("wrote docs/wac_polar_sample_raw.png", grid.shape)
