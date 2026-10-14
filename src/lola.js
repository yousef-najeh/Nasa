/**
 * Browser-side sampling of the LOLA south-polar DEM.
 * Mirrors pipeline/lola.py exactly: spherical polar stereographic,
 * south aspect, true scale at the pole.
 */

export async function loadDem(base = "/data", onProgress) {
  const meta = await fetch(`${base}/dem_south.json`).then((r) => r.json());

  // The DEM runs to ~116 MB, so stream it and report progress rather than
  // leaving the viewer on a blank screen.
  const res = await fetch(`${base}/dem_south.bin`);
  if (!res.ok) throw new Error(`dem_south.bin: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) ||
    meta.width * meta.height * 2;

  const chunks = [];
  let received = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.(Math.min(received / total, 1));
  }

  const bytes = new Uint8Array(received);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }

  const dn = new Int16Array(bytes.buffer);
  if (dn.length !== meta.width * meta.height) {
    throw new Error(`DEM size mismatch: ${dn.length} vs ${meta.width * meta.height}`);
  }
  return new Dem(dn, meta);
}

export class Dem {
  constructor(dn, meta) {
    this.dn = dn;
    this.meta = meta;
    this.n = meta.width;
    this.scale = meta.mapScale;
    this.half = meta.halfWidth;
    this.k = meta.scalingFactor;
    this.R = meta.radius;
  }

  /** lat/lon in degrees -> projection-plane metres */
  latLonToXy(latDeg, lonDeg) {
    const lat = (latDeg * Math.PI) / 180;
    const lon = (lonDeg * Math.PI) / 180;
    const rho = 2 * this.R * Math.tan(Math.PI / 4 + lat / 2);
    return [rho * Math.sin(lon), rho * Math.cos(lon)];
  }

  /** Bilinear height in metres above the 1737.4 km sphere; NaN outside coverage. */
  heightAt(latDeg, lonDeg) {
    if (latDeg > this.meta.maxLat) return NaN;
    const [x, y] = this.latLonToXy(latDeg, lonDeg);
    const c = (x + this.half) / this.scale;
    const r = (this.half - y) / this.scale;
    if (c < 0 || r < 0 || c > this.n - 1 || r > this.n - 1) return NaN;

    const c0 = Math.floor(c), r0 = Math.floor(r);
    const c1 = Math.min(c0 + 1, this.n - 1), r1 = Math.min(r0 + 1, this.n - 1);
    const fc = c - c0, fr = r - r0;
    const d = this.dn, n = this.n;
    const h00 = d[r0 * n + c0], h10 = d[r0 * n + c1];
    const h01 = d[r1 * n + c0], h11 = d[r1 * n + c1];
    const top = h00 + (h10 - h00) * fc;
    const bot = h01 + (h11 - h01) * fc;
    return (top + (bot - top) * fr) * this.k;
  }
}

/**
 * Height for terrain meshing, faded to the reference sphere across the outer
 * edge of LOLA coverage. Without this the mesh drops off a cliff at 75S and
 * the limb renders as a comb of spikes. Kept separate from heightAt() so the
 * elevation readout stays truthful.
 */
Dem.prototype.heightForTerrain = function (latDeg, lonDeg, taperDeg = 1.5) {
  const z = this.heightAt(latDeg, lonDeg);
  if (Number.isNaN(z)) return 0;
  const t = (this.meta.maxLat - latDeg) / taperDeg;   // 1 well inside, 0 at edge
  if (t >= 1) return z;
  if (t <= 0) return 0;
  return z * t * t * (3 - 2 * t);                      // smoothstep
};
