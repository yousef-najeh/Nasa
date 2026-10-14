/**
 * Browser-side sampling of the LOLA DEMs.
 * Mirrors pipeline/lola.py: spherical polar stereographic for the south polar
 * grid (south aspect, true scale at the pole), simple cylindrical for global.
 */

async function fetchWithProgress(url, expectedBytes, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || expectedBytes;

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
  return bytes.buffer;
}

/* ------------------------------------------------------------------ polar */

export async function loadDem(base = "/data", onProgress) {
  const meta = await fetch(`${base}/dem_south.json`).then((r) => r.json());
  const buf = await fetchWithProgress(`${base}/dem_south.bin`,
    meta.width * meta.height * 2, onProgress);
  const dn = new Int16Array(buf);
  if (dn.length !== meta.width * meta.height) {
    throw new Error(`polar DEM size mismatch: ${dn.length}`);
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
    const top = d[r0 * n + c0] + (d[r0 * n + c1] - d[r0 * n + c0]) * fc;
    const bot = d[r1 * n + c0] + (d[r1 * n + c1] - d[r1 * n + c0]) * fc;
    return (top + (bot - top) * fr) * this.k;
  }
}

/* ----------------------------------------------------------------- global */

export async function loadGlobalDem(base = "/data", onProgress) {
  const meta = await fetch(`${base}/dem_global.json`).then((r) => r.json());
  const buf = await fetchWithProgress(`${base}/dem_global.bin`,
    meta.width * meta.height * 2, onProgress);
  const dn = new Int16Array(buf);
  if (dn.length !== meta.width * meta.height) {
    throw new Error(`global DEM size mismatch: ${dn.length}`);
  }
  return new GlobalDem(dn, meta);
}

export class GlobalDem {
  constructor(dn, meta) {
    this.dn = dn;
    this.meta = meta;
    this.w = meta.width;
    this.h = meta.height;
    this.res = meta.resolution;          // pixels per degree
    this.k = meta.scalingFactor;
  }

  /** Bilinear height in metres above the 1737.4 km sphere. Wraps in longitude. */
  heightAt(latDeg, lonDeg) {
    const line = this.meta.lineOffset - latDeg * this.res;
    let samp = this.meta.sampleOffset + (lonDeg - 180) * this.res;
    samp = ((samp % this.w) + this.w) % this.w;

    const r = Math.min(Math.max(line, 0), this.h - 1);
    const r0 = Math.floor(r), r1 = Math.min(r0 + 1, this.h - 1);
    const c0 = Math.floor(samp), c1 = (c0 + 1) % this.w;
    const fr = r - r0, fc = samp - c0;

    const d = this.dn, w = this.w;
    const top = d[r0 * w + c0] + (d[r0 * w + c1] - d[r0 * w + c0]) * fc;
    const bot = d[r1 * w + c0] + (d[r1 * w + c1] - d[r1 * w + c0]) * fc;
    return (top + (bot - top) * fr) * this.k;
  }
}

/* ---------------------------------------------------------------- combined */

/**
 * Both grids behind one sampler. The polar DEM is ~16x finer, so it wins
 * wherever it has coverage; the two are cross-faded over a latitude band so
 * the mesh has no step at the seam.
 */
export class Terrain {
  constructor(global, polar, fadeOuter = -75.5, fadeInner = -77.0) {
    this.global = global;
    this.polar = polar;
    this.fadeOuter = fadeOuter;
    this.fadeInner = fadeInner;
  }

  /** Truthful elevation for the readout — polar grid where it exists. */
  heightAt(latDeg, lonDeg) {
    const p = this.polar.heightAt(latDeg, lonDeg);
    return Number.isNaN(p) ? this.global.heightAt(latDeg, lonDeg) : p;
  }

  /** Height for meshing, cross-faded across the polar coverage edge. */
  heightForTerrain(latDeg, lonDeg) {
    const g = this.global.heightAt(latDeg, lonDeg);
    if (latDeg > this.fadeOuter) return g;
    const p = this.polar.heightAt(latDeg, lonDeg);
    if (Number.isNaN(p)) return g;
    if (latDeg < this.fadeInner) return p;
    const t = (this.fadeOuter - latDeg) / (this.fadeOuter - this.fadeInner);
    const w = t * t * (3 - 2 * t);
    return g + (p - g) * w;
  }
}
