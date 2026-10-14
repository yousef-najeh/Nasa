| `ldem_80s_20m`  | 80S-90S | 20 m/px  | 1.76 GB |

Shipped to the browser: `dem_south.bin` 7624^2 @ 120 m/px (116 MB) and
`hillshade_south.png` 16384x4096 (58 MB). Both are loaded whole -- fine on
localhost, and a tiled pyramid replaces them before any deploy.# Lunar South Pole Site Finder

Ranks candidate landing sites around the Moon's south pole from real NASA data,
and lets you fly the result like Google Earth.

Status: **Phase A prototype.** Real LOLA terrain renders in Cesium. No scoring yet.

## Run

```bash
npm install
npm run dev          # http://localhost:5173
```

Regenerate browser assets from the raw LOLA rasters:

```bash
./.venv/Scripts/python.exe pipeline/prepare_terrain.py ldem_75s_240m
```

## Layout

```
pipeline/lola.py             PDS3 label parser + polar stereographic projection
pipeline/prepare_terrain.py  LOLA .img -> dem_south.bin + hillshade PNG
src/lola.js                  browser-side DEM sampler (mirrors lola.py)
src/main.js                  Cesium viewer, Moon ellipsoid, custom terrain
data/lola/                   raw LOLA rasters (gitignored, ~2 GB)
public/data/                 generated browser assets
```

## Data on disk

| Product | Coverage | Res | Size |
|---|---|---|---|
| `ldem_75s_240m` | 75°S–90°S | 240 m/px | 28 MB |
| `ldem_75s_120m` | 75°S–90°S | 120 m/px | 111 MB |
| `ldem_80s_20m`  | 80°S–90°S | 20 m/px  | 1.76 GB |

All are flat little-endian int16 rasters, spherical polar stereographic,
height in metres = `DN * 0.5` above a 1737.4 km reference sphere. Verified
against the PDS labels: centre pixel resolves to -90.000°, edge to -75.005°,
half-width 457.44 km, elevations -7740 m to +6966 m.

Source: PDS Geosciences Node, LOLA RDR polar GDRs.

## Notes / gotchas found so far

- `Ellipsoid.default = Ellipsoid.MOON` must be set before the Viewer is built.
- With a non-WGS84 ellipsoid Cesium does not create `scene.sun` / `scene.moon`,
  so guard before touching them.
- `globe.cartographicLimitRectangle` is required, or imagery smears radially
  outward past the 75°S data edge.
- Keep `globe.showSkirts` on — without it, terrain tiles crack visibly in
  oblique near-surface views.
- Zero the `screenSpaceCameraController` inertias, or the camera drifts off a
  programmatic `setView` (~16 km in 3 s).
- Cesium's bundled ion demo token cannot reach Cesium Moon Terrain. Not needed:
  terrain here is built from LOLA directly, so the app has no ion dependency.

## Rendering

The surface is rendered, not photographed -- LOLA is an altimeter and carries
no albedo, and no imagery is used anywhere yet.

`pipeline/shade.py` has two styles, selected by `STYLE` in `prepare_terrain.py`:

- `realistic` (default) -- a single Sun at 12 deg elevation with **cast
  shadows** ray-marched across the DEM, Lommel-Seeliger reflectance (regolith
  backscatters, so Lambert is wrong), neutral grey albedo 0.136, a small
  ambient term for secondary illumination, and a soft shadow edge standing in
  for the Sun's 0.5 deg angular diameter.
- `map` -- a cartographic multidirectional hillshade. Easier to read terrain
  from, but it looks like a map rather than the Moon.

`docs/sun_compare.png` renders the cap at 75/40/12/2 deg Sun elevation. It
shows why a literal "full moon" view is useless here: at zero phase angle
nothing casts a visible shadow and the relief disappears entirely. Real
full-moon detail is albedo, which LOLA cannot provide -- LROC WAC imagery
would be the source if we want it.

`cast_shadow()` is the single-direction case of the Phase B horizon mask,
including the `d^2/2R` curvature drop-off, so it is already on the critical
path rather than being decoration.

## Next

Phase B — the horizon/illumination engine. See the plan: compute a 360-azimuth
horizon mask per pixel with the lunar curvature drop-off, then step Sun and
Earth positions from SPICE to accumulate illumination %, longest night, Earth
visibility % and max blackout.
