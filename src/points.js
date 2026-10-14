import * as Cesium from "cesium";

/**
 * The full screening grid as a scored map.
 *
 * 31,417 candidates is far too many for Cesium entities, so these go into a
 * PointPrimitiveCollection -- one draw call, no entity overhead.
 *
 * Colour is sequential: a single hue, never a rainbow. The ramp runs dark to
 * bright with increasing value, which is the dark-surface direction -- on a
 * near-black globe "more" has to mean "brighter", or permanently shadowed
 * crater floors come out glowing while sunlit ridges go dark.
 *
 * Each layer keeps the hue of the thing it measures, so the Sun layer is amber
 * and the Earth layer blue, matching the horizon chart's series colours.
 */

export const LAYERS = {
  sun: {
    label: "Solar exposure", field: "sun_pct", unit: "%", invert: false,
    // amber, dark -> bright (same hue as the Sun series)
    ramp: [[38, 28, 14], [120, 76, 0], [201, 133, 0], [247, 206, 118], [255, 247, 225]],
  },
  earth: {
    label: "Earth visibility", field: "earth_pct", unit: "%", invert: false,
    ramp: [[13, 25, 43], [25, 72, 134], [57, 135, 229], [150, 196, 243], [233, 243, 255]],
  },
  night: {
    label: "Longest night", field: "night_h", unit: " h", invert: true,
    ramp: [[26, 26, 25], [68, 66, 64], [122, 118, 114], [186, 182, 178], [240, 238, 236]],
  },
};

const BYTES_PER_POINT = 8 * 4;   // eight float32 fields

export async function loadPoints(base = "/data") {
  const [meta, buf] = await Promise.all([
    fetch(`${base}/screen_points.json`).then((r) => r.json()),
    fetch(`${base}/screen_points.bin`).then((r) => r.arrayBuffer()),
  ]);
  const data = new Float32Array(buf);
  if (data.length !== meta.count * meta.fields.length) {
    throw new Error(`screen_points size mismatch: ${data.length}`);
  }
  return { meta, data, stride: meta.fields.length };
}

function sample(ramp, t) {
  const x = Math.max(0, Math.min(1, t)) * (ramp.length - 1);
  const i = Math.min(Math.floor(x), ramp.length - 2);
  const f = x - i;
  const a = ramp[i], b = ramp[i + 1];
  return new Cesium.Color(
    (a[0] + (b[0] - a[0]) * f) / 255,
    (a[1] + (b[1] - a[1]) * f) / 255,
    (a[2] + (b[2] - a[2]) * f) / 255,
    1.0);
}

export class ScoredPoints {
  constructor(viewer, points) {
    this.viewer = viewer;
    this.points = points;
    this.layer = "sun";

    this.collection = viewer.scene.primitives.add(
      new Cesium.PointPrimitiveCollection({ blendOption: Cesium.BlendOption.OPAQUE }));

    const { meta, data, stride } = points;
    const iLat = meta.fields.indexOf("lat");
    const iLon = meta.fields.indexOf("lon");
    const iElev = meta.fields.indexOf("elev");

    this.prims = new Array(meta.count);
    for (let k = 0; k < meta.count; k++) {
      const o = k * stride;
      this.prims[k] = this.collection.add({
        position: Cesium.Cartesian3.fromDegrees(
          data[o + iLon], data[o + iLat], data[o + iElev] + 60,
          Cesium.Ellipsoid.MOON),
        pixelSize: 4,
        color: Cesium.Color.WHITE,
      });
    }
    this.setLayer("sun");
  }

  setLayer(name) {
    const L = LAYERS[name];
    if (!L) return;
    this.layer = name;
    const { meta, data, stride } = this.points;
    const i = meta.fields.indexOf(L.field);
    const [lo, hi] = meta.ranges[L.field];
    const span = hi - lo || 1;

    for (let k = 0; k < meta.count; k++) {
      let t = (data[k * stride + i] - lo) / span;
      if (L.invert) t = 1 - t;
      this.prims[k].color = sample(L.ramp, t);
    }
  }

  set show(v) { this.collection.show = v; }
  get show() { return this.collection.show; }

  setPixelSize(px) {
    for (const p of this.prims) p.pixelSize = px;
  }

  /** Legend stops for the active layer: [{t, value, color}]. */
  legend() {
    const L = LAYERS[this.layer];
    const [lo, hi] = this.points.meta.ranges[L.field];
    return [0, 0.25, 0.5, 0.75, 1].map((t) => ({
      t,
      value: lo + (hi - lo) * (L.invert ? 1 - t : t),
      color: sample(L.ramp, t),
    }));
  }
}
