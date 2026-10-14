/**
 * Canvas renderers for the Sun and Earth discs.
 *
 * Earth is drawn from real imagery with the face that is actually turned
 * toward the Moon, and the real phase. Both come out of SPICE: the Earth-fixed
 * to MOON_ME rotation per epoch picks the face, and the Sun direction picks
 * the terminator.
 *
 * Earth phases run opposite to the Moon's as seen from Earth -- new moon here
 * is full Earth up there -- so drawing it permanently full would be wrong in a
 * way anyone who checks would notice.
 */

const EARTH_PX = 160;
const SUN_PX = 192;

let earthTex = null;

export async function loadEarthTexture(url = "/data/earth.jpg") {
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext("2d").drawImage(img, 0, 0);
  earthTex = c.getContext("2d").getImageData(0, 0, c.width, c.height);
  return earthTex;
}

/** v' = M v, with M row-major 3x3 (Earth-fixed -> MOON_ME). */
function mul(M, v) {
  return [
    M[0] * v[0] + M[1] * v[1] + M[2] * v[2],
    M[3] * v[0] + M[4] * v[1] + M[5] * v[2],
    M[6] * v[0] + M[7] * v[1] + M[8] * v[2],
  ];
}
/** v' = Mᵀ v (MOON_ME -> Earth-fixed). */
function mulT(M, v) {
  return [
    M[0] * v[0] + M[3] * v[1] + M[6] * v[2],
    M[1] * v[0] + M[4] * v[1] + M[7] * v[2],
    M[2] * v[0] + M[5] * v[1] + M[8] * v[2],
  ];
}
const norm = (v) => {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / m, v[1] / m, v[2] / m];
};
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Earth as seen from the Moon.
 *
 * @param toEarth  unit vector Moon->Earth in MOON_ME
 * @param toSun    unit vector Moon->Sun in MOON_ME
 * @param rot      Earth-fixed -> MOON_ME rotation, row-major 9
 */
export function drawEarth(canvas, toEarth, toSun, rot) {
  const n = EARTH_PX;
  canvas.width = n;
  canvas.height = n;
  const g = canvas.getContext("2d");
  const out = g.createImageData(n, n);
  if (!earthTex) return canvas;

  // viewing basis: look along -toEarth, with Earth's spin axis giving "up"
  const fwd = norm(toEarth);
  const poleFixed = [0, 0, 1];
  const pole = norm(mul(rot, poleFixed));
  let up = norm([
    pole[0] - fwd[0] * dot(pole, fwd),
    pole[1] - fwd[1] * dot(pole, fwd),
    pole[2] - fwd[2] * dot(pole, fwd),
  ]);
  if (!Number.isFinite(up[0])) up = [0, 0, 1];
  const right = norm(cross(up, fwd));

  const tex = earthTex;
  const sun = norm(toSun);

  for (let py = 0; py < n; py++) {
    const sy = (py - n / 2) / (n / 2 - 1);
    for (let px = 0; px < n; px++) {
      const sx = (px - n / 2) / (n / 2 - 1);
      const r2 = sx * sx + sy * sy;
      const o = (py * n + px) * 4;
      if (r2 > 1) { out.data[o + 3] = 0; continue; }

      // point on the near hemisphere, in MOON_ME
      const sz = Math.sqrt(1 - r2);
      const nrm = [
        right[0] * sx - up[0] * sy - fwd[0] * sz,
        right[1] * sx - up[1] * sy - fwd[1] * sz,
        right[2] * sx - up[2] * sy - fwd[2] * sz,
      ];

      // same point in Earth-fixed coords -> lat/lon -> texture
      const ef = mulT(rot, nrm);
      const lat = Math.asin(Math.max(-1, Math.min(1, ef[2])));
      const lon = Math.atan2(ef[1], ef[0]);
      const tx = Math.min(tex.width - 1,
        Math.max(0, Math.round(((lon / Math.PI + 1) / 2) * tex.width)));
      const ty = Math.min(tex.height - 1,
        Math.max(0, Math.round(((0.5 - lat / Math.PI)) * tex.height)));
      const t = (ty * tex.width + tx) * 4;

      // phase: the lit hemisphere faces the Sun. A soft terminator stands in
      // for the Sun's finite angular size and atmospheric scattering.
      const lam = dot(nrm, sun);
      const lit = Math.max(0, Math.min(1, (lam + 0.06) / 0.12));
      const shade = 0.06 + 0.94 * lit;
      // limb darkening, so the disc reads as a sphere rather than a sticker
      const limb = 0.72 + 0.28 * sz;

      out.data[o] = tex.data[t] * shade * limb;
      out.data[o + 1] = tex.data[t + 1] * shade * limb;
      out.data[o + 2] = tex.data[t + 2] * shade * limb;
      out.data[o + 3] = 255;
    }
  }
  g.putImageData(out, 0, 0);
  return canvas;
}

/** The Sun: a hot core with a falloff corona. */
export function drawSun(canvas) {
  const n = SUN_PX;
  canvas.width = n;
  canvas.height = n;
  const g = canvas.getContext("2d");
  const c = n / 2;

  const halo = g.createRadialGradient(c, c, n * 0.12, c, c, c);
  halo.addColorStop(0, "rgba(255,246,214,0.95)");
  halo.addColorStop(0.28, "rgba(255,206,110,0.42)");
  halo.addColorStop(0.62, "rgba(240,160,40,0.13)");
  halo.addColorStop(1, "rgba(240,150,30,0)");
  g.fillStyle = halo;
  g.fillRect(0, 0, n, n);

  const core = g.createRadialGradient(c, c, 0, c, c, n * 0.15);
  core.addColorStop(0, "#fffdf4");
  core.addColorStop(0.75, "#fff3cf");
  core.addColorStop(1, "#ffd477");
  g.fillStyle = core;
  g.beginPath();
  g.arc(c, c, n * 0.15, 0, Math.PI * 2);
  g.fill();
  return canvas;
}
