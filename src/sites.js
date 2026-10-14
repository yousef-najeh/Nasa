import * as Cesium from "cesium";

/**
 * Candidate landing sites: markers on the globe, and the horizon panorama
 * that explains why each one scores the way it does.
 */

// Categorical slots 4 and 1 from the validated palette, assigned
// semantically. Validated for the dark surface: CVD dE 27.4, normal 30.7,
// both inside the dark lightness band and above 3:1 contrast.
export const SUN_COLOR = "#c98500";
export const EARTH_COLOR = "#3987e5";
const TERRAIN_FILL = "#272b31";
const TERRAIN_EDGE = "#6b737f";

export async function loadSites(base = "/data") {
  const res = await fetch(`${base}/sites.json`);
  if (!res.ok) throw new Error(`sites.json: HTTP ${res.status}`);
  return res.json();
}

export function addSiteMarkers(viewer, sites, onSelect) {
  const entities = sites.map((s) => viewer.entities.add({
    id: `site-${s.rank}`,
    position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, s.elev + 400,
      Cesium.Ellipsoid.MOON),
    point: {
      pixelSize: s.rank <= 3 ? 11 : 8,
      color: Cesium.Color.fromCssColorString("#e8eaed"),
      outlineColor: Cesium.Color.fromCssColorString("#0b0c0e"),
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text: String(s.rank),
      font: "600 11px ui-monospace, Menlo, Consolas, monospace",
      fillColor: Cesium.Color.fromCssColorString("#e8eaed"),
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString("#0b0c0eD0"),
      backgroundPadding: new Cesium.Cartesian2(5, 3),
      pixelOffset: new Cesium.Cartesian2(0, -17),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      scaleByDistance: new Cesium.NearFarScalar(2e5, 1.0, 3e6, 0.0),
    },
    siteData: s,
  }));

  const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  handler.setInputAction((click) => {
    const picked = viewer.scene.pick(click.position);
    const site = picked?.id?.siteData;
    if (site) onSelect(site);
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  return entities;
}

/**
 * Horizon panorama: azimuth across, elevation up, terrain drawn as a filled
 * silhouette with the Sun and Earth tracks over it.
 *
 * A polar plot would waste its whole area here -- at the south pole the Sun
 * never clears ~1.5 deg and Earth bobs within a few degrees of the horizon, so
 * the only question that matters is whether a track clears the skyline. This
 * form answers it by direct comparison of two heights.
 */
export function drawHorizon(canvas, site, sky) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 170;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const g = canvas.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  const pad = { l: 26, r: 8, t: 10, b: 18 };
  const W = cssW - pad.l - pad.r;
  const H = cssH - pad.t - pad.b;

  const hor = site.horizon;
  const elMax = Math.max(4, Math.ceil(Math.max(...hor, ...sky.sunEl) + 1));
  const elMin = Math.min(-8, Math.floor(Math.min(...sky.earthEl) - 1));

  const X = (az) => pad.l + (az / 360) * W;
  const Y = (el) => pad.t + H * (1 - (el - elMin) / (elMax - elMin));

  // --- recessive grid + axes
  g.strokeStyle = "#23262d";
  g.fillStyle = "#767c88";
  g.lineWidth = 1;
  g.font = "10px ui-monospace, Menlo, Consolas, monospace";
  g.textAlign = "right";
  g.textBaseline = "middle";
  for (let el = Math.ceil(elMin / 5) * 5; el <= elMax; el += 5) {
    const y = Math.round(Y(el)) + 0.5;
    g.beginPath(); g.moveTo(pad.l, y); g.lineTo(pad.l + W, y); g.stroke();
    g.fillText(`${el}°`, pad.l - 5, y);
  }
  g.textAlign = "center";
  g.textBaseline = "top";
  for (const [az, lbl] of [[0, "N"], [90, "E"], [180, "S"], [270, "W"], [360, "N"]]) {
    const x = Math.round(X(az)) + 0.5;
    g.strokeStyle = "#1c1f25";
    g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, pad.t + H); g.stroke();
    g.fillText(lbl, x, pad.t + H + 4);
  }

  // --- zero-elevation reference: the flat-ground horizon
  const y0 = Math.round(Y(0)) + 0.5;
  g.strokeStyle = "#3a4049";
  g.setLineDash([3, 3]);
  g.beginPath(); g.moveTo(pad.l, y0); g.lineTo(pad.l + W, y0); g.stroke();
  g.setLineDash([]);

  // --- terrain silhouette: context, not a series, so it stays neutral
  g.beginPath();
  g.moveTo(X(0), pad.t + H);
  for (let i = 0; i < hor.length; i++) {
    g.lineTo(X((i / hor.length) * 360), Y(Math.max(hor[i], elMin)));
  }
  g.lineTo(X(360), Y(Math.max(hor[0], elMin)));
  g.lineTo(X(360), pad.t + H);
  g.closePath();
  g.fillStyle = TERRAIN_FILL;
  g.fill();
  g.strokeStyle = TERRAIN_EDGE;
  g.lineWidth = 1.5;
  g.beginPath();
  for (let i = 0; i < hor.length; i++) {
    const x = X((i / hor.length) * 360), y = Y(Math.max(hor[i], elMin));
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();

  // --- tracks. Points below the skyline are dimmed rather than hidden:
  // where a body is blocked is as informative as where it is not.
  // Thousands of samples overlap, so marks are small and translucent: density
  // then reads as the band the body actually sweeps, instead of a solid blob.
  const track = (az, el, color, radius) => {
    g.fillStyle = color;
    for (let i = 0; i < az.length; i++) {
      const h = hor[Math.round((az[i] / 360) * hor.length) % hor.length];
      g.globalAlpha = el[i] > h ? 0.40 : 0.10;
      g.beginPath();
      g.arc(X(az[i]), Y(el[i]), radius, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  };
  track(sky.earthAz, sky.earthEl, EARTH_COLOR, 1.3);
  track(sky.sunAz, sky.sunEl, SUN_COLOR, 1.3);
}
