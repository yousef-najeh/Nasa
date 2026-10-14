"""Relief shading for the LOLA polar DEM.

A single low-altitude hillshade loses most of the detail on a body with
7 km of relief and no atmosphere to soften it. This builds a multidirectional
shade (one dominant key light plus fill and rim), adds a slope term so steep
ground reads darker, and sharpens with an unsharp mask.
"""

import numpy as np
from scipy.ndimage import gaussian_filter


def slope_aspect(z, px, z_factor=1.0):
    dy, dx = np.gradient(z.astype(np.float32) * np.float32(z_factor), px, px)
    slope = np.arctan(np.hypot(dx, dy)).astype(np.float32)
    aspect = np.arctan2(-dx, dy).astype(np.float32)
    del dx, dy
    return slope, aspect


def _lamp(slope, aspect, az_deg, alt_deg):
    az = np.radians(np.float32(360.0 - az_deg + 90.0))
    alt = np.radians(np.float32(alt_deg))
    s = (np.sin(alt) * np.cos(slope)
         + np.cos(alt) * np.sin(slope) * np.cos(az - aspect))
    return np.clip(s, 0.0, 1.0, out=s)


def relief(z, px, z_factor=1.4, sharpen=0.55, contrast=1.15, gamma=1.10):
    """Return a float32 shade in [0,1] the same shape as z."""
    slope, aspect = slope_aspect(z, px, z_factor)

    # key / fill / rim -- weights sum to 1
    shade = 0.58 * _lamp(slope, aspect, 315.0, 42.0)
    shade += 0.24 * _lamp(slope, aspect, 45.0, 62.0)
    shade += 0.18 * _lamp(slope, aspect, 170.0, 28.0)

    # steep ground reads darker; keeps crater walls from flattening out
    shade *= (1.0 - 0.30 * np.clip(slope / np.radians(35.0), 0, 1)).astype(np.float32)
    del aspect, slope

    if sharpen > 0:
        shade += sharpen * (shade - gaussian_filter(shade, 1.6))

    mid = float(np.median(shade))
    shade = (shade - mid) * contrast + mid
    np.clip(shade, 0.0, 1.0, out=shade)
    # slight S-curve: deepens the mid-shadows without clipping the highlights
    return np.power(shade, gamma, out=shade)


def bilinear(src, col, row):
    """Bilinear gather from `src` at float pixel coords."""
    n_r, n_c = src.shape
    c0 = np.clip(np.floor(col), 0, n_c - 1).astype(np.int32)
    r0 = np.clip(np.floor(row), 0, n_r - 1).astype(np.int32)
    c1 = np.minimum(c0 + 1, n_c - 1)
    r1 = np.minimum(r0 + 1, n_r - 1)
    fc = (col - c0).astype(np.float32)
    fr = (row - r0).astype(np.float32)
    top = src[r0, c0] * (1 - fc) + src[r0, c1] * fc
    bot = src[r1, c0] * (1 - fc) + src[r1, c1] * fc
    return top * (1 - fr) + bot * fr


# ---------------------------------------------------------------------------
# Physically-motivated lunar rendering
# ---------------------------------------------------------------------------

def sun_vector(az_deg, elev_deg):
    """Unit vector toward the Sun in local (east, north, up)."""
    a, e = np.radians(az_deg), np.radians(elev_deg)
    return np.array([np.sin(a) * np.cos(e),
                     np.cos(a) * np.cos(e),
                     np.sin(e)], dtype=np.float64)


def _shift(z, dr, dc, fill):
    """out[r, c] = z[r + dr, c + dc], padded with `fill`."""
    h, w = z.shape
    out = np.full_like(z, fill)
    r0, r1 = max(0, -dr), min(h, h - dr)
    c0, c1 = max(0, -dc), min(w, w - dc)
    if r0 < r1 and c0 < c1:
        out[r0:r1, c0:c1] = z[r0 + dr:r1 + dr, c0 + dc:c1 + dc]
    return out


def cast_shadow(z, px, az_deg, elev_deg, radius, max_dist=None):
    """True where terrain blocks the Sun.

    A point is shadowed if anything along the line toward the Sun rises above
    the solar ray, after subtracting the body's curvature drop-off d^2/2R --
    which matters here because shadows at grazing incidence run for tens of km.
    This is the single-direction case of the Phase B horizon mask.
    """
    a = np.radians(az_deg)
    dcol, drow = np.sin(a), -np.cos(a)      # array cols run east, rows run south
    tan_e = np.tan(np.radians(elev_deg))
    if max_dist is None:
        # no shadow can outrun the total relief divided by the ray slope
        relief_m = float(z.max() - z.min())
        max_dist = min(120000.0, relief_m / max(tan_e, 1e-3))

    acc = np.full(z.shape, -np.inf, dtype=np.float32)
    for k in range(1, int(max_dist / px) + 1):
        d = k * px
        ray = np.float32(d * tan_e + d * d / (2.0 * radius))
        np.maximum(acc, _shift(z, int(round(k * drow)), int(round(k * dcol)),
                               -np.inf) - ray, out=acc)
    return acc > z


def lunar_surface(z, px, az_deg, elev_deg, radius, albedo=0.136,
                  ambient=0.025, shadow_softness=1.2):
    """Render regolith under a single hard light, Lommel-Seeliger reflectance.

    Lambert is wrong for regolith: the Moon looks nearly flat-lit at full phase
    because it backscatters. Lommel-Seeliger, mu0/(mu0+mu), is the standard
    first-order law and keeps the limb from darkening into mush.
    """
    dy, dx = np.gradient(z.astype(np.float32), px, px)
    inv = (1.0 / np.sqrt(dx * dx + dy * dy + 1.0)).astype(np.float32)
    nx, ny, nz = -dx * inv, -dy * inv, inv
    del dx, dy, inv

    s = sun_vector(az_deg, elev_deg)
    mu0 = nx * np.float32(s[0]) + ny * np.float32(s[1]) + nz * np.float32(s[2])
    del nx, ny
    np.clip(mu0, 0.0, None, out=mu0)

    mu = nz                                     # near-nadir view
    refl = albedo * mu0 / np.maximum(mu0 + mu, 1e-6)
    del mu0, mu, nz

    lit = (~cast_shadow(z, px, az_deg, elev_deg, radius)).astype(np.float32)
    if shadow_softness > 0:
        # the Sun is a ~0.5 deg disc, so shadow edges carry a real penumbra
        lit = gaussian_filter(lit, shadow_softness)

    return refl * lit + albedo * ambient
