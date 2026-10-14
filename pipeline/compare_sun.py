"""Render the cap at several Sun elevations so the look can be chosen by eye."""
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import lola
from shade import lunar_surface

ROOT = Path(__file__).resolve().parent.parent
ALBEDO = 0.136


def tone(img, albedo=ALBEDO):
    """Reflectance -> 8-bit, exposed to the albedo and gamma-corrected."""
    v = np.clip(img / albedo, 0, 1)
    return (np.power(v, 1 / 2.2) * 255).astype(np.uint8)


def main(out="sun_compare.png", size=760):
    arr, meta = lola.open_dem(ROOT / "data/lola/ldem_75s_240m.img",
                              ROOT / "data/labels/ldem_75s_240m.lbl")
    z = arr.astype(np.float32) * meta["scaling_factor"]
    px, R = meta["map_scale"], meta["a_axis_km"] * 1000.0
    n = z.shape[0]
    yy, xx = np.ogrid[:n, :n]
    disc = ((yy - n / 2) ** 2 + (xx - n / 2) ** 2) <= (n / 2) ** 2

    cases = [(75.0, "near-full: Sun overhead"),
             (40.0, "mid: classic Moon-photo look"),
             (12.0, "low"),
             (2.0, "true south-pole grazing Sun")]

    panels = []
    for elev, label in cases:
        img = lunar_surface(z, px, 45.0, elev, R)
        g = tone(np.where(disc, img, 0.0))
        panels.append(np.array(Image.fromarray(g, "L").resize((size, size),
                                                              Image.LANCZOS)))
        print(f"{elev:5.1f} deg  {label:32s} mean={g[disc].mean():.0f}")

    strip = np.concatenate(panels, axis=1)
    Image.fromarray(strip, "L").save(ROOT / out)
    print(f"\nwrote {out}  ({strip.shape[1]}x{strip.shape[0]})")


if __name__ == "__main__":
    main(*sys.argv[1:])
