import * as Cesium from "cesium";
import { SUN_COLOR, EARTH_COLOR } from "./sites.js";
import { loadEarthTexture, drawEarth, drawSun } from "./render_bodies.js";

/**
 * Sun and Earth drawn in the sky over the selected site.
 *
 * Both are placed along the direction **from that site**, not from the Moon's
 * centre. Parallax between the two is a few degrees for the Sun and about
 * 0.26 deg for Earth -- irrelevant on most bodies, decisive here, where the
 * Sun spends the whole year within 1.5 deg of the horizon and Earth sits
 * roughly on it.
 *
 * Distance is compressed so both stay on screen at site zoom. Direction is
 * exact, which is what the elevation readout depends on; the range is not, so
 * neither body is drawn to physical scale.
 */

// Both bodies sit at their true positions and true size. Placing them nearby
// made them look like props resting on the surface; at real range they read as
// what they are, and the angular sizes (0.5 deg Sun, ~1.9 deg Earth) then come
// out right on their own with no fudge factor.
const SUN_RADIUS_M = 695_700_000;
const EARTH_RADIUS_M = 6_371_000;
// The Sun canvas is mostly corona: its core disc spans this fraction of the
// image, so the billboard is scaled up to make the core subtend correctly.
const SUN_CORE_FRAC = 0.30;
// The sight line only marks the bearing -- drawn to Earth's true distance it
// would be a 384,000 km streak.
const RAY_LEN = 55_000;
const MOON = Cesium.Ellipsoid.MOON;

export { loadEarthTexture };

export class SkyBodies {
  constructor(viewer, sky) {
    this.viewer = viewer;
    this.sky = sky;
    this.index = 0;
    this.site = null;

    this.sunCanvas = drawSun(document.createElement("canvas"));
    this.earthCanvas = document.createElement("canvas");
    this._lastDrawn = -1;

    const mk = (name, color, widthM) => viewer.entities.add({
      show: false,
      position: new Cesium.CallbackProperty(() => this._pos(name), false),
      billboard: {
        image: new Cesium.CallbackProperty(
          () => (name === "sun" ? this.sunCanvas : this.earthCanvas), false),
        // Sized in pixels from the true angular diameter rather than with
        // sizeInMeters: at 10^8 km the metre-based path loses all precision
        // and the billboard disappears. This keeps the apparent size exact and
        // makes it grow as the field of view narrows, like a telescope.
        scale: new Cesium.CallbackProperty(() => this._scale(name), false),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: name.toUpperCase(),
        font: "600 10px ui-monospace, Menlo, Consolas, monospace",
        fillColor: Cesium.Color.fromCssColorString(color),
        showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#0b0c0eD8"),
        backgroundPadding: new Cesium.Cartesian2(5, 3),
        pixelOffset: new Cesium.Cartesian2(0, -26),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
        translucencyByDistance: new Cesium.NearFarScalar(1e6, 1.0, 1e9, 1.0),
      },
      // A short ray from the landing site marking the bearing only.
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          if (!this.site || this._cameraAtSite()) return [];
          return [this._sitePos(), this._rayEnd(name)];
        }, false),
        width: 1.5,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString(color).withAlpha(0.6),
          dashLength: 14,
        }),
        arcType: Cesium.ArcType.NONE,
      },
    });

    this.sun = mk("sun", SUN_COLOR, (2 * SUN_RADIUS_M) / SUN_CORE_FRAC);
    this.earth = mk("earth", EARTH_COLOR, 2 * EARTH_RADIUS_M);
  }

  /** True when the camera is close enough that the sight line degenerates. */
  _cameraAtSite() {
    if (!this.site) return false;
    const d = Cesium.Cartesian3.distance(
      this.viewer.camera.position, this._sitePos());
    return d < RAY_LEN * 0.15;
  }

  _sitePos() {
    const s = this.site;
    return Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.elev, MOON);
  }

  /** Unit direction to a body, as seen from the site. */
  _dir(name) {
    const sky = this.sky;
    const dir = name === "sun" ? sky.sunDir[this.index] : sky.earthDir[this.index];
    const distKm = name === "sun"
      ? sky.sunDistKm[this.index] : sky.earthDistKm[this.index];
    const body = new Cesium.Cartesian3(
      dir[0] * distKm * 1000, dir[1] * distKm * 1000, dir[2] * distKm * 1000);
    const v = Cesium.Cartesian3.subtract(body, this._sitePos(),
      new Cesium.Cartesian3());
    return Cesium.Cartesian3.normalize(v, v);
  }

  /** The body's actual position in MOON_ME, in metres. */
  _pos(name) {
    const sky = this.sky;
    const dir = name === "sun" ? sky.sunDir[this.index] : sky.earthDir[this.index];
    const distM = (name === "sun"
      ? sky.sunDistKm[this.index] : sky.earthDistKm[this.index]) * 1000;
    return new Cesium.Cartesian3(
      dir[0] * distM, dir[1] * distM, dir[2] * distM);
  }

  /** Billboard scale so the disc subtends its true angular size on screen. */
  _scale(name) {
    const cam = this.viewer.camera;
    const pos = this._pos(name);
    const dist = Cesium.Cartesian3.distance(pos, cam.position);
    const radius = name === "sun" ? SUN_RADIUS_M : EARTH_RADIUS_M;
    const angDiam = 2 * Math.atan(radius / dist);           // radians

    const fovY = cam.frustum.fovy ?? Cesium.Math.toRadians(60);
    const h = this.viewer.scene.canvas.clientHeight || 720;
    let px = (angDiam / fovY) * h;
    if (name === "sun") px /= SUN_CORE_FRAC;                 // core, not corona

    const base = name === "sun" ? this.sunCanvas.width : this.earthCanvas.width;
    // A floor keeps both findable when zoomed out; the Sun is only 0.5 deg.
    return Math.max(px, name === "sun" ? 14 : 10) / base;
  }

  _rayEnd(name) {
    const d = this._dir(name);
    return Cesium.Cartesian3.add(
      this._sitePos(),
      Cesium.Cartesian3.multiplyByScalar(d, RAY_LEN, new Cesium.Cartesian3()),
      new Cesium.Cartesian3());
  }

  /** Azimuth and elevation of a body from the site, in degrees. */
  azel(name) {
    if (!this.site) return null;
    const lat = Cesium.Math.toRadians(this.site.lat);
    const lon = Cesium.Math.toRadians(this.site.lon);
    const sl = Math.sin(lat), cl = Math.cos(lat);
    const so = Math.sin(lon), co = Math.cos(lon);
    const d = this._dir(name);
    const e = -so * d.x + co * d.y;
    const n = -sl * co * d.x - sl * so * d.y + cl * d.z;
    const u = cl * co * d.x + cl * so * d.y + sl * d.z;
    return {
      az: ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360,
      el: (Math.asin(Math.max(-1, Math.min(1, u))) * 180) / Math.PI,
    };
  }

  setSite(site) {
    this.site = site;
    this._lastDrawn = -1;
    this._redrawEarth();
    this.sun.show = !!site;
    this.earth.show = !!site;
  }

  setIndex(i) {
    this.index = Math.max(0, Math.min(i, this.sky.sunDir.length - 1));
    this._redrawEarth();
  }

  _redrawEarth() {
    if (this._lastDrawn === this.index) return;
    this._lastDrawn = this.index;
    const sky = this.sky;
    if (!sky.earthRot) return;
    drawEarth(this.earthCanvas, sky.earthDir[this.index],
      sky.sunDir[this.index], sky.earthRot[this.index]);
  }

  get epoch() {
    return this.sky.epochs[this.index];
  }

  hide() {
    this.sun.show = false;
    this.earth.show = false;
    this.site = null;
  }
}
