import * as Cesium from "cesium";
import "cesium/Build/Cesium/Widgets/widgets.css";
import "./style.css";
import { loadDem, loadGlobalDem, Terrain } from "./lola.js";

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
  scene.screenSpaceCameraController.minimumZoomDistance = 60;
  // Leftover inertia drifts the camera off a programmatic setView, which
  // matters once sites are flown to from the ranked list.
  scene.screenSpaceCameraController.inertiaSpin = 0;
  scene.screenSpaceCameraController.inertiaTranslate = 0;
  scene.screenSpaceCameraController.inertiaZoom = 0;

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

  el("btnGlobe").addEventListener("click", () =>
    viewer.camera.flyTo({ ...GLOBE(), duration: 2.0 }));
  el("btnHome").addEventListener("click", () =>
    viewer.camera.flyTo({ ...POLE(), duration: 2.0 }));
  el("btnOblique").addEventListener("click", () =>
    viewer.camera.flyTo({ ...view(-86.5, 90_000, -22, 180), duration: 2.2 }));

  boot.classList.add("gone");
  setTimeout(() => boot.remove(), 650);
  setTimeout(() => viewer.camera.flyTo({ ...POLE(), duration: 4.0,
    easingFunction: Cesium.EasingFunction.QUADRATIC_IN_OUT }), 900);

  Object.assign(window, { viewer, Cesium, terrain, polarLayer });
}

main().catch((err) => {
  console.error(err);
  setBoot(`FAILED: ${err.message}`);
  boot.classList.add("failed");
});
