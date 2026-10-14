"""Supersampled reflectance from the 20 m DEM.

At 120 m/px everything below 120 m is perfectly smooth, which is what makes a
rendered surface read as CGI -- real regolith is cratered at every scale.

Shading the 20 m DEM and *averaging down* to the output grid is not the same
as shading the averaged terrain: the average retains the variance contributed
by sub-pixel roughness, so the surface regains real measured texture.

Only the local reflectance term is computed at 20 m. Cast shadows are
long-range and smooth, so they stay on the coarse grid -- ray-marching 56 km
of shadow across 30400^2 pixels is not worth it.
"""

import numpy as np

from shade import sun_vector


def fine_reflectance(arr, meta, az_deg, elev_deg, factor=6, albedo=0.136,
                     strip=2048, log=print):
    """Shade `arr` at its native resolution, block-mean down by `factor`.

    Returns (reflectance, out_px, out_half) on the coarsened grid.
    """
    n = arr.shape[0]
    px = meta["map_scale"]
    k = meta["scaling_factor"]
    out_n = n // factor
    out = np.empty((out_n, out_n), dtype=np.float32)
    s = sun_vector(az_deg, elev_deg).astype(np.float32)

    for y0 in range(0, out_n * factor, strip * factor):
        y1 = min(y0 + strip * factor, out_n * factor)
        # one row of padding each side so the gradient is valid at the seams
        p0, p1 = max(0, y0 - 1), min(n, y1 + 1)
        z = arr[p0:p1].astype(np.float32) * k

        dy, dx = np.gradient(z, px, px)
        inv = (1.0 / np.sqrt(dx * dx + dy * dy + 1.0)).astype(np.float32)
        mu0 = (-dx * s[0] - dy * s[1]) * inv + inv * s[2]
        del dx, dy, z
        np.clip(mu0, 0.0, None, out=mu0)
        refl = albedo * mu0 / np.maximum(mu0 + inv, 1e-6)
        del mu0, inv

        refl = refl[y0 - p0:y1 - p0]                      # drop the padding
        h = refl.shape[0] // factor
        # n is not necessarily a multiple of factor, so trim both axes
        out[y0 // factor:y0 // factor + h] = refl[:h * factor, :out_n * factor] \
            .reshape(h, factor, out_n, factor).mean(axis=(1, 3))
        del refl
        log(f"    rows {y1}/{out_n * factor}")

    return out, px * factor, out_n * px * factor / 2.0


def splice(coarse, coarse_px, coarse_half, fine, fine_px, fine_half):
    """Drop the fine-grid patch into the centre of the coarse grid.

    Both are centred on the pole in the same projection, so this is a plain
    centred overwrite once the resolutions match.
    """
    if abs(coarse_px - fine_px) > 1e-6:
        raise ValueError(f"resolution mismatch: {coarse_px} vs {fine_px}")
    n_c, n_f = coarse.shape[0], fine.shape[0]
    off = int(round((coarse_half - fine_half) / coarse_px))
    if off < 0 or off + n_f > n_c:
        raise ValueError(f"fine grid does not fit: off={off}, {n_f} into {n_c}")
    coarse[off:off + n_f, off:off + n_f] = fine
    return coarse
