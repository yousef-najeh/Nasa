"""Landing-safety metrics: slope, roughness, and distance to permanent shadow.

Criteria 4-6 of the scoring model. Without these the tool will happily
recommend a brilliantly-lit ridge crest that no lander can set down on.

Slope and roughness come from the 20 m polar DEM -- the finest LOLA product
covering 80-90S. Note that 20 m is still coarse against what actually matters
for touchdown: Artemis-class landers care about slope over ~5-15 m baselines,
which needs the LOLA+NAC DTMs. What is computed here is a real, defensible
screening gate, not a touchdown certification.

Permanently shadowed regions are derived from our own illumination run rather
than imported: a PSR is simply a point the Sun never reaches, which the
screening pass already determines for every candidate.
"""

import numpy as np


def patch(dem, meta, lat_deg, lon_deg, half_px, R=None):
    """Square patch of the polar grid centred on a site, in metres."""
    R = R or meta["a_axis_km"] * 1000.0
    px = meta["map_scale"]
    n = dem.shape[0]
    half = n * px / 2.0

    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    rho = 2.0 * R * np.tan(np.pi / 4.0 + lat / 2.0)
    x, y = rho * np.sin(lon), rho * np.cos(lon)

    c = int(round((x + half) / px))
    r = int(round((half - y) / px))
    if (c - half_px < 0 or r - half_px < 0
            or c + half_px >= n or r + half_px >= n):
        return None
    z = dem[r - half_px:r + half_px + 1,
            c - half_px:c + half_px + 1].astype(np.float64)
    return z * meta["scaling_factor"]


def slope_roughness(dem, meta, lat_deg, lon_deg, box_m=200.0):
    """Slope and roughness around a site.

    Returns
      slope_deg      mean slope at the DEM's native baseline
      slope_max_deg  worst slope in the box -- the gate that matters
      tilt_deg       tilt of the best-fit plane (the regional lie of the land)
      roughness_m    RMS deviation from that plane, i.e. detrended relief
    """
    px = meta["map_scale"]
    half_px = max(2, int(round(box_m / px / 2)))
    z = patch(dem, meta, lat_deg, lon_deg, half_px)
    if z is None:
        return None

    dy, dx = np.gradient(z, px, px)
    slope = np.degrees(np.arctan(np.hypot(dx, dy)))

    # plane fit -> regional tilt, and the residual is the roughness
    m = z.shape[0]
    g = (np.arange(m) - (m - 1) / 2.0) * px
    X, Y = np.meshgrid(g, g)
    A = np.column_stack([X.ravel(), Y.ravel(), np.ones(X.size)])
    coef, *_ = np.linalg.lstsq(A, z.ravel(), rcond=None)
    resid = z.ravel() - A @ coef

    return {
        "slope_deg": float(slope.mean()),
        "slope_max_deg": float(slope.max()),
        "tilt_deg": float(np.degrees(np.arctan(np.hypot(coef[0], coef[1])))),
        "roughness_m": float(np.sqrt((resid ** 2).mean())),
        "box_m": float(2 * half_px * px),
        "baseline_m": float(px),
    }


def psr_points(rec, sun_threshold=0.05):
    """Permanently shadowed points from a screening record.

    A PSR is a point the Sun never reaches. The threshold is not exactly zero
    because the disc model leaves a trace of partial illumination at the very
    edge of a shadow.
    """
    return rec[rec["sun_pct"] <= sun_threshold]


def nearest_psr_km(lat_deg, lon_deg, psr, R=1737400.0):
    """Great-circle-ish distance to the nearest permanently shadowed point.

    Distances here are tens of km at most, so the projection plane is used
    directly -- the error against a spherical distance is well under a metre.
    """
    def to_xy(lat, lon):
        la, lo = np.radians(lat), np.radians(lon)
        rho = 2.0 * R * np.tan(np.pi / 4.0 + la / 2.0)
        return rho * np.sin(lo), rho * np.cos(lo)

    x0, y0 = to_xy(lat_deg, lon_deg)
    xs, ys = to_xy(psr["lat"], psr["lon"])
    d = np.hypot(xs - x0, ys - y0)
    i = int(np.argmin(d))
    return float(d[i] / 1000.0), float(psr["lat"][i]), float(psr["lon"][i])
