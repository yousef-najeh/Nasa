/**
 * Weighted scoring over the six criteria.
 *
 * Hard constraints mask a site out entirely -- a site that cannot be landed on
 * is not a low-scoring site, it is not a site. Everything surviving is scored
 * by a weighted sum of normalised criteria, recomputed in the browser so the
 * ranking moves while the weights are being dragged.
 */

export const CRITERIA = [
  { key: "sun", label: "Solar power", field: "sunPct", dir: 1,
    unit: "%", hint: "share of the year with the Sun above the local horizon" },
  { key: "night", label: "Survivability", field: "nightH", dir: -1,
    unit: " h", hint: "longest continuous darkness — this sizes the battery" },
  { key: "comms", label: "Comms", field: "earthPct", dir: 1,
    unit: "%", hint: "share of the year with Earth above the local horizon" },
  { key: "safety", label: "Landing safety", field: "slopeMaxDeg", dir: -1,
    unit: "°", hint: "worst slope within 200 m, at a 20 m baseline" },
  { key: "smooth", label: "Smoothness", field: "roughnessM", dir: -1,
    unit: " m", hint: "RMS relief after removing the regional slope" },
  { key: "isru", label: "Ice access", field: "psrKm", dir: -1,
    unit: " km", hint: "distance to the nearest permanently shadowed ground" },
];

export const PRESETS = {
  crewed:  { sun: 0.9, night: 1.0, comms: 0.9, safety: 1.0, smooth: 0.7, isru: 0.3 },
  robotic: { sun: 0.8, night: 0.5, comms: 0.6, safety: 0.8, smooth: 0.5, isru: 1.0 },
  balanced:{ sun: 0.7, night: 0.6, comms: 0.6, safety: 0.8, smooth: 0.5, isru: 0.5 },
};

/** Per-criterion min/max across the candidate set, for normalisation. */
export function ranges(sites) {
  const r = {};
  for (const c of CRITERIA) {
    const vals = sites.map((s) => s[c.field]).filter((v) => v != null);
    r[c.key] = { min: Math.min(...vals), max: Math.max(...vals) };
  }
  return r;
}

function normalise(value, { min, max }, dir) {
  if (value == null) return 0;
  if (max === min) return 1;
  const t = (value - min) / (max - min);
  return dir > 0 ? t : 1 - t;
}

/**
 * Score and rank. Returns every site with `score` and `excluded`, so the UI
 * can show what failed the gate rather than silently dropping it.
 */
export function score(sites, weights, limits, rng = null) {
  const r = rng || ranges(sites);
  const total = CRITERIA.reduce((a, c) => a + (weights[c.key] || 0), 0) || 1;

  const scored = sites.map((s) => {
    const reasons = [];
    if (limits.maxSlope != null && s.slopeMaxDeg != null
        && s.slopeMaxDeg > limits.maxSlope) {
      reasons.push(`slope ${s.slopeMaxDeg.toFixed(1)}° > ${limits.maxSlope}°`);
    }
    if (limits.maxNight != null && s.nightH > limits.maxNight) {
      reasons.push(`night ${s.nightH.toFixed(0)} h > ${limits.maxNight} h`);
    }
    let sum = 0;
    for (const c of CRITERIA) {
      sum += (weights[c.key] || 0) * normalise(s[c.field], r[c.key], c.dir);
    }
    return { ...s, score: (sum / total) * 100, excluded: reasons.length > 0, reasons };
  });

  scored.sort((a, b) => (a.excluded - b.excluded) || (b.score - a.score));
  scored.forEach((s, i) => { s.rank = i + 1; });
  return scored;
}
