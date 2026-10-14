"""Turn LOLA GDRs into assets the web app can load directly.

Three grids, three jobs:
  - the global simple-cylindrical DEM gives the whole Moon a shape, so the
    viewer opens on a sphere rather than a floating polar disc;
  - the 120 m polar DEM carries the region we actually care about;
  - the 20 m polar DEM supersamples the shading (see detail.py).

Outputs:
  public/data/dem_global.bin       int16 DN, simple cylindrical, row-major
  public/data/dem_global.json
  public/data/dem_south.bin        int16 DN, polar stereographic, row-major
  public/data/dem_south.json
  public/data/hillshade_south.png  equirectangular RGBA, polar relief overlay
"""

import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import lola
from shade import relief, bilinear, reflectance, shadow_factor
from detail import fine_reflectance, splice

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data"

GLOBAL_SRC = "ldem_16"          # whole Moon, 16 ppd (~1.9 km/px)
TERRAIN_SRC = "ldem_75s_120m"   # geometry: 7624^2 @ 120 m/px
SHADE_SRC = "ldem_75s_120m"     # shading: same grid, matched to the texture
FINE_SRC = "ldem_80s_20m"       # supersample reflectance from 20 m where available
SHADE_LON, SHADE_LAT = 16384, 4096   # 4096 radial samples over 455 km = 111 m

# "realistic" renders regolith under a single Sun with cast shadows;
# "map" is the cartographic multidirectional hillshade.
STYLE = "realistic"
SUN_AZ, SUN_ELEV = 45.0, 12.0
ALBEDO = 0.136

# The polar overlay fades in across this latitude band so it blends into the
# WAC photographic base rather than ending on a hard circular edge.
FADE_OUT, FADE_IN = -79.0, -84.0


def load(name):
    arr, meta = lola.open_dem(ROOT / f"data/lola/{name}.img",
                              ROOT / f"data/labels/{name}.lbl")
    return arr, meta


def write_global():
    arr, meta = load(GLOBAL_SRC)
    h, w = arr.shape
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "dem_global.bin").write_bytes(np.asarray(arr, dtype="<i2").tobytes())
    (OUT / "dem_global.json").write_text(json.dumps({
        "source": GLOBAL_SRC,
        "width": w, "height": h,
        "scalingFactor": meta["scaling_factor"],
        "radius": meta["a_axis_km"] * 1000.0,
        # pixel centres: lat = (lineOffset - line) / resolution
        "lineOffset": meta["line_offset"],
        "sampleOffset": meta["sample_offset"],
        "resolution": h / 180.0,          # pixels per degree
    }, indent=2))
    print(f"dem_global.bin  {w}x{h} @ {180.0 / h:.4f} deg/px  "
          f"({(OUT / 'dem_global.bin').stat().st_size / 1e6:.1f} MB)")


def write_terrain():
    arr, meta = load(TERRAIN_SRC)
    n = arr.shape[0]
    z = arr.astype(np.float32) * meta["scaling_factor"]

    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / "dem_south.bin").write_bytes(np.asarray(arr, dtype="<i2").tobytes())
    (OUT / "dem_south.json").write_text(json.dumps({
        "source": TERRAIN_SRC,
        "width": n, "height": n,
        "mapScale": meta["map_scale"],
        "scalingFactor": meta["scaling_factor"],
        "radius": meta["a_axis_km"] * 1000.0,
        "halfWidth": n * meta["map_scale"] / 2.0,
        "minLat": meta["min_lat"], "maxLat": meta["max_lat"],
        "minElev": float(z.min()), "maxElev": float(z.max()),
    }, indent=2))
    print(f"dem_south.bin   {n}x{n} @ {meta['map_scale']:.0f} m/px  "
          f"({(OUT / 'dem_south.bin').stat().st_size / 1e6:.1f} MB)")


def write_hillshade():
    arr, meta = load(SHADE_SRC)
    n = arr.shape[0]
    px = meta["map_scale"]
    half = n * px / 2.0
    print(f"shading from {SHADE_SRC}: {n}x{n} @ {px:.0f} m/px")

    z = arr.astype(np.float32) * meta["scaling_factor"]
    if STYLE == "realistic":
        R = meta["a_axis_km"] * 1000.0
        print(f"  Sun az {SUN_AZ} deg, elev {SUN_ELEV} deg")
        refl = reflectance(z, px, SUN_AZ, SUN_ELEV, ALBEDO)

        if FINE_SRC:
            print(f"  supersampling reflectance from {FINE_SRC}")
            fa, fm = load(FINE_SRC)
            fine, fpx, fhalf = fine_reflectance(
                fa, fm, SUN_AZ, SUN_ELEV,
                factor=int(px // fm["map_scale"]), albedo=ALBEDO)
            splice(refl, px, half, fine, fpx, fhalf)
            del fa, fine

        print("  cast shadows")
        refl *= shadow_factor(z, px, SUN_AZ, SUN_ELEV, R)
        refl += ALBEDO * 0.025
        shade = np.clip(refl / ALBEDO, 0, 1).astype(np.float32)
        del refl
    else:
        shade = relief(z, px)

    lo, hi = np.percentile(z[::4, ::4], [1.0, 99.0])

    # equirectangular target grid -> projection plane -> source pixels
    lat = np.linspace(meta["min_lat"], meta["max_lat"], SHADE_LAT, dtype=np.float64)
    lon = np.linspace(0.0, 360.0, SHADE_LON, dtype=np.float64)
    out = np.empty((SHADE_LAT, SHADE_LON, 4), dtype=np.uint8)

    rows_per_chunk = 128
    for y0 in range(0, SHADE_LAT, rows_per_chunk):
        y1 = min(y0 + rows_per_chunk, SHADE_LAT)
        la = np.broadcast_to(lat[y0:y1, None], (y1 - y0, SHADE_LON))
        lo_ = np.broadcast_to(lon[None, :], (y1 - y0, SHADE_LON))
        x, y = lola.latlon_to_xy(la, lo_, meta)
        col = (x + half) / px
        row = (half - y) / px

        s = bilinear(shade, col, row)

        if STYLE == "realistic":
            # regolith is close to neutral, faintly warm; gamma to display
            v = np.power(np.clip(s, 0, 1), 1 / 2.2)[..., None]
            rgb = v * np.array([1.00, 0.985, 0.955], dtype=np.float32)
        else:
            e = bilinear(z, col, row)
            t = np.clip((e - lo) / (hi - lo), 0, 1).astype(np.float32)
            base = np.stack([0.50 + 0.46 * t, 0.51 + 0.42 * t, 0.55 + 0.33 * t], -1)
            rgb = np.clip(base * (0.07 + 0.94 * s[..., None]), 0, 1)

        out[y0:y1, :, :3] = (np.clip(rgb, 0, 1) * 255).astype(np.uint8)
        # smoothstep alpha: transparent at FADE_OUT, opaque by FADE_IN
        a = np.clip((FADE_OUT - la) / (FADE_OUT - FADE_IN), 0, 1)
        out[y0:y1, :, 3] = (a * a * (3 - 2 * a) * 255).astype(np.uint8)

    Image.fromarray(out[::-1], "RGBA").save(OUT / "hillshade_south.png",
                                            compress_level=6)
    print(f"hillshade_south.png {SHADE_LON}x{SHADE_LAT} RGBA "
          f"({(OUT / 'hillshade_south.png').stat().st_size / 1e6:.1f} MB)")


if __name__ == "__main__":
    steps = sys.argv[1:] or ["global", "terrain", "hillshade"]
    if "global" in steps:
        write_global()
    if "terrain" in steps:
        write_terrain()
    if "hillshade" in steps:
        write_hillshade()
