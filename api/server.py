"""Lunar South Pole Site Finder — HTTP API.

Three endpoints, layered:

  GET  /api/v1/site    one coordinate over a timeframe -> the measured facts
  POST /api/v1/assess  those facts + mission constraints -> suitable or not
  POST /api/v1/plan    a mission -> suggested locations and usable windows

The split is deliberate. /site reports what *is* true at a place and time and
takes no view on whether that is good. /assess applies a mission's limits to
that report. /plan runs both across the region to answer "where and when".
Keeping measurement separate from judgement means the same numbers can serve a
planner, an educator and a student without being quietly re-interpreted.

/plan is only affordable because horizon profiles are cached: the terrain
around a point does not change, so a new timeframe is arithmetic over a
Sun/Earth track rather than 31,417 fresh ray-marches.
"""

import sys
from datetime import datetime
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))

import batch            # noqa: E402
import ephem            # noqa: E402
import horizon as hz    # noqa: E402
import lola             # noqa: E402
import terrain_metrics as tm   # noqa: E402

app = FastAPI(
    title="Lunar South Pole Site Finder API",
    version="1.0",
    description=__doc__,
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DEFAULT_START = "2027-01-01T00:00:00"


class Store:
    """Everything loaded once at startup. The DEMs are memory-mapped, so the
    1.8 GB 20 m raster costs address space rather than RAM."""

    def __init__(self):
        ephem.load()
        self.dem, self.meta = lola.open_dem(
            ROOT / "data/lola/ldem_75s_120m.img",
            ROOT / "data/labels/ldem_75s_120m.lbl")
        self.meta["width"] = self.dem.shape[0]
        self.fine, self.fine_meta = lola.open_dem(
            ROOT / "data/lola/ldem_80s_20m.img",
            ROOT / "data/labels/ldem_80s_20m.lbl")

        cache = np.load(ROOT / "data/horizon_cache.npz")
        self.hor = cache["horizon"]
        self.grid_lat = cache["lat"]
        self.grid_lon = cache["lon"]
        self.grid_elev = cache["elev"]

        rec = np.load(ROOT / "data/screen_coarse.npy")
        self.psr = tm.psr_points(rec)
        self._pos_cache = {}

    def positions(self, start: str, days: float, step_hours: float):
        key = (start, round(days, 4), round(step_hours, 4))
        if key not in self._pos_cache:
            if len(self._pos_cache) > 24:
                self._pos_cache.clear()
            self._pos_cache[key] = hz.body_positions(start, days, step_hours)
        return self._pos_cache[key]


store: Store | None = None


@app.on_event("startup")
def _startup():
    global store
    store = Store()


# --------------------------------------------------------------------- models

class Timeframe(BaseModel):
    start: str = Field(DEFAULT_START, description="UTC ISO instant")
    days: float = Field(365.25, gt=0, le=3653, description="window length")
    step_hours: float = Field(1.0, gt=0, le=24)


class Constraints(BaseModel):
    """A mission's hard limits. Anything left None is not checked."""
    max_slope_deg: float | None = 15.0
    max_night_h: float | None = 400.0
    max_blackout_h: float | None = None
    min_sun_pct: float | None = None
    min_earth_pct: float | None = None
    max_psr_km: float | None = None
    max_roughness_m: float | None = None


class Weights(BaseModel):
    sun: float = 0.7
    night: float = 0.6
    comms: float = 0.6
    safety: float = 0.8
    smooth: float = 0.5
    isru: float = 0.5


MISSION_PROFILES = {
    "crewed":  (Weights(sun=0.9, night=1.0, comms=0.9, safety=1.0,
                        smooth=0.7, isru=0.3),
                Constraints(max_slope_deg=10, max_night_h=150,
                            max_blackout_h=120)),
    "robotic": (Weights(sun=0.8, night=0.5, comms=0.6, safety=0.8,
                        smooth=0.5, isru=1.0),
                Constraints(max_slope_deg=15, max_night_h=400)),
    "isru":    (Weights(sun=0.9, night=0.7, comms=0.5, safety=0.8,
                        smooth=0.5, isru=1.0),
                Constraints(max_slope_deg=12, max_night_h=300,
                            max_psr_km=5.0)),
}


class AssessRequest(BaseModel):
    lat: float
    lon: float
    timeframe: Timeframe = Timeframe()
    constraints: Constraints = Constraints()


class PlanRequest(BaseModel):
    timeframe: Timeframe = Timeframe()
    profile: Literal["crewed", "robotic", "isru", "custom"] = "robotic"
    constraints: Constraints | None = None
    weights: Weights | None = None
    limit: int = Field(20, ge=1, le=200)
    min_separation_km: float = Field(5.0, ge=0)


# ---------------------------------------------------------------- helpers

def _site_report(lat: float, lon: float, tf: Timeframe) -> dict:
    s = store
    if lat > -75.0:
        raise HTTPException(
            400, "Outside LOLA polar coverage: latitude must be <= -75.")

    hor, elev = hz.horizon_profile(s.dem, s.meta, lat, lon)
    pos = s.positions(tf.start, tf.days, tf.step_hours)
    exp = hz.exposure(hor, lat, lon, positions=pos)

    terrain = tm.slope_roughness(s.fine, s.fine_meta, lat, lon)
    psr_km, psr_lat, psr_lon = tm.nearest_psr_km(lat, lon, s.psr)

    return {
        "location": {"lat": lat, "lon": lon % 360.0, "elevation_m": round(float(elev), 1)},
        "timeframe": tf.model_dump(),
        "illumination": {
            "sun_pct": round(exp["sun_pct"], 2),
            "longest_night_h": round(exp["longest_night_h"], 1),
            "sun_max_elevation_deg": round(exp["sun_el_max"], 3),
        },
        "comms": {
            "earth_pct": round(exp["earth_pct"], 2),
            "longest_blackout_h": round(exp["longest_blackout_h"], 1),
            "earth_max_elevation_deg": round(exp["earth_el_max"], 3),
        },
        "terrain": None if terrain is None else {
            "slope_mean_deg": round(terrain["slope_deg"], 2),
            "slope_max_deg": round(terrain["slope_max_deg"], 2),
            "roughness_m": round(terrain["roughness_m"], 2),
            "baseline_m": terrain["baseline_m"],
            "box_m": terrain["box_m"],
        },
        "volatiles": {
            "nearest_psr_km": round(psr_km, 2),
            "nearest_psr": {"lat": round(psr_lat, 4), "lon": round(psr_lon, 3)},
        },
        "horizon": {
            "n_az": len(hor),
            "mean_deg": round(float(hor.mean()), 3),
            "max_deg": round(float(hor.max()), 3),
            "profile_deg": [round(float(v), 2) for v in hor],
        },
        "provenance": {
            "topography": "LOLA polar GDR 120 m (LRO), NASA PDS",
            "terrain_metrics": "LOLA polar GDR 20 m",
            "ephemeris": "NASA SPICE DE440, frame MOON_ME",
            "note": ("Slope at a 20 m baseline is a screening gate, not a "
                     "touchdown certification."),
        },
    }


def _check(report: dict, c: Constraints) -> dict:
    checks = []

    def add(name, value, limit, ok, unit=""):
        checks.append({"name": name, "value": value, "limit": limit,
                       "unit": unit, "pass": bool(ok)})

    t = report.get("terrain")
    if c.max_slope_deg is not None:
        if t is None:
            add("max slope", None, c.max_slope_deg, False, "deg")
        else:
            add("max slope", t["slope_max_deg"], c.max_slope_deg,
                t["slope_max_deg"] <= c.max_slope_deg, "deg")
    if c.max_roughness_m is not None and t is not None:
        add("roughness", t["roughness_m"], c.max_roughness_m,
            t["roughness_m"] <= c.max_roughness_m, "m")
    if c.max_night_h is not None:
        v = report["illumination"]["longest_night_h"]
        add("longest night", v, c.max_night_h, v <= c.max_night_h, "h")
    if c.min_sun_pct is not None:
        v = report["illumination"]["sun_pct"]
        add("solar exposure", v, c.min_sun_pct, v >= c.min_sun_pct, "%")
    if c.max_blackout_h is not None:
        v = report["comms"]["longest_blackout_h"]
        add("longest blackout", v, c.max_blackout_h, v <= c.max_blackout_h, "h")
    if c.min_earth_pct is not None:
        v = report["comms"]["earth_pct"]
        add("Earth visibility", v, c.min_earth_pct, v >= c.min_earth_pct, "%")
    if c.max_psr_km is not None:
        v = report["volatiles"]["nearest_psr_km"]
        add("distance to shadow", v, c.max_psr_km, v <= c.max_psr_km, "km")

    failed = [k for k in checks if not k["pass"]]
    return {
        "suitable": len(failed) == 0,
        "checks": checks,
        "failed": [f"{k['name']} {k['value']}{k['unit']} vs limit "
                   f"{k['limit']}{k['unit']}" for k in failed],
    }


def _normalise(v, lo, hi, higher_is_better):
    if v is None or hi == lo:
        return 0.0
    t = (v - lo) / (hi - lo)
    return float(np.clip(t if higher_is_better else 1 - t, 0, 1))


# -------------------------------------------------------------- endpoints

@app.get("/api/v1/site", summary="Measured conditions at one coordinate")
def get_site(
    lat: float = Query(..., le=-75.0, ge=-90.0),
    lon: float = Query(..., ge=-360.0, le=360.0),
    start: str = Query(DEFAULT_START),
    days: float = Query(365.25, gt=0, le=3653),
    step_hours: float = Query(1.0, gt=0, le=24),
    include_profile: bool = Query(False,
                                  description="include the 360-point horizon"),
):
    """What is true at this place over this window. No judgement applied."""
    tf = Timeframe(start=start, days=days, step_hours=step_hours)
    try:
        r = _site_report(lat, lon % 360.0, tf)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if not include_profile:
        r["horizon"].pop("profile_deg")
    return r


@app.post("/api/v1/assess", summary="Is this location suitable for a mission?")
def post_assess(req: AssessRequest):
    """Applies a mission's hard limits to the measured report."""
    r = _site_report(req.lat, req.lon % 360.0, req.timeframe)
    r["horizon"].pop("profile_deg", None)
    verdict = _check(r, req.constraints)
    return {"assessment": verdict, "site": r,
            "constraints": req.constraints.model_dump()}


@app.post("/api/v1/plan", summary="Where and when to fly a mission")
def post_plan(req: PlanRequest):
    """Scores the whole screened grid for this timeframe and mission, returns
    ranked locations with the windows that make each one workable."""
    s = store
    weights = req.weights
    constraints = req.constraints
    if req.profile != "custom":
        pw, pc = MISSION_PROFILES[req.profile]
        weights = weights or pw
        constraints = constraints or pc
    weights = weights or Weights()
    constraints = constraints or Constraints()

    tf = req.timeframe
    pos = s.positions(tf.start, tf.days, max(tf.step_hours, 3.0))
    g = batch.exposure_grid(s.hor, s.grid_lat, s.grid_lon, pos)

    # hard gates that can be applied grid-wide without the 20 m terrain pass
    keep = np.ones(len(s.grid_lat), dtype=bool)
    if constraints.max_night_h is not None:
        keep &= g["night_h"] <= constraints.max_night_h
    if constraints.min_sun_pct is not None:
        keep &= g["sun_pct"] >= constraints.min_sun_pct
    if constraints.max_blackout_h is not None:
        keep &= g["blackout_h"] <= constraints.max_blackout_h
    if constraints.min_earth_pct is not None:
        keep &= g["earth_pct"] >= constraints.min_earth_pct
    idx = np.flatnonzero(keep)
    if idx.size == 0:
        return {"count": 0, "sites": [],
                "note": "No screened point met the hard constraints.",
                "profile": req.profile, "timeframe": tf.model_dump()}

    sun, earth = g["sun_pct"][idx], g["earth_pct"][idx]
    night, black = g["night_h"][idx], g["blackout_h"][idx]
    score = (weights.sun * _norm_arr(sun, True)
             + weights.comms * _norm_arr(earth, True)
             + weights.night * _norm_arr(night, False)
             + 0.5 * weights.safety * _norm_arr(black, False))
    score /= (weights.sun + weights.comms + weights.night
              + 0.5 * weights.safety)

    order = idx[np.argsort(-score)]
    chosen = _spread(order, s.grid_lat, s.grid_lon, req.min_separation_km,
                     req.limit)

    sites = []
    for rank, i in enumerate(chosen, 1):
        lat, lon = float(s.grid_lat[i]), float(s.grid_lon[i])
        terrain = tm.slope_roughness(s.fine, s.fine_meta, lat, lon)
        if (constraints.max_slope_deg is not None and terrain is not None
                and terrain["slope_max_deg"] > constraints.max_slope_deg):
            continue
        psr_km, _, _ = tm.nearest_psr_km(lat, lon, s.psr)
        if constraints.max_psr_km is not None and psr_km > constraints.max_psr_km:
            continue
        sites.append({
            "rank": len(sites) + 1,
            "lat": round(lat, 5), "lon": round(lon, 4),
            "elevation_m": round(float(s.grid_elev[i]), 1),
            "sun_pct": round(float(g["sun_pct"][i]), 2),
            "earth_pct": round(float(g["earth_pct"][i]), 2),
            "longest_night_h": round(float(g["night_h"][i]), 1),
            "longest_blackout_h": round(float(g["blackout_h"][i]), 1),
            "slope_max_deg": None if terrain is None
                else round(terrain["slope_max_deg"], 2),
            "roughness_m": None if terrain is None
                else round(terrain["roughness_m"], 2),
            "nearest_psr_km": round(psr_km, 2),
            "windows": _windows(s.hor[i], lat, lon, pos, tf),
        })
        if len(sites) >= req.limit:
            break

    return {
        "count": len(sites),
        "screened": int(len(s.grid_lat)),
        "passed_hard_gates": int(idx.size),
        "profile": req.profile,
        "timeframe": tf.model_dump(),
        "weights": weights.model_dump(),
        "constraints": constraints.model_dump(),
        "sites": sites,
    }


def _norm_arr(v, higher_is_better):
    lo, hi = float(v.min()), float(v.max())
    if hi == lo:
        return np.zeros_like(v)
    t = (v - lo) / (hi - lo)
    return t if higher_is_better else 1 - t


def _spread(order, lat, lon, min_sep_km, limit):
    """Thin the ranking so the answer is not one hilltop listed twenty times."""
    if min_sep_km <= 0:
        return list(order[:limit * 3])
    R = ephem.MOON_R * 1000.0
    out, taken = [], []
    for i in order:
        la, lo_ = np.radians(lat[i]), np.radians(lon[i])
        rho = 2 * R * np.tan(np.pi / 4 + la / 2)
        x, y = rho * np.sin(lo_), rho * np.cos(lo_)
        if all((x - a) ** 2 + (y - b) ** 2 > (min_sep_km * 1000) ** 2
               for a, b in taken):
            taken.append((x, y))
            out.append(int(i))
        if len(out) >= limit * 3:
            break
    return out


def _windows(horizon, lat, lon, pos, tf, min_hours=24.0, top=4):
    """Continuous stretches with the Sun above the local skyline.

    These are the usable operating windows: when a solar-powered mission can
    work without drawing down a battery.
    """
    s = batch.exposure_series(horizon, lat, lon, pos)
    lit = s["sun"]["frac"] >= 0.5
    step = pos["step_hours"]
    runs, start = [], None
    for j, v in enumerate(lit):
        if v and start is None:
            start = j
        elif not v and start is not None:
            runs.append((start, j))
            start = None
    if start is not None:
        runs.append((start, len(lit)))

    ets = pos["ets"]
    import spiceypy as spice
    out = []
    for a, b in sorted(runs, key=lambda r: r[1] - r[0], reverse=True)[:top]:
        hours = (b - a) * step
        if hours < min_hours:
            continue
        out.append({
            "start": spice.et2utc(float(ets[a]), "ISOC", 0),
            "end": spice.et2utc(float(ets[min(b, len(ets) - 1)]), "ISOC", 0),
            "duration_h": round(hours, 1),
            "mean_earth_visible_pct": round(
                float(s["earth"]["frac"][a:b].mean() * 100), 1),
        })
    return out


@app.get("/api/v1/health")
def health():
    return {
        "ok": store is not None,
        "screened_points": int(len(store.grid_lat)) if store else 0,
        "psr_points": int(len(store.psr)) if store else 0,
        "kernels": ephem.KERNELS,
    }
