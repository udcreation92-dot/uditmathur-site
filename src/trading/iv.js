// Implied volatility via Black-Scholes inversion — Fyers' option-chain payload carries no IV
// field, so it's computed client-side from LTP, spot, strike and time to expiry.

const RISK_FREE_RATE = 0.065; // ~91-day T-Bill yield; IV is not very sensitive to small errors here

function normCdf(x) {
  // Abramowitz & Stegun 7.1.26 erf approximation — plenty accurate for IV display purposes
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return 0.5 * (1 + Math.sign(x) * erf);
}

function bsPrice(isCall, S, K, T, sigma, r = RISK_FREE_RATE) {
  if (T <= 0 || sigma <= 0) return Math.max(0, isCall ? S - K : K - S);
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  if (isCall) return S * normCdf(d1) - K * Math.exp(-r * T) * normCdf(d2);
  return K * Math.exp(-r * T) * normCdf(-d2) - S * normCdf(-d1);
}

/**
 * Implied volatility (as a percentage, e.g. 14.2) from an option's market price, or null when
 * no vol reproduces the price (price below intrinsic, stale/zero quotes, expired).
 */
export function impliedVolPct(isCall, spot, strike, price, yearsToExpiry) {
  if (!spot || !strike || !price || price <= 0 || yearsToExpiry <= 0) return null;
  const intrinsic = Math.max(0, isCall ? spot - strike : strike - spot);
  if (price <= intrinsic) return null;

  let lo = 0.001, hi = 5.0;
  if (bsPrice(isCall, spot, strike, yearsToExpiry, hi) < price) return null;
  // Bisection with an early exit once the bracket is tighter than the precision we ever display
  // (~0.01% vol). Converges in ~16 iterations instead of a fixed 60 — a big cut since this runs for
  // every leg of every strategy on each poll; the displayed/rounded IV is identical.
  for (let i = 0; i < 40 && (hi - lo) > 1e-4; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice(isCall, spot, strike, yearsToExpiry, mid) < price) lo = mid;
    else hi = mid;
  }
  return ((lo + hi) / 2) * 100;
}
