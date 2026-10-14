"""Screen the south polar region for landing sites.

Builds a grid of candidate points, computes each one's horizon profile from the
LOLA DEM, then steps real Sun and Earth geometry across a mission window to get
power and comms exposure.

Two tiers, because horizon work is the expensive part: a coarse pass over the
whole region produces a shortlist, then a fine pass resolves the best spots.
The optima here are genuinely small -- a ridge crest tens of metres wide can be
lit while ground 200 m away is not -- so the coarse pass alone will understate
the best sites.
"""

import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).parent))
import lola
import horizon as hz

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "data"

DEM = "ldem_75s_120m"
START = "2027-01-01T00:00:00"


def grid_points(radius_m, spacing_m, R):
    """Candidate points on a square lattice clipped to a disc around the pole."""
    n = int(radius_m / spacing_m)
    g = np.arange(-n, n + 1) * spacing_m
    x, y = np.meshgrid(g, g)
    keep = (x * x + y * y) <= radius_m * radius_m
    x, y = x[keep], y[keep]
    rho = np.hypot(x, y)
    lat = np.degrees(2.0 * np.arctan(rho / (2.0 * R)) - np.pi / 2.0)
    lon = np.degrees(np.arctan2(x, y)) % 360.0
    return lat, lon, x, y


def run(radius_m=100_000, spacing_m=1000, n_az=180, step_hours=3.0,
        days=365.25, label="coarse", log=print):
    arr, meta = lola.open_dem(ROOT / f"data/lola/{DEM}.img",
                              ROOT / f"data/labels/{DEM}.lbl")
    meta["width"] = arr.shape[0]
    R = meta["a_axis_km"] * 1000.0

    lat, lon, x, y = grid_points(radius_m, spacing_m, R)
    log(f"{label}: {len(lat)} candidates, {spacing_m} m spacing, "
        f"{radius_m / 1000:.0f} km radius")

    pos = hz.body_positions(START, days, step_hours)
    log(f"  ephemeris: {len(pos['ets'])} steps at {step_hours} h")

    rec = np.zeros(len(lat), dtype=[
        ("lat", "f8"), ("lon", "f8"), ("elev", "f4"),
        ("sun_pct", "f4"), ("earth_pct", "f4"),
        ("night_h", "f4"), ("blackout_h", "f4"), ("horizon_mean", "f4")])

    t0 = time.time()
    for i in range(len(lat)):
        h, z0 = hz.horizon_profile(arr, meta, lat[i], lon[i], n_az=n_az)
        e = hz.exposure(h, lat[i], lon[i], positions=pos)
        rec[i] = (lat[i], lon[i], z0, e["sun_pct"], e["earth_pct"],
                  e["longest_night_h"], e["longest_blackout_h"], e["horizon_mean"])
        if i % 5000 == 0 and i:
            rate = i / (time.time() - t0)
            log(f"  {i}/{len(lat)}  {rate:.0f}/s  eta {(len(lat) - i) / rate:.0f}s")

    log(f"  done in {time.time() - t0:.0f}s")
    return rec


def report(rec, n=12, log=print):
    order = np.argsort(-(rec["sun_pct"] * 0.6 + rec["earth_pct"] * 0.4))
    log(f"\n{'rank':>4} {'lat':>9} {'lon':>8} {'elev':>7} {'sun%':>6} "
        f"{'earth%':>7} {'night_h':>8} {'black_h':>8}")
    for r, i in enumerate(order[:n], 1):
        s = rec[i]
        log(f"{r:>4} {s['lat']:>9.4f} {s['lon']:>8.3f} {s['elev']:>7.0f} "
            f"{s['sun_pct']:>6.1f} {s['earth_pct']:>7.1f} "
            f"{s['night_h']:>8.0f} {s['blackout_h']:>8.0f}")
    return order


def save(rec, order, path, top=400):
    OUT.mkdir(parents=True, exist_ok=True)
    sites = [{
        "rank": r,
        "lat": round(float(rec[i]["lat"]), 5),
        "lon": round(float(rec[i]["lon"]), 4),
        "elev": round(float(rec[i]["elev"]), 1),
        "sunPct": round(float(rec[i]["sun_pct"]), 2),
        "earthPct": round(float(rec[i]["earth_pct"]), 2),
        "nightH": round(float(rec[i]["night_h"]), 1),
        "blackoutH": round(float(rec[i]["blackout_h"]), 1),
        "horizonMean": round(float(rec[i]["horizon_mean"]), 3),
    } for r, i in enumerate(order[:top], 1)]
    Path(path).write_text(json.dumps(
        {"start": START, "count": len(sites), "sites": sites}, indent=1))
    print(f"wrote {path} ({len(sites)} sites)")


def refine(rec, order, n_seeds=18, box_m=3000, spacing_m=60, n_az=360,
           step_hours=2.0, days=365.25, min_sep_m=4000, log=print):
    """Fine pass around the best coarse candidates.

    The coarse grid lands near good ground but rarely on it: the optima are
    ridge crests tens of metres wide. Seeds are spread apart so the budget is
    not spent re-resolving one hilltop.
    """
    arr, meta = lola.open_dem(ROOT / f"data/lola/{DEM}.img",
                              ROOT / f"data/labels/{DEM}.lbl")
    meta["width"] = arr.shape[0]
    R = meta["a_axis_km"] * 1000.0

    seeds = []
    for i in order:
        x, y = hz._latlon_to_xy(rec[i]["lat"], rec[i]["lon"], R)
        if all((x - sx) ** 2 + (y - sy) ** 2 > min_sep_m ** 2 for sx, sy in seeds):
            seeds.append((x, y))
        if len(seeds) >= n_seeds:
            break
    log(f"refine: {len(seeds)} seeds, {box_m} m boxes at {spacing_m} m")

    g = np.arange(-box_m / 2, box_m / 2 + spacing_m, spacing_m)
    dx, dy = np.meshgrid(g, g)
    dx, dy = dx.ravel(), dy.ravel()

    pos = hz.body_positions(START, days, step_hours)
    out = []
    t0 = time.time()
    for s, (sx, sy) in enumerate(seeds, 1):
        x, y = sx + dx, sy + dy
        rho = np.hypot(x, y)
        lat = np.degrees(2.0 * np.arctan(rho / (2.0 * R)) - np.pi / 2.0)
        lon = np.degrees(np.arctan2(x, y)) % 360.0
        for i in range(len(lat)):
            h, z0 = hz.horizon_profile(arr, meta, lat[i], lon[i], n_az=n_az)
            e = hz.exposure(h, lat[i], lon[i], positions=pos)
            out.append((lat[i], lon[i], z0, e["sun_pct"], e["earth_pct"],
                        e["longest_night_h"], e["longest_blackout_h"],
                        e["horizon_mean"]))
        log(f"  seed {s}/{len(seeds)}  {len(out)} pts  {time.time() - t0:.0f}s")

    fine = np.array(out, dtype=rec.dtype)
    return fine


def export_detail(fine, order, top=24, n_az=360, step_hours=3.0, days=365.25):
    """Per-site horizon profiles plus one shared sky track.

    The Sun and Earth tracks are written once, not per site: across the polar
    region the parallax is negligible, so every site sees the same sky. What
    differs -- and what decides power and comms -- is the horizon in front of it.
    """
    arr, meta = lola.open_dem(ROOT / f"data/lola/{DEM}.img",
                              ROOT / f"data/labels/{DEM}.lbl")
    meta["width"] = arr.shape[0]

    pos = hz.body_positions(START, days, step_hours)
    sun = hz._azel_from(pos["sun"], -89.5, 0.0, hz.ephem.SUN_RADIUS_KM,
                        hz.ephem.MOON_R * 1000.0)
    earth = hz._azel_from(pos["earth"], -89.5, 0.0, hz.ephem.EARTH_RADIUS_KM,
                          hz.ephem.MOON_R * 1000.0)

    sites = []
    seen = []
    for i in order:
        s = fine[i]
        if any(abs(s["lat"] - a) < 0.004 and abs(s["lon"] - b) < 0.05
               for a, b in seen):
            continue                     # one entry per distinct hilltop
        seen.append((float(s["lat"]), float(s["lon"])))
        h, z0 = hz.horizon_profile(arr, meta, s["lat"], s["lon"], n_az=n_az)
        sites.append({
            "rank": len(sites) + 1,
            "lat": round(float(s["lat"]), 5), "lon": round(float(s["lon"]), 4),
            "elev": round(float(z0), 1),
            "sunPct": round(float(s["sun_pct"]), 2),
            "earthPct": round(float(s["earth_pct"]), 2),
            "nightH": round(float(s["night_h"]), 1),
            "blackoutH": round(float(s["blackout_h"]), 1),
            "horizon": [round(float(v), 3) for v in h],
        })
        if len(sites) >= top:
            break

    doc = {
        "start": START, "days": days, "stepHours": step_hours, "nAz": n_az,
        "sky": {
            "sunAz": [round(float(v), 2) for v in sun[0]],
            "sunEl": [round(float(v), 3) for v in sun[1]],
            "sunAng": round(float(np.mean(sun[2])), 4),
            "earthAz": [round(float(v), 2) for v in earth[0]],
            "earthEl": [round(float(v), 3) for v in earth[1]],
            "earthAng": round(float(np.mean(earth[2])), 4),
        },
        "sites": sites,
    }
    path = OUT / "sites.json"
    path.write_text(json.dumps(doc))
    print(f"wrote {path} ({len(sites)} sites, "
          f"{len(sun[0])} sky samples, {path.stat().st_size/1e6:.1f} MB)")
    return doc


if __name__ == "__main__":
    rec = run()
    order = report(rec)
    np.save(ROOT / "data/screen_coarse.npy", rec)
    fine = refine(rec, order)
    np.save(ROOT / "data/screen_fine.npy", fine)
    fo = report(fine, n=15)
    export_detail(fine, fo)


def export_full(fine, order, rec_coarse, top=24, n_az=360, step_hours=3.0,
                days=365.25):
    """Export all six criteria per site, plus one shared sky track."""
    import terrain_metrics as tm

    arr, meta = lola.open_dem(ROOT / f"data/lola/{DEM}.img",
                              ROOT / f"data/labels/{DEM}.lbl")
    meta["width"] = arr.shape[0]
    fine_arr, fine_meta = lola.open_dem(ROOT / "data/lola/ldem_80s_20m.img",
                                        ROOT / "data/labels/ldem_80s_20m.lbl")
    psr = tm.psr_points(rec_coarse)

    pos = hz.body_positions(START, days, step_hours)
    sun = hz._azel_from(pos["sun"], -89.5, 0.0, hz.ephem.SUN_RADIUS_KM,
                        hz.ephem.MOON_R * 1000.0)
    earth = hz._azel_from(pos["earth"], -89.5, 0.0, hz.ephem.EARTH_RADIUS_KM,
                          hz.ephem.MOON_R * 1000.0)

    sites, seen = [], []
    for i in order:
        s = fine[i]
        if any(abs(s["lat"] - a) < 0.004 and abs(s["lon"] - b) < 0.05
               for a, b in seen):
            continue
        seen.append((float(s["lat"]), float(s["lon"])))

        h, z0 = hz.horizon_profile(arr, meta, s["lat"], s["lon"], n_az=n_az)
        m = tm.slope_roughness(fine_arr, fine_meta, s["lat"], s["lon"])
        d_psr, plat, plon = tm.nearest_psr_km(s["lat"], s["lon"], psr)

        sites.append({
            "id": len(sites) + 1,
            "lat": round(float(s["lat"]), 5), "lon": round(float(s["lon"]), 4),
            "elev": round(float(z0), 1),
            "sunPct": round(float(s["sun_pct"]), 2),
            "earthPct": round(float(s["earth_pct"]), 2),
            "nightH": round(float(s["night_h"]), 1),
            "blackoutH": round(float(s["blackout_h"]), 1),
            "slopeDeg": round(m["slope_deg"], 2) if m else None,
            "slopeMaxDeg": round(m["slope_max_deg"], 2) if m else None,
            "roughnessM": round(m["roughness_m"], 2) if m else None,
            "psrKm": round(d_psr, 2),
            "psrLat": round(plat, 4), "psrLon": round(plon, 3),
            "horizon": [round(float(v), 3) for v in h],
        })
        if len(sites) >= top:
            break

    doc = {
        "start": START, "days": days, "stepHours": step_hours, "nAz": n_az,
        "slopeBaselineM": 20.0, "slopeBoxM": 200.0,
        "psrSpacingM": 1000.0, "psrCount": int(len(psr)),
        "sky": {
            "sunAz": [round(float(v), 2) for v in sun[0]],
            "sunEl": [round(float(v), 3) for v in sun[1]],
            "earthAz": [round(float(v), 2) for v in earth[0]],
            "earthEl": [round(float(v), 3) for v in earth[1]],
        },
        "sites": sites,
    }
    path = OUT / "sites.json"
    path.write_text(json.dumps(doc))
    print(f"wrote {path} ({len(sites)} sites, {len(psr)} PSR points, "
          f"{path.stat().st_size/1e6:.1f} MB)")
    return doc
