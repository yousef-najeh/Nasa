"""Vectorised Sun/Earth exposure over many sites at once.

The per-site path in horizon.py is fine for a handful of points but far too
slow to answer a request across the whole grid. This evaluates every cached
horizon against a Sun/Earth track in a few array operations.

Sites are processed in chunks: the full intermediate for 31k sites against a
year of hourly steps is several GB, while a chunk of a couple of thousand fits
comfortably in cache.
"""

import numpy as np

import ephem


def enu_bases(lat_deg, lon_deg):
    """East/north/up basis vectors for many sites. Shape (n, 3) each."""
    lat = np.radians(np.asarray(lat_deg, dtype=np.float64))
    lon = np.radians(np.asarray(lon_deg, dtype=np.float64))
    sl, cl = np.sin(lat), np.cos(lat)
    so, co = np.sin(lon), np.cos(lon)
    east = np.stack([-so, co, np.zeros_like(so)], axis=1)
    north = np.stack([-sl * co, -sl * so, cl], axis=1)
    up = np.stack([cl * co, cl * so, sl], axis=1)
    return east, north, up


def _visible_fraction(el, hor, ang):
    """Fraction of a disc of angular radius `ang` clearing the horizon."""
    return np.clip((el - hor + ang) / (2.0 * ang), 0.0, 1.0)


def _longest_run(mask, step_hours):
    """Longest run of True along axis 1, in hours. mask: (n, t) bool."""
    n, t = mask.shape
    best = np.zeros(n, dtype=np.int32)
    cur = np.zeros(n, dtype=np.int32)
    for j in range(t):
        col = mask[:, j]
        cur = np.where(col, cur + 1, 0)
        np.maximum(best, cur, out=best)
    return best.astype(np.float32) * step_hours


def exposure_grid(horizons, lats, lons, positions, radius_m=None,
                  lit_threshold=0.5, chunk=2048):
    """Sun and Earth exposure for every site against one time window.

    horizons : (n, n_az) float32, obstruction elevation per azimuth
    positions: dict from horizon.body_positions

    Returns a dict of (n,) arrays.
    """
    n, n_az = horizons.shape
    step_h = positions["step_hours"]
    r_m = radius_m if radius_m is not None else ephem.MOON_R * 1000.0
    sun_km, earth_km = positions["sun"], positions["earth"]

    out = {k: np.empty(n, dtype=np.float32) for k in
           ("sun_pct", "earth_pct", "night_h", "blackout_h")}

    for a in range(0, n, chunk):
        b = min(a + chunk, n)
        east, north, up = enu_bases(lats[a:b], lons[a:b])
        # site positions on the reference sphere, km
        site = up * (r_m / 1000.0)

        res = {}
        for name, body_km, body_r in (("sun", sun_km, ephem.SUN_RADIUS_KM),
                                      ("earth", earth_km, ephem.EARTH_RADIUS_KM)):
            # (chunk, t, 3): vector from each site to the body at each step
            vec = body_km[None, :, :] - site[:, None, :]
            rng = np.linalg.norm(vec, axis=2)
            e = np.einsum("ctj,cj->ct", vec, east)
            nn = np.einsum("ctj,cj->ct", vec, north)
            u = np.einsum("ctj,cj->ct", vec, up)
            del vec

            az = np.degrees(np.arctan2(e, nn)) % 360.0
            el = np.degrees(np.arcsin(np.clip(u / rng, -1, 1)))
            ang = np.degrees(np.arcsin(body_r / rng))
            del e, nn, u, rng

            idx = (np.round(az * (n_az / 360.0)).astype(np.int32)) % n_az
            hor = np.take_along_axis(horizons[a:b], idx, axis=1)
            res[name] = _visible_fraction(el, hor, ang)
            del az, el, ang, idx, hor

        out["sun_pct"][a:b] = res["sun"].mean(axis=1) * 100.0
        out["earth_pct"][a:b] = res["earth"].mean(axis=1) * 100.0
        out["night_h"][a:b] = _longest_run(res["sun"] < lit_threshold, step_h)
        out["blackout_h"][a:b] = _longest_run(res["earth"] < lit_threshold, step_h)
        del res

    return out


def exposure_series(horizon, lat, lon, positions, radius_m=None):
    """Per-timestep visible fraction for a single site -- for charts and
    for finding usable mission windows."""
    n_az = len(horizon)
    r_m = radius_m if radius_m is not None else ephem.MOON_R * 1000.0
    east, north, up = enu_bases([lat], [lon])
    site = up[0] * (r_m / 1000.0)

    series = {}
    for name, body_km, body_r in (("sun", positions["sun"], ephem.SUN_RADIUS_KM),
                                  ("earth", positions["earth"],
                                   ephem.EARTH_RADIUS_KM)):
        vec = body_km - site
        rng = np.linalg.norm(vec, axis=1)
        az = np.degrees(np.arctan2(vec @ east[0], vec @ north[0])) % 360.0
        el = np.degrees(np.arcsin(np.clip((vec @ up[0]) / rng, -1, 1)))
        ang = np.degrees(np.arcsin(body_r / rng))
        idx = (np.round(az * (n_az / 360.0)).astype(np.int32)) % n_az
        series[name] = {
            "az": az, "el": el,
            "frac": _visible_fraction(el, horizon[idx], ang),
        }
    return series
