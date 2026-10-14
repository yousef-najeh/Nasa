"""Horizon masks and Sun/Earth exposure for candidate landing sites.

Near the pole the Sun never climbs more than ~1.5 degrees and Earth sits on the
horizon bobbing with libration, so whether a site has power or comms is decided
entirely by the terrain around it -- including massifs tens of km away.

For every site this builds a horizon profile (obstruction elevation per
azimuth), then steps real Sun and Earth geometry across a mission window and
accumulates:

  sun_pct        fraction of the window with the Sun above the local horizon
  longest_night  worst continuous darkness, in hours -- this sizes the battery
  earth_pct      fraction with Earth above the local horizon
  longest_blackout  worst continuous comms outage, in hours

Both bodies are treated as discs, not points: at these grazing angles a site
spends real time in partial illumination, and calling that lit-or-not throws
away the distinction between a good site and a marginal one.
"""

import numpy as np

import ephem


def horizon_profile(dem, meta, lat_deg, lon_deg, n_az=360,
                    max_dist=120_000.0, n_steps=220, radius=None):
    """Obstruction elevation angle (deg) per azimuth, from north clockwise.

    Rays are stepped geometrically: distant terrain still matters but needs far
    less sampling than the ground immediately around the site.
    """
    R = radius or meta["a_axis_km"] * 1000.0
    px = meta["map_scale"]
    half = meta["width"] * px / 2.0 if "width" in meta else dem.shape[0] * px / 2.0
    n = dem.shape[0]
    k = meta["scaling_factor"]

    # site position in the projection plane
    x0, y0 = _latlon_to_xy(lat_deg, lon_deg, R)
    z0 = _sample(dem, x0, y0, half, px, n) * k

    # geometric step spacing from one pixel out to max_dist
    d = np.geomspace(px, max_dist, n_steps)
    az = np.radians(np.arange(n_az) * (360.0 / n_az))

    # ray endpoints: (n_az, n_steps)
    xs = x0 + np.sin(az)[:, None] * d[None, :]
    ys = y0 + np.cos(az)[:, None] * d[None, :]
    zs = _sample(dem, xs, ys, half, px, n) * k

    # curvature drop-off: distant terrain falls away from the local horizontal
    drop = d[None, :] ** 2 / (2.0 * R)
    ang = np.degrees(np.arctan2(zs - z0 - drop, d[None, :]))
    ang = np.where(np.isnan(zs), -90.0, ang)
    return np.maximum(ang.max(axis=1), -90.0), z0


def _latlon_to_xy(lat_deg, lon_deg, R):
    lat, lon = np.radians(lat_deg), np.radians(lon_deg)
    rho = 2.0 * R * np.tan(np.pi / 4.0 + lat / 2.0)
    return rho * np.sin(lon), rho * np.cos(lon)


def _sample(dem, x, y, half, px, n):
    """Bilinear sample of the polar grid; NaN outside coverage."""
    c = (np.asarray(x) + half) / px
    r = (half - np.asarray(y)) / px
    bad = (c < 0) | (r < 0) | (c > n - 1) | (r > n - 1)
    c = np.clip(c, 0, n - 1)
    r = np.clip(r, 0, n - 1)
    c0, r0 = np.floor(c).astype(np.int32), np.floor(r).astype(np.int32)
    c1, r1 = np.minimum(c0 + 1, n - 1), np.minimum(r0 + 1, n - 1)
    fc, fr = c - c0, r - r0
    top = dem[r0, c0] * (1 - fc) + dem[r0, c1] * fc
    bot = dem[r1, c0] * (1 - fc) + dem[r1, c1] * fc
    out = (top * (1 - fr) + bot * fr).astype(np.float64)
    return np.where(bad, np.nan, out)


def _visible_fraction(el, horizon_el, ang_radius):
    """Fraction of a disc of angular radius `ang_radius` clearing the horizon.

    A simple linear ramp across the disc. Treating the body as a point would
    make every grazing site look binary, which is precisely the regime the
    south pole lives in.
    """
    return np.clip((el - horizon_el + ang_radius) / (2.0 * ang_radius), 0.0, 1.0)


def _longest_run(mask, step_hours):
    """Longest continuous stretch where mask is True, in hours."""
    if not mask.any():
        return len(mask) * step_hours
    idx = np.flatnonzero(np.diff(np.concatenate(([0], mask.view(np.int8), [0]))))
    runs = idx[1::2] - idx[0::2]
    return float(runs.max() * step_hours) if len(runs) else 0.0


def body_positions(start_utc="2027-01-01T00:00:00", days=365.25, step_hours=1.0):
    """Sun and Earth positions in MOON_ME (km) across a window.

    These are the same for every site in the polar region -- the Moon is 1737 km
    across and the Sun is 150 million km away -- so the SPICE calls are made
    once here and every site reuses them. Scanning tens of thousands of
    candidate points is otherwise dominated by redundant ephemeris lookups.
    """
    import spiceypy as spice
    ephem.load()
    ets = ephem.et_range(start_utc, days, step_hours)
    sun = np.array([spice.spkpos("SUN", e, "MOON_ME", "LT+S", "MOON")[0] for e in ets])
    earth = np.array([spice.spkpos("EARTH", e, "MOON_ME", "LT+S", "MOON")[0] for e in ets])
    return {"ets": ets, "sun": sun, "earth": earth, "step_hours": step_hours}


def _azel_from(positions_km, lat_deg, lon_deg, body_radius_km, radius_m):
    """Project precomputed body positions into a site's local ENU frame.

    Site parallax is kept (the vector is taken from the surface point, not the
    Moon's centre): across the polar region it is only ~0.05 deg for Earth, but
    Earth sits within a degree of the horizon here, so it is not noise.
    """
    site = ephem.surface_point(lat_deg, lon_deg, radius_m / 1000.0)
    east, north, up = ephem.enu_basis(lat_deg, lon_deg)
    vec = positions_km - site
    e, n, u = vec @ east, vec @ north, vec @ up
    rng = np.linalg.norm(vec, axis=1)
    az = np.degrees(np.arctan2(e, n)) % 360.0
    el = np.degrees(np.arcsin(u / rng))
    ang = np.degrees(np.arcsin(body_radius_km / rng))
    return az, el, ang


def exposure(horizon, lat_deg, lon_deg, positions=None,
             start_utc="2027-01-01T00:00:00", days=365.25, step_hours=1.0,
             lit_threshold=0.5, site_radius_m=None):
    """Sun and Earth exposure for a site with a known horizon profile."""
    n_az = len(horizon)
    if positions is None:
        positions = body_positions(start_utc, days, step_hours)
    step_hours = positions["step_hours"]
    r_m = site_radius_m or ephem.MOON_R * 1000.0

    sun = _azel_from(positions["sun"], lat_deg, lon_deg, ephem.SUN_RADIUS_KM, r_m)
    earth = _azel_from(positions["earth"], lat_deg, lon_deg, ephem.EARTH_RADIUS_KM, r_m)

    def frac(body):
        az, el, ang = body
        idx = (np.round(az / (360.0 / n_az)).astype(int)) % n_az
        return _visible_fraction(el, horizon[idx], ang)

    sun_f, earth_f = frac(sun), frac(earth)
    dark = sun_f < lit_threshold
    blackout = earth_f < lit_threshold

    return {
        "sun_pct": float(sun_f.mean() * 100.0),
        "sun_any_pct": float((sun_f > 0).mean() * 100.0),
        "longest_night_h": _longest_run(dark, step_hours),
        "earth_pct": float(earth_f.mean() * 100.0),
        "longest_blackout_h": _longest_run(blackout, step_hours),
        "sun_el_max": float(sun[1].max()),
        "earth_el_max": float(earth[1].max()),
        "horizon_mean": float(horizon.mean()),
        "horizon_max": float(horizon.max()),
        "samples": int(sun_f.size),
    }
