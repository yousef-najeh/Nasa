"""Precompute a horizon profile for every screened point.

The horizon around a point is fixed -- terrain does not move -- so it can be
computed once and reused for any mission window. That is the hinge the whole
API design turns on: with the horizons cached, evaluating a new timeframe is
arithmetic over a Sun/Earth track rather than a fresh ray-march, which takes a
200-second batch job down to something answerable in a request.
"""

import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import lola
import horizon as hz

ROOT = Path(__file__).resolve().parent.parent
DEM = "ldem_75s_120m"
N_AZ = 360


def build(rec, out=None, n_az=N_AZ, log=print):
    out = Path(out or ROOT / "data/horizon_cache.npz")
    arr, meta = lola.open_dem(ROOT / f"data/lola/{DEM}.img",
                              ROOT / f"data/labels/{DEM}.lbl")
    meta["width"] = arr.shape[0]

    n = len(rec)
    hor = np.empty((n, n_az), dtype=np.float32)
    elev = np.empty(n, dtype=np.float32)

    t0 = time.time()
    for i in range(n):
        h, z0 = hz.horizon_profile(arr, meta, rec["lat"][i], rec["lon"][i],
                                   n_az=n_az)
        hor[i] = h
        elev[i] = z0
        if i % 4000 == 0 and i:
            rate = i / (time.time() - t0)
            log(f"  {i}/{n}  {rate:.0f}/s  eta {(n - i) / rate:.0f}s")

    np.savez_compressed(out, horizon=hor, elev=elev,
                        lat=rec["lat"].astype(np.float32),
                        lon=rec["lon"].astype(np.float32), n_az=n_az)
    log(f"wrote {out.name}: {n} profiles x {n_az} az "
        f"({out.stat().st_size / 1e6:.1f} MB) in {time.time() - t0:.0f}s")
    return out


if __name__ == "__main__":
    rec = np.load(ROOT / "data/screen_coarse.npy")
    build(rec)
