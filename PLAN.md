# Lunar South Pole Site Finder — Plan

Rank candidate landing sites around the Moon's south pole from NASA data, and
let anyone fly the result in a browser.

**Positioning.** NASA already has a viewer for the Moon: Moon Trek. We will not
out-build it, and we should not try. Moon Trek *shows* you the Moon; this
*ranks* it. The globe is the delivery vehicle — the decision layer is the
product. If asked "isn't this Moon Trek?", the answer is one sentence.

Status: **Phases A-D done.** All six criteria compute; weights are live sliders
and hard limits gate the list. **Phase B landed.** Real Sun and Earth geometry from NASA SPICE drives
per-site power and comms exposure, validated against known physics. 31,417
candidates screened and refined; the best site reaches 87.9% solar exposure.
The globe renders the whole Moon in Cesium with no ion dependency.

---

## 1. What "best" means

Six criteria, each computed as a raster. Hard constraints mask pixels out; the
survivors are combined into a weighted score.

| # | Criterion | Metric | Type |
|---|---|---|---|
| 1 | Solar power | % illumination over the mission window | **done** |
| 2 | Survivability | longest continuous darkness (hours) | **done** — hard limit |
| 3 | Comms | % Earth visibility, longest blackout | **done** |
| 4 | Landing safety | worst slope within 200 m, 20 m baseline | **done** — hard mask |
| 5 | Roughness | RMS relief after removing regional slope | **done** |
| 6 | Science / ISRU | distance to nearest permanently shadowed ground | **done** |

The weights are **exposed as sliders in the app** and the score recomputes live
in the browser from the precomputed criterion layers. That is the feature that
turns a map into a decision tool, and it is cheap — a weighted sum of a few
small arrays.

Mission presets move the sliders in one click: *Crewed* weights survivability
and comms hard; *Robotic / ISRU* weights PSR proximity and ice.

---

## 2. Data

| Layer | Product | Source | Status |
|---|---|---|---|
| Terrain, regional | LOLA polar GDR 240 m, 120 m | PDS Geosciences | **on disk** |
| Terrain, site | LOLA polar GDR 20 m | PDS Geosciences | **in use** — supersampled detail |
| Terrain, finalists | LOLA+NAC co-registered DTM 1-2 m | PGDA | todo |
| Illumination truth | PGDA illumination / Earth-visibility maps | PGDA | todo — **validation only** |
| PSR polygons | derived from our own illumination run | — | **done** — 6106 points |
| Temperature | Diviner bolometric max / average | PDS Geosciences | todo |
| Albedo / imagery | LROC WAC mosaic; NAC for sites | LROC | **ruled out as a polar base layer** |
| Inside the PSRs | ShadowCam (KPLO) | PDS | todo — hero asset |
| Ephemeris | de440, moon_pa_de440, pck00011, naif0012 | NAIF | reachable |

Note on resolution honesty: the LOLA 5 m polar product is **interpolated** —
real ground-track spacing is coarser. The 240 m and 120 m products are well
supported by actual measurements. Use LOLA+NAC DTMs for anything claiming
metre-scale fidelity.

PSR is not ice. A permanently shadowed region is where ice *can* be
cold-trapped. Stability needs Diviner temperatures (below ~110 K for H2O). Do
not conflate these in the UI or the pitch.

---

## 3. Technical core: horizon-based illumination

Near the pole the Sun sits within a couple of degrees of the horizon, so
whether a point is lit is decided **entirely by distant terrain**. This is the
whole problem and the project's main differentiator.

1. Reproject the DEM to polar stereographic (done — `pipeline/lola.py`).
2. For every pixel compute a **horizon mask**: maximum obstruction elevation
   angle in 360 azimuth bins, via a Dozier-style sweep, with the lunar
   curvature drop-off `h_eff = h - d^2/(2R)` applied along each ray.
3. Step time (1 h over a year; 5 min for finalists). At each step get Sun and
   Earth az/el from SPICE in the local topocentric frame. A point is lit when
   `sun_el > horizon(az)`.
   - Treat the Sun as a **disc** (~0.26 deg radius), not a point, so grazing
     illumination is partial rather than binary.
   - Same for Earth (~0.9 deg radius), where libration makes it bob by several
     degrees and decides comms at marginal sites.
4. Accumulate: illumination %, longest continuous night, Earth-visibility %,
   longest blackout.

**Already built.** `shade.cast_shadow()` is the single-direction case of step 2
— same ray march, same `d^2/2R` curvature term. The horizon mask generalises it
to 360 azimuths.

### Resolution strategy — required, or the compute explodes

The full 80-90S region at 20 m is ~900 M pixels. Horizon on that is not a
hackathon job. Go hierarchical:

- **Tier 1 — screening.** Whole region at 120-240 m (~3800 px square). Feasible
  in numpy/numba in minutes. Produces the shortlist.
- **Tier 2 — sites.** 5-20 m over ~10 km boxes for the top 10-15.
  *Critical:* combine near-field high-res horizon with **far-field coarse
  horizon**. A massif 100 km away still shadows you.
- **Tier 3 — finalists.** 1-2 m LOLA+NAC for the ground-level renders.

---

## 4. Validation — this is what convinces a judge

Two free credibility wins, both cheap:

1. **Against published maps.** Compare computed illumination to the PGDA
   illumination maps at known points (Connecting Ridge, Shackleton rim,
   de Gerlache rim). Report the agreement as a number.
2. **Against NASA's own shortlist.** Check whether the scorer independently
   rediscovers the refined Artemis III candidate regions (Mons Mouton,
   Malapert Massif, de Gerlache Rim, Nobile Rim, Haworth, Cabeus B, Slater
   Plain — verify the current list against NASA's page). Agreement proves the
   model. Disagreement is an interesting story about *why*. Either way it is a
   slide.

Phase A already applied this discipline to the projection: centre pixel
resolves to -90.000 deg, edge to -75.005 deg, computed half-width 457.44 km
against 457.4 km derived analytically. Keep doing this at every stage.

---

## 5. App architecture

**Static site, no backend.** Python precomputes everything; the frontend reads
ready numbers and does the weighted sum. Free hosting, instant load, nothing to
break during a demo.

- Precompute: numpy, numba, scipy, spiceypy, Pillow (**no GDAL** — the polar
  GDRs are flat uncompressed int16)
- Globe and site views: **CesiumJS** on `Ellipsoid.MOON`
- Ground view: Cesium if it holds up at site resolution, else three.js
- Charts: per-site illumination time series

Encode weights + selected site + date window **in the URL**, so any view is a
shareable link and the demo is a bookmark that cannot fail live.

### Screens — one continuous zoom, the globe never unmounts

**1. Region view (home).** Polar globe, score heatmap, numbered pins. Left
panel: mission preset, criterion weight sliders, hard limits. Right: ranked
site list. Bottom: layer switcher and mission-window slider. Dragging a weight
re-sorts the map and the list *instantly* — the moment that sells the project.

**2. Site dossier.** Camera flies down. Local 3D terrain with a draggable
marker; every criterion as a number with a pass/fail bar; illumination across
the mission window with the longest gap called out; imagery toggles (NAC,
ShadowCam, slope, illumination). Moving the marker 200 m changes the numbers —
which makes the point that "a site" is really a 50-metre decision.

**3. Ground view.** First-person from the marker. True horizon profile drawn
from the computed mask. Press play and the Sun **circles the horizon instead of
rising and setting**. That single animation explains polar illumination better
than any paragraph. Label it clearly as a synthetic render from elevation —
there are no ground photos of these sites.

**4. Compare.** Two or three sites, radar chart per criterion, plus a
difference table naming the actual trade. First screen to cut if time is short.

**5. Method and validation.** Pipeline diagram, agreement with PGDA, overlap
with NASA's candidate regions. The judge tab.

### Visual direction

Near-black, scientific rather than sci-fi. One sequential ramp for the score,
one accent for interactive elements, muted grey chrome, monospace numerals so
columns align. No glow, no starfield, no purple gradients — it should look like
a tool a mission planner was handed, which is also what makes it stand out in a
room full of space-themed projects.

---

## 6. Phases

| Phase | Output | Status |
|---|---|---|
| A | Data fetch, projection, terrain rendering in Cesium | **done** |
| B | Horizon + illumination engine; SPICE Sun/Earth | **done** (PGDA cross-check outstanding) |
| C | Tier-1 regional run, scored map, shortlist | **done** — coarse + fine screen |
| D | Cesium globe with layers + live slider scoring | **done** |
| E | Tier-2/3 sites, ground view, timeline scrubber | |
| F | ShadowCam / NAC imagery, lander context, validation write-up | |

**Phase B is the risk.** Everything else is assembly. If the horizon engine
slips, this is a map viewer instead of a decision tool — so build it first, on
a small test tile, before any more frontend work.

---

## 7. Open decisions

- **Tile the 20 m DEM now, or start Phase B?** Tiling sharpens the view at
  depth and is required for deployment (current assets are ~175 MB, loaded
  whole — fine on localhost, nowhere else). Phase B is the critical path.
- **Ground view: must-have or stretch?** Most demo-friendly piece, most work
  after Phase B.
- **Deadline.** 48 hours means Tier-1 only plus PGDA maps as a shortcut; three
  weeks puts the full horizon engine comfortably in reach.
- **Albedo.** Add LROC WAC imagery for a photographic base layer, or keep the
  rendered-regolith look? The rendered look is honest and consistent; WAC is
  real but seam-heavy and inconsistently lit near the pole.

---

## 8. Gotchas already paid for

See `README.md` for the full log. The expensive ones:

- Cesium's bundled ion demo token cannot reach Cesium Moon Terrain. Irrelevant
  now — terrain is built from LOLA directly, so there is no ion dependency, no
  rate limit, and nothing to fail on demo day.
- `globe.cartographicLimitRectangle` is required or imagery smears radially
  past the 75S data edge.
- Keep `globe.showSkirts` on, or terrain cracks visibly in oblique views.
- Taper terrain to the reference sphere at the coverage edge, or the limb
  renders as a comb of spikes.
- Zero the camera controller inertias, or a programmatic `setView` drifts
  ~16 km in 3 s — which will matter when flying to sites from the ranked list.
- LROC WAC photography is NOT usable as a polar base layer: ~39% of the
  south-polar mosaic is pure black and it degenerates into smeared streaks
  approaching the pole. See `docs/wac_polar_sample.png`, reproduce with
  `pipeline/sample_wac.py`. There is no good photographic albedo for this
  region -- which is exactly why ShadowCam exists.
- A literal "full moon" render is useless: at zero phase angle nothing casts a
  visible shadow and all relief vanishes. Real full-moon detail is albedo,
  which LOLA does not carry. See `docs/sun_compare.png`.
