// Pettitt's test: non-parametric change-point detection. Given an ordered sequence,
// finds the single split point where the data most abruptly shifts from one level to
// another (rank-based, no normality assumption) — see Pettitt (1979).
//
// Applied here to OI-by-strike (ordered by strike price, not time): a change point marks
// the edge of an OI concentration "wall" — e.g. CE OI stepping up sharply at a strike is a
// resistance wall edge, PE OI stepping up is a support wall edge.
//
// A real option chain's OI-by-strike is a "bump" (rises into the wall, falls back out of
// it), not a single permanent level shift — a single global Pettitt test on the whole
// series can't see that (the before/after means average out). Instead we split the series
// at its peak OI strike into two roughly-monotonic ramps and run Pettitt's test on each,
// which is the shape the test is actually built to detect.
//
// Note: with only ~10-20 strikes per ramp, the classical p-value rarely clears strict
// significance (small-sample power is low) even when the estimated change point is
// visibly correct — so pValue is surfaced as a confidence indicator, not used to hide
// the estimate.

function sign(x) {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

// Returns { changeIndex, K, pValue } for the most significant single change point in x,
// or null if too short. changeIndex t means the break falls between x[t] and x[t+1].
export function pettittTest(x) {
  const n = x.length;
  if (n < 4) return null;
  let bestK = -1, bestT = -1;
  for (let t = 0; t < n - 1; t++) {
    let u = 0;
    for (let i = 0; i <= t; i++) {
      for (let j = t + 1; j < n; j++) {
        u += sign(x[i] - x[j]);
      }
    }
    if (Math.abs(u) > bestK) { bestK = Math.abs(u); bestT = t; }
  }
  const pValue = 2 * Math.exp((-6 * bestK * bestK) / (n ** 3 + n ** 2));
  return { changeIndex: bestT, K: bestK, pValue };
}

// Finds the dominant OI wall in a strike-ordered OI series: the peak strike, and the two
// change points (rising edge before the peak, falling edge after) that bound it.
export function findDominantWall(oiValues) {
  const n = oiValues.length;
  if (n === 0) return null;
  let peakIdx = 0;
  for (let i = 1; i < n; i++) if (oiValues[i] > oiValues[peakIdx]) peakIdx = i;

  let startIdx = 0, leftPValue = null;
  const leftRamp = oiValues.slice(0, peakIdx + 1);
  if (leftRamp.length >= 4) {
    const test = pettittTest(leftRamp);
    if (test) { startIdx = test.changeIndex + 1; leftPValue = test.pValue; }
  }

  let endIdx = n - 1, rightPValue = null;
  const rightRamp = oiValues.slice(peakIdx);
  if (rightRamp.length >= 4) {
    const test = pettittTest(rightRamp);
    if (test) { endIdx = peakIdx + test.changeIndex; rightPValue = test.pValue; }
  }

  return { startIdx, endIdx, peakIdx, leftPValue, rightPValue };
}

// Rough, informal confidence label from a Pettitt p-value — not a rigorous significance
// claim (small-N power is weak here), just a way to convey relative strength in the UI.
export function confidenceLabel(pValue) {
  if (pValue == null) return null;
  if (pValue < 0.1) return "strong";
  if (pValue < 0.3) return "moderate";
  return "weak";
}
