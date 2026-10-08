// Composite 0–100 score for short-strangle combos, mirroring the backend `_add_scores`:
// each metric is winsorized to its 5th–95th percentile, min-max scaled to [0,1], then weighted
// 20% ROI + 40% Theta% + 40% σ-distance. Extracted so BOTH the display (top-40 shown) and the
// full-scan selection (over every candidate) rank on the exact same formula.
function pct(sorted, p) {
  if (!sorted.length) return 0;
  if (sorted.length === 1) return sorted[0];
  const idx = p * (sorted.length - 1), lo = Math.floor(idx), hi = Math.min(lo + 1, sorted.length - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function norm(vals) {
  const s = vals.filter(v => v != null).sort((a, b) => a - b);
  const lo = pct(s, 0.05), hi = pct(s, 0.95), span = hi - lo;
  return (v) => (v == null || span <= 0) ? 0 : Math.max(0, Math.min(1, (v - lo) / span));
}

// rows: candidates (each needs theta_pct, dist_sigma). effRoi: parallel array of the ROI value to
// use for the ROI term (real-margin ROI where known, else the ELM estimate). Returns an array of
// scores aligned to `rows`.
export function compositeScores(rows, effRoi) {
  const nRoi = norm(effRoi);
  const nTheta = norm(rows.map(r => r.theta_pct));
  const nDist = norm(rows.map(r => r.dist_sigma));
  return rows.map((r, i) =>
    Math.round(1000 * (0.20 * nRoi(effRoi[i]) + 0.40 * nTheta(r.theta_pct) + 0.40 * nDist(r.dist_sigma))) / 10);
}
