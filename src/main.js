import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import "./style.css";
import { loadDem, loadGlobalDem, Terrain } from "./lola.js";
import { setupNavigation } from "./navigation.js";
import { loadSites, addSiteMarkers, drawHorizon } from "./sites.js";
import { CRITERIA, PRESETS, ranges, score } from "./scoring.js";
import { SkyBodies, loadEarthTexture } from "./bodies.js";

// Must be set before any Viewer/Globe is constructed.
Cesium.Ellipsoid.default = Cesium.Ellipsoid.MOON;

const POLAR_COVERAGE = Cesium.Rectangle.fromDegrees(-180, -90, 180, -75);
const TILE_SAMPLES = 128;   // heightmap posts per terrain tile edge

// LROC WAC global mosaic, served by NASA Moon Trek. Same tiling as Cesium's
// GeographicTilingScheme (2x1 at level 0, 256 px tiles, origin -180/90), so it
// maps straight across. Useless at the pole -- see docs/wac_polar_sample.png --
// which is exactly what the polar relief overlay is for.
const WAC_URL =
  "https://trek.nasa.gov/tiles/Moon/EQ/LRO_WAC_Mosaic_Global_303ppd_v02" +
  "/1.0.0//default/default028mm/{z}/{y}/{x}.jpg";

const boot = document.getElementById("boot");
const bootMsg = document.getElementById("bootMsg");
const bootBar = document.getElementById("bootBar");

const setBoot = (msg, frac) => {
  bootMsg.textContent = msg;
  if (frac !== undefined) bootBar.style.transform = `scaleX(${frac})`;
};

async function main() {
  setBoot("LOADING GLOBAL TERRAIN", 0);
  const global = await loadGlobalDem("/data", (f) =>
    setBoot(`LOADING GLOBAL TERRAIN  ${Math.round(f * 100)}%`, f * 0.2));

  setBoot("LOADING POLAR TERRAIN", 0.2);
  const polar = await loadDem("/data", (f) =>
    setBoot(`LOADING POLAR TERRAIN  ${Math.round(f * 100)}%`, 0.2 + f * 0.8));

  const terrain = new Terrain(global, polar);
  setBoot("BUILDING TERRAIN", 1);

  const terrainProvider = new Cesium.CustomHeightmapTerrainProvider({
    width: TILE_SAMPLES,
    height: TILE_SAMPLES,
    ellipsoid: Cesium.Ellipsoid.MOON,
    tilingScheme: new Cesium.GeographicTilingScheme({
      ellipsoid: Cesium.Ellipsoid.MOON,
    }),
    callback: (x, y, level) => {
      const rect = terrainProvider.tilingScheme.tileXYToRectangle(x, y, level);
      const w = TILE_SAMPLES, h = TILE_SAMPLES;
      const out = new Float32Array(w * h);
      const dLon = (rect.east - rect.west) / (w - 1);
      const dLat = (rect.north - rect.south) / (h - 1);
      for (let j = 0; j < h; j++) {
        // heightmap rows run north -> south
        const lat = Cesium.Math.toDegrees(rect.north - j * dLat);
        for (let i = 0; i < w; i++) {
          const lon = Cesium.Math.toDegrees(rect.west + i * dLon);
          out[j * w + i] = terrain.heightForTerrain(lat, lon);
        }
      }
      return out;
    },
  });

  const viewer = new Cesium.Viewer("cesiumContainer", {
    terrainProvider,
    baseLayer: Cesium.ImageryLayer.fromProviderAsync(
      Promise.resolve(new Cesium.UrlTemplateImageryProvider({
        url: WAC_URL,
        tilingScheme: new Cesium.GeographicTilingScheme({
          ellipsoid: Cesium.Ellipsoid.MOON,
        }),
        tileWidth: 256,
        tileHeight: 256,
        maximumLevel: 8,
        credit: "LROC WAC mosaic — NASA/GSFC/ASU, served by NASA Moon Trek",
      })),
      {},
    ),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    sceneModePicker: false,
    navigationHelpButton: false,
    animation: false,
    timeline: false,
    fullscreenButton: false,
    infoBox: false,
    selectionIndicator: false,
    scene3DOnly: true,
    skyAtmosphere: false,
    msaaSamples: 4,
    contextOptions: { webgl: { powerPreference: "high-performance" } },
  });

  const { scene } = viewer;

  // Our rendered polar relief, over the top of WAC where WAC goes black.
  // Its alpha ramps in from 76S so there is no hard circular seam.
  const polarLayer = viewer.imageryLayers.addImageryProvider(
    await Cesium.SingleTileImageryProvider.fromUrl(
      "/data/hillshade_south.png", { rectangle: POLAR_COVERAGE }),
  );

  scene.globe.baseColor = Cesium.Color.fromCssColorString("#15171b");
  scene.globe.showGroundAtmosphere = false;
  // Shading is baked into the imagery from a real Sun elevation; Cesium's own
  // lighting is Earth-referenced, so it stays off until SPICE lands.
  scene.globe.enableLighting = false;
  // With a non-WGS84 ellipsoid Cesium does not create these at all.
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  scene.globe.maximumScreenSpaceError = 1.5;
  scene.verticalExaggeration = 1.6;

  const nav = setupNavigation(viewer, {
    getHeight: (lat, lon) => terrain.heightAt(lat, lon),
  });

  const view = (lat, alt, pitchDeg, headingDeg = 0) => ({
    destination: Cesium.Cartesian3.fromDegrees(0, lat, alt, Cesium.Ellipsoid.MOON),
    orientation: {
      heading: Cesium.Math.toRadians(headingDeg),
      pitch: Cesium.Math.toRadians(pitchDeg),
      roll: 0,
    },
  });
  const GLOBE = () => view(-28, 5_200_000, -90);
  const POLE = () => view(-90, 1_500_000, -90);

  // Open on the whole Moon, then settle toward the south pole.
  nav.settle();
  viewer.camera.setView(GLOBE());

  document.getElementById("srcTag").textContent =
    `global ${global.w}×${global.h} · polar ${polar.n}² @ ${polar.meta.mapScale} m/px`;

  // --- HUD -----------------------------------------------------------------
  const el = (id) => document.getElementById(id);

  const handler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
  handler.setInputAction((move) => {
    const picked = scene.pickPosition(move.endPosition);
    if (!Cesium.defined(picked)) return;
    const carto = Cesium.Ellipsoid.MOON.cartesianToCartographic(picked);
    if (!carto || !Number.isFinite(carto.latitude)) return;
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = ((Cesium.Math.toDegrees(carto.longitude) % 360) + 360) % 360;
    el("hLat").textContent = `${lat.toFixed(3)}°`;
    el("hLon").textContent = `${lon.toFixed(2)}°`;
    const z = terrain.heightAt(lat, lon);
    el("hElev").textContent = Number.isFinite(z) ? `${z.toFixed(0)} m` : "—";
  }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

  scene.postRender.addEventListener(() => {
    const h = Cesium.Ellipsoid.MOON.cartesianToCartographic(viewer.camera.position)?.height;
    el("hAlt").textContent = Number.isFinite(h)
      ? h > 1000 ? `${(h / 1000).toFixed(1)} km` : `${h.toFixed(0)} m`
      : "—";
  });

  const vex = el("vex");
  vex.value = String(scene.verticalExaggeration);
  el("vexVal").textContent = `${scene.verticalExaggeration.toFixed(1)}×`;
  vex.addEventListener("input", () => {
    scene.verticalExaggeration = Number(vex.value);
    el("vexVal").textContent = `${Number(vex.value).toFixed(1)}×`;
  });

  const relief = el("relief");
  relief.addEventListener("change", () => { polarLayer.show = relief.checked; });

  el("btnGlobe").addEventListener("click", () => {
    nav.settle();
    viewer.camera.flyTo({ ...GLOBE(), duration: 2.0,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT });
  });
  el("btnHome").addEventListener("click", () => {
    nav.settle();
    viewer.camera.flyTo({ ...POLE(), duration: 2.0,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT });
  });
  el("btnOblique").addEventListener("click", () => {
    nav.settle();
    viewer.camera.flyTo({ ...view(-86.5, 90_000, -22, 180), duration: 2.2,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT });
  });

  // --- candidate sites ------------------------------------------------------
  const doc = await loadSites();
  const sky = doc.sky;
  const panel = el("sitePanel");
  const rng = ranges(doc.sites);

  const weights = { ...PRESETS.balanced };
  const limits = { maxSlope: 15, maxNight: 400 };
  let ranked = [];
  let current = null;

  // weight sliders
  el("weights").innerHTML = CRITERIA.map((c) => `
    <div class="wrow" title="${c.hint}">
      <div class="lab"><span>${c.label}</span><b id="w-${c.key}-v"></b></div>
      <input id="w-${c.key}" type="range" min="0" max="1" step="0.05">
    </div>`).join("");

  const syncWeights = () => {
    for (const c of CRITERIA) {
      el(`w-${c.key}`).value = String(weights[c.key]);
      el(`w-${c.key}-v`).textContent = weights[c.key].toFixed(2);
    }
  };

  const renderList = () => {
    const ok = ranked.filter((s) => !s.excluded).length;
    el("rankCount").textContent = `${ok}/${ranked.length}`;
    el("rankList").innerHTML = ranked.map((s) => `
      <li data-id="${s.id}" class="${s.excluded ? "is-out" : ""}${
        current && current.id === s.id ? " is-sel" : ""}"
          title="${s.excluded ? s.reasons.join("; ") : `score ${s.score.toFixed(1)}`}">
        <span class="n">${s.rank}</span>
        <span class="co">${Math.abs(s.lat).toFixed(2)}°S ${s.lon.toFixed(1)}°E</span>
        <span class="sc">${s.excluded ? "✕" : s.score.toFixed(0)}</span>
      </li>`).join("");
    for (const li of el("rankList").querySelectorAll("li")) {
      li.addEventListener("click", () => {
        const site = ranked.find((x) => x.id === Number(li.dataset.id));
        if (site) showSite(site);
      });
    }
  };

  const rescore = () => {
    ranked = score(doc.sites, weights, limits, rng);
    for (const m of markers || []) {
      const s = ranked.find((x) => x.id === m.siteData.id);
      if (!s) continue;
      m.label.text = String(s.rank);
      const dim = s.excluded;
      m.point.color = Cesium.Color.fromCssColorString(dim ? "#8a6a6a" : "#e8eaed");
      m.point.pixelSize = dim ? 6 : (s.rank <= 3 ? 11 : 8);
      m.label.fillColor = Cesium.Color.fromCssColorString(dim ? "#e66767" : "#e8eaed");
    }
    renderList();
    if (current) {
      const updated = ranked.find((x) => x.id === current.id);
      if (updated) showSite(updated, false);
    }
  };

  const showSite = (site, fly = true) => {
    // Markers carry the raw site; score and rank live on the ranked copy, so
    // always resolve through it or the panel reads undefined.
    const s = ranked.find((x) => x.id === site.id) || site;
    current = s;
    el("spRank").textContent = `#${s.rank}`;
    el("spCoord").textContent =
      `${Math.abs(s.lat).toFixed(4)}°S  ${s.lon.toFixed(3)}°E`;
    el("spSun").textContent = `${s.sunPct.toFixed(1)}%`;
    el("spEarth").textContent = `${s.earthPct.toFixed(1)}%`;
    el("spSunBar").style.width = `${s.sunPct}%`;
    el("spEarthBar").style.width = `${s.earthPct}%`;
    el("spNight").textContent = `${s.nightH.toFixed(0)} h`;
    el("spBlack").textContent = `${s.blackoutH.toFixed(0)} h`;
    el("spElev").textContent = `${s.elev.toFixed(0)} m`;
    el("spSlope").textContent = s.slopeMaxDeg == null ? "—"
      : `${s.slopeDeg.toFixed(1)}° / ${s.slopeMaxDeg.toFixed(1)}° max`;
    el("spRough").textContent = s.roughnessM == null ? "—"
      : `${s.roughnessM.toFixed(1)} m`;
    el("spPsr").textContent = `${s.psrKm.toFixed(1)} km`;
    el("spScore").textContent = s.excluded ? "excluded" : s.score.toFixed(1);

    const ex = el("spExcl");
    ex.classList.toggle("hidden", !s.excluded);
    if (s.excluded) ex.textContent = `Fails hard limit — ${s.reasons.join("; ")}`;

    panel.classList.remove("hidden");
    bodies.setSite(s);
    updateNow();
    drawHorizon(el("spSky"), s, sky);
    renderList();
    if (!fly) return;
    nav.settle();
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, 26_000,
        Cesium.Ellipsoid.MOON),
      orientation: { heading: 0, pitch: Cesium.Math.toRadians(-55), roll: 0 },
      duration: 2.0,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });
  };

  await loadEarthTexture();
  const bodies = new SkyBodies(viewer, sky);
  const markers = addSiteMarkers(viewer, doc.sites, showSite);

  // --- time scrubber: watch the Sun circle this site's horizon -------------
  const fmtEpoch = (iso) => {
    const [d, t] = iso.split("T");
    return `${d}  ${t.slice(0, 5)} UTC`;
  };
  const updateNow = () => {
    el("nowEpoch").textContent = fmtEpoch(bodies.epoch);
    for (const [name, id] of [["sun", "nowSun"], ["earth", "nowEarth"]]) {
      const ae = bodies.azel(name);
      if (!ae) { el(id).textContent = "—"; continue; }
      const hor = current
        ? current.horizon[Math.round((ae.az / 360) * current.horizon.length)
            % current.horizon.length]
        : 0;
      const up = ae.el > hor;
      el(id).textContent = `${ae.el >= 0 ? "+" : ""}${ae.el.toFixed(2)}°`;
      el(id).className = up ? (name === "sun" ? "lit" : "vis") : "";
      el(id).title = up ? "above the local skyline" : "blocked by terrain";
    }
  };

  // Looking down at 55 deg hides both bodies: they sit on the horizon. This
  // drops the camera to the site and looks out along the Sun's bearing.
  const standHere = (name = "sun") => {
    if (!current) return;
    const ae = bodies.azel(name);
    nav.settle();
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        current.lon, current.lat, current.elev + 250, Cesium.Ellipsoid.MOON),
      orientation: {
        heading: Cesium.Math.toRadians(ae ? ae.az : 0),
        pitch: Cesium.Math.toRadians(1.5),
        roll: 0,
      },
      duration: 2.0,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT,
    });
  };
  el("spStandSun").addEventListener("click", () => standHere("sun"));
  el("spStandEarth").addEventListener("click", () => standHere("earth"));

  const time = el("nowTime");
  time.max = String(sky.sunDir.length - 1);
  time.addEventListener("input", () => {
    bodies.setIndex(Number(time.value));
    updateNow();
  });

  let playing = null;
  el("nowPlay").addEventListener("click", () => {
    if (playing) {
      clearInterval(playing); playing = null;
      el("nowPlay").textContent = "▶";
      return;
    }
    el("nowPlay").textContent = "❚❚";
    playing = setInterval(() => {
      const next = (Number(time.value) + 1) % sky.sunDir.length;
      time.value = String(next);
      bodies.setIndex(next);
      updateNow();
    }, 60);
  });

  for (const c of CRITERIA) {
    el(`w-${c.key}`).addEventListener("input", (e) => {
      weights[c.key] = Number(e.target.value);
      el(`w-${c.key}-v`).textContent = weights[c.key].toFixed(2);
      for (const b of document.querySelectorAll(".preset")) b.classList.remove("is-on");
      rescore();
    });
  }
  for (const b of document.querySelectorAll(".preset")) {
    b.addEventListener("click", () => {
      Object.assign(weights, PRESETS[b.dataset.preset]);
      for (const o of document.querySelectorAll(".preset")) o.classList.remove("is-on");
      b.classList.add("is-on");
      syncWeights();
      rescore();
    });
  }
  el("limSlope").addEventListener("input", (e) => {
    limits.maxSlope = Number(e.target.value);
    el("limSlopeVal").textContent = `${limits.maxSlope}°`;
    rescore();
  });
  el("limNight").addEventListener("input", (e) => {
    limits.maxNight = Number(e.target.value);
    el("limNightVal").textContent = `${limits.maxNight} h`;
    rescore();
  });

  el("spClose").addEventListener("click", () => {
    panel.classList.add("hidden");
    bodies.hide();
  });
  el("showSites").addEventListener("change", (e) => {
    for (const m of markers) m.show = e.target.checked;
    el("ranking").style.display = e.target.checked ? "" : "none";
    if (!e.target.checked) panel.classList.add("hidden");
  });
  window.addEventListener("resize", () => {
    if (current && !panel.classList.contains("hidden")) {
      drawHorizon(el("spSky"), current, sky);
    }
  });

  syncWeights();
  rescore();

  boot.classList.add("gone");
  setTimeout(() => boot.remove(), 650);
  setTimeout(() => {
    nav.settle();
    viewer.camera.flyTo({ ...POLE(), duration: 4.0,
      easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT });
  }, 900);

  Object.assign(window, { viewer, Cesium, terrain, polarLayer, nav, doc, showSite, rescore, bodies });
}

main().catch((err) => {
  console.error(err);
  setBoot(`FAILED: ${err.message}`);
  boot.classList.add("failed");
});
