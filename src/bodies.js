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

const SKY_DIST = 70_000;      // m from the site -- display only
// True angular radii are 0.27 deg (Sun) and ~0.95 deg (Earth). At those sizes
// both are a handful of pixels, so they are magnified for visibility. The
// factor is shown in the UI; direction and phase stay exact.
const MAGNIFY = 9;
const SUN_ANG_DEG = 0.271;
const EARTH_ANG_DEG = 0.95;
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

    const sizeFor = (angDeg) =>
      2 * SKY_DIST * Math.tan(Cesium.Math.toRadians(angDeg)) * MAGNIFY;

    const mk = (name, color, angDeg) => viewer.entities.add({
      show: false,
      position: new Cesium.CallbackProperty(() => this._pos(name), false),
      billboard: {
        image: new Cesium.CallbackProperty(
          () => (name === "sun" ? this.sunCanvas : this.earthCanvas), false),
        sizeInMeters: true,
        width: sizeFor(angDeg) * (name === "sun" ? 3.2 : 1.0),  // corona
        height: sizeFor(angDeg) * (name === "sun" ? 3.2 : 1.0),
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
      },
      // Sight line back to the landing site, so the bearing is anchored to the
      // point being evaluated. Hidden once the camera is essentially at the
      // site, where the line is end-on and reads as a meaningless vertical.
      polyline: {
        positions: new Cesium.CallbackProperty(() => {
          if (!this.site || this._cameraAtSite()) return [];
          const p = this._pos(name);
          return p ? [this._sitePos(), p] : [];
        }, false),
        width: 1.5,
        material: new Cesium.PolylineDashMaterialProperty({
          color: Cesium.Color.fromCssColorString(color).withAlpha(0.6),
          dashLength: 14,
        }),
        arcType: Cesium.ArcType.NONE,
      },
    });

    this.sun = mk("sun", SUN_COLOR, SUN_ANG_DEG);
    this.earth = mk("earth", EARTH_COLOR, EARTH_ANG_DEG);
  }

  /** True when the camera is close enough that the sight line degenerates. */
  _cameraAtSite() {
    if (!this.site) return false;
    const d = Cesium.Cartesian3.distance(
      this.viewer.camera.position, this._sitePos());
    return d < SKY_DIST * 0.12;
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

  _pos(name) {
    if (!this.site) return undefined;
    const d = this._dir(name);
    return Cesium.Cartesian3.add(
      this._sitePos(),
      Cesium.Cartesian3.multiplyByScalar(d, SKY_DIST, new Cesium.Cartesian3()),
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
