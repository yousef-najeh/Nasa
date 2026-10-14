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

## Navigation

`src/navigation.js` owns the camera. Cesium defaults assume Earth and a
ground-level user; here the camera works from 5000 km out down to standing on
a crater rim, so every rate scales with height above the surface.

- Mouse bindings match what people know from maps: left drag orbits, right
  drag tilts, shift-drag looks around, wheel zooms. Cesium puts zoom on
  right-drag by default, which surprises everyone.
- **Zoom goes toward the cursor.** Cesium zooms along the view axis, so the
  feature you aimed at slides out of frame. The pointer position is tracked
  directly off the canvas, because the wheel action reports only a delta --
  if the position were unknown the zoom would silently revert to the screen
  centre.
- Double-click flies in to the picked point.
- WASD / RF / QE, Shift for 3.5x. Q/E use `lookLeft`/`lookRight`, not `twist`:
  twisting rolls the horizon over and leaves the view crooked.
- Inertia is back at Cesium defaults. It had been zeroed to stop a
  programmatic `setView` from drifting, which cost all the glide; `nav.settle()`
  now cancels inertia for one frame around programmatic moves instead.

## The globe

The viewer opens on the whole Moon, not a polar disc. Three sources stack:

- **Global shape** from the LOLA `ldem_16` simple-cylindrical DEM (5760x2880,
  16 ppd), so the sphere has real topography everywhere.
- **Base imagery** from the LROC WAC global mosaic, served by NASA Moon Trek.
  Its tiling matches a Cesium `GeographicTilingScheme` exactly (2x1 at level 0,
  256 px tiles, origin -180/90), so it maps straight across with no
  reprojection. CORS is open.
- **Polar relief overlay** -- our render -- fading in from 79S to 84S, which is
  where WAC stops being usable. Real photography survives wherever it exists.

The two DEMs are cross-faded over 75.5S-77S in `Terrain.heightForTerrain()` so
the mesh has no step at the seam, while `Terrain.heightAt()` stays truthful for
the elevation readout.

## Surface detail

`pipeline/detail.py` shades the 20 m DEM and averages down to the 120 m output
grid. This is not the same as shading the averaged terrain -- the average keeps
the variance contributed by sub-pixel roughness, so the surface regains real
measured texture instead of being perfectly smooth below 120 m. Only the local
reflectance is computed at 20 m; cast shadows stay coarse, since ray-marching
56 km of shadow across 30400^2 pixels buys nothing.

The two grids are concentric in the same projection, so splicing is a centred
overwrite -- the 20 m DEM covers 80-90S and lands at a 1279 px offset in the
120 m grid, exactly.

## Phase B: Sun, Earth and exposure

`pipeline/ephem.py` wraps NASA SPICE (DE440) and works in **MOON_ME**, the Mean
Earth / Polar Axis frame the LOLA products are tied to -- MOON_PA would be wrong
by a few hundred metres on the ground.

Validated against known physics, because frame errors are silent:

| Check | Computed | Expected |
|---|---|---|
| Sun elevation at the pole | -1.560 to +1.576 deg | +/-1.54 (lunar obliquity) |
| Sun azimuth sweep period | 29.53 days | 29.53 (synodic month) |
| Sun angular radius | 0.271 deg | ~0.266 |
| Earth angular radius | 0.932 deg | ~0.9 |
| Earth elevation at the pole | -7.09 to +6.61 deg | libration, ~+/-7 |

`pipeline/horizon.py` builds a per-site horizon profile (obstruction elevation
per azimuth, with the `d^2/2R` curvature drop-off) and steps Sun and Earth
across a mission window. Both are treated as discs, not points: at these
grazing angles a site spends real time partially lit, and a binary test throws
away the difference between a good site and a marginal one.

Sun and Earth positions are computed **once** and reused by every site -- the
Sun is 150 million km away, so the whole polar region sees the same sky. That
took a site from 250 ms to 10 ms and is what makes screening affordable. Site
parallax is still kept, since Earth sits within a degree of the horizon here.

`pipeline/screen.py` runs two tiers: 31,417 candidates at 1 km over a 100 km
radius, then 60 m boxes around the best seeds. The refinement matters -- the
coarse pass peaked at 74.2% solar exposure and the fine pass found 87.9%,
because the optima are ridge crests tens of metres wide.

## Next

Phase B — the horizon/illumination engine. See the plan: compute a 360-azimuth
horizon mask per pixel with the lunar curvature drop-off, then step Sun and
Earth positions from SPICE to accumulate illumination %, longest night, Earth
visibility % and max blackout.
