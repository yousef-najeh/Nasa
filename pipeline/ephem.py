"""Real Sun and Earth geometry at the lunar surface, from NASA SPICE.

Everything is computed in MOON_ME -- the Mean Earth / Polar Axis body-fixed
frame, which is what the LOLA products are tied to. Using MOON_PA instead
would be wrong by a few hundred metres on the ground.

The arbitrary Sun direction used for the Phase A renders is replaced by this:
given a UTC instant and a point on the surface, it returns where the Sun and
Earth actually are in that point's sky.
"""

import numpy as np
import spiceypy as spice
from pathlib import Path

KERNELS = ["naif0012.tls", "pck00011.tpc", "moon_pa_de440_200625.bpc",
           "moon_de440_250416.tf", "de440s.bsp"]

MOON_R = 1737.4            # km, the sphere the LOLA GDRs are referenced to
SUN_RADIUS_KM = 695700.0
EARTH_RADIUS_KM = 6371.0

_loaded = False


def load(kernel_dir=None):
    global _loaded
    if _loaded:
        return
    d = Path(kernel_dir or Path(__file__).resolve().parent.parent / "data/kernels")
    for k in KERNELS:
        spice.furnsh(str(d / k))
    _loaded = True


def surface_point(lat_deg, lon_deg, radius_km=MOON_R):
    """Body-fixed rectangular position of a surface point, in km."""
    return np.asarray(spice.latrec(radius_km,
                                   np.radians(lon_deg),
                                   np.radians(lat_deg)))


def enu_basis(lat_deg, lon_deg):
    """Local east/north/up unit vectors at a surface point, in MOON_ME."""
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    sl, cl = np.sin(lat), np.cos(lat)
    so, co = np.sin(lon), np.cos(lon)
    east = np.array([-so, co, 0.0])
    north = np.array([-sl * co, -sl * so, cl])
    up = np.array([cl * co, cl * so, sl])
    return east, north, up


def body_azel(body, utc, lat_deg, lon_deg, radius_km=MOON_R):
    """Azimuth (deg from north, clockwise), elevation (deg), range (km),
    and apparent angular radius (deg) of `body` as seen from a surface point."""
    load()
    et = spice.str2et(utc) if isinstance(utc, str) else utc
    # light-time + stellar aberration: we want where it *appears*
    pos, _ = spice.spkpos(body, et, "MOON_ME", "LT+S", "MOON")
    vec = np.asarray(pos) - surface_point(lat_deg, lon_deg, radius_km)

    east, north, up = enu_basis(lat_deg, lon_deg)
    e, n, u = vec @ east, vec @ north, vec @ up
    rng = np.linalg.norm(vec)

    az = np.degrees(np.arctan2(e, n)) % 360.0
    el = np.degrees(np.arcsin(u / rng))
    body_r = SUN_RADIUS_KM if body.upper() == "SUN" else EARTH_RADIUS_KM
    ang_r = np.degrees(np.arcsin(body_r / rng))
    return az, el, rng, ang_r


def sun_azel(utc, lat_deg, lon_deg, radius_km=MOON_R):
    az, el, _, ang = body_azel("SUN", utc, lat_deg, lon_deg, radius_km)
    return az, el, ang


def earth_azel(utc, lat_deg, lon_deg, radius_km=MOON_R):
    az, el, _, ang = body_azel("EARTH", utc, lat_deg, lon_deg, radius_km)
    return az, el, ang


def et_range(start_utc, days, step_hours):
    """Ephemeris times across a window, for time-stepped illumination."""
    load()
    et0 = spice.str2et(start_utc)
    n = int(days * 24 / step_hours) + 1
    return et0 + np.arange(n) * step_hours * 3600.0


def subsolar(utc):
    """Sub-solar lat/lon on the Moon, in MOON_ME."""
    load()
    et = spice.str2et(utc) if isinstance(utc, str) else utc
    point, _, _ = spice.subslr("NEAR POINT/ELLIPSOID", "MOON", et,
                               "MOON_ME", "LT+S", "SUN")
    _, lon, lat = spice.reclat(point)
    return np.degrees(lat), np.degrees(lon) % 360.0
