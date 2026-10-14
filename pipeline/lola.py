"""Read LOLA polar GDR products (PDS3 detached label + flat binary raster).

The polar GDRs are uncompressed little-endian int16 rasters in a spherical
polar stereographic projection, so they can be memory-mapped directly -- no
GDAL, no rasterio. Height in metres = DN * SCALING_FACTOR.
"""

import re
from pathlib import Path

import numpy as np

MOON_R = 1737400.0  # m, reference sphere used by the LOLA GDRs


def _scalar(text, key):
    """Pull `KEY = VALUE` out of a PDS label, dropping any <unit> suffix."""
    m = re.search(rf"^\s*{key}\s*=\s*([^\r\n]+)", text, re.MULTILINE)
    if not m:
        raise KeyError(f"{key} not found in label")
    val = m.group(1).strip().strip('"')
    val = re.sub(r"<[^>]*>", "", val).strip()
    return val


def read_label(lbl_path):
    text = Path(lbl_path).read_text(errors="replace")
    num = lambda k: float(_scalar(text, k))
    meta = {
        "lines": int(num("LINES")),
        "samples": int(num("LINE_SAMPLES")),
        "sample_bits": int(num("SAMPLE_BITS")),
        "sample_type": _scalar(text, "SAMPLE_TYPE"),
        "scaling_factor": num("SCALING_FACTOR"),
        "offset": num("OFFSET"),
        "map_scale": num("MAP_SCALE"),               # metres per pixel
        "a_axis_km": num("A_AXIS_RADIUS"),
        "center_lat": num("CENTER_LATITUDE"),
        "center_lon": num("CENTER_LONGITUDE"),
        "min_lat": num("MINIMUM_LATITUDE"),
        "max_lat": num("MAXIMUM_LATITUDE"),
        "line_offset": num("LINE_PROJECTION_OFFSET"),
        "sample_offset": num("SAMPLE_PROJECTION_OFFSET"),
    }
    if meta["sample_type"] != "LSB_INTEGER" or meta["sample_bits"] != 16:
        raise ValueError(f"unexpected sample format: {meta['sample_type']}/{meta['sample_bits']}")
    return meta


def open_dem(img_path, lbl_path):
    """Memory-map a DEM. Returns (int16 array, meta) -- multiply by
    meta['scaling_factor'] to get metres above the reference sphere."""
    meta = read_label(lbl_path)
    expected = meta["lines"] * meta["samples"] * 2
    actual = Path(img_path).stat().st_size
    if actual != expected:
        raise ValueError(f"size mismatch: file {actual} B, label implies {expected} B")
    arr = np.memmap(img_path, dtype="<i2", mode="r",
                    shape=(meta["lines"], meta["samples"]))
    return arr, meta


def pixel_to_xy(line, sample, meta):
    """Pixel indices -> projection-plane metres (x east, y north)."""
    x = (np.asarray(sample, dtype=np.float64) - meta["sample_offset"]) * meta["map_scale"]
    y = (meta["line_offset"] - np.asarray(line, dtype=np.float64)) * meta["map_scale"]
    return x, y


def xy_to_latlon(x, y, meta):
    """Inverse spherical polar stereographic (south aspect, true scale at pole)."""
    R = meta["a_axis_km"] * 1000.0
    rho = np.hypot(x, y)
    lat = np.degrees(2.0 * np.arctan(rho / (2.0 * R)) - np.pi / 2.0)
    lon = np.degrees(np.arctan2(x, y)) % 360.0
    return lat, lon


def latlon_to_xy(lat, lon, meta):
    R = meta["a_axis_km"] * 1000.0
    latr, lonr = np.radians(lat), np.radians(lon)
    rho = 2.0 * R * np.tan(np.pi / 4.0 + latr / 2.0)
    return rho * np.sin(lonr), rho * np.cos(lonr)
