// Analytics for the By-Strategy view: parse legs, auto-name the strategy, and compute per-leg
// + net greeks / moneyness from the underlying spot. Greeks use Black-Scholes with IV backed
// out of each option's LTP (same model as iv.js).
import { impliedVolPct } from "./iv";

const R = 0.065; // risk-free (~91d T-Bill)

const MONTHLY_RE = /^([A-Z&-]+?)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d+(?:\.\d+)?)(CE|PE)$/;
const WEEKLY_RE = /^([A-Z&-]+?)(\d{5})(\d+(?:\.\d+)?)(CE|PE)$/;
const FUT_RE = /^([A-Z&-]+?)\d{2}[A-Z]{3}FUT$/;

// { kind: 'option'|'future'|'other', type: 'CE'|'PE'|null, strike, root }
export function parseLeg(symbol) {
  const body = (symbol.includes(":") ? symbol.split(":")[1] : symbol).toUpperCase();
  let m = body.match(MONTHLY_RE);
  if (m) return { kind: "option", type: m[5], strike: +m[4], root: m[1] };
  m = body.match(WEEKLY_RE);
  if (m) return { kind: "option", type: m[4], strike: +m[3], root: m[1] };
  m = body.match(FUT_RE);
  if (m) return { kind: "future", type: null, strike: null, root: m[1] };
  return { kind: "other", type: null, strike: null, root: body };
}

// Best-effort strategy-type label from the legs' structure.
export function detectStrategyType(legs) {
  const p = legs.map((l) => ({ ...parseLeg(l.symbol), side: l.side, qty: l.qty }));
  const opts = p.filter((x) => x.kind === "option");
  const futs = p.filter((x) => x.kind === "future");
  const ce = opts.filter((x) => x.type === "CE");
  const pe = opts.filter((x) => x.type === "PE");
  const shorts = opts.filter((x) => x.side === "SELL");
  const longs = opts.filter((x) => x.side === "BUY");

  if (opts.length === 0 && futs.length > 0) return futs.length === 1 ? "Future" : "Futures";
  const withFut = (name) => (futs.length ? `${name} + Future` : name);

  if (opts.length === 2 && shorts.length === 2 && ce.length === 1 && pe.length === 1) {
    const sameStrike = ce[0].strike === pe[0].strike;
    return withFut(sameStrike ? "Short Straddle" : "Short Strangle");
  }
  if (opts.length === 2 && longs.length === 2 && ce.length === 1 && pe.length === 1) {
    return withFut(ce[0].strike === pe[0].strike ? "Long Straddle" : "Long Strangle");
  }
  // Vertical spreads: one short + one long on the same option type.
  if (opts.length === 2 && shorts.length === 1 && longs.length === 1) {
    if (ce.length === 2) return withFut("Call Spread");
    if (pe.length === 2) return withFut("Put Spread");
  }
  if (opts.length === 4 && shorts.length === 2 && longs.length === 2 && ce.length === 2 && pe.length === 2) {
    return withFut("Iron Condor");
  }
  if (opts.length === 1) return withFut((shorts.length ? "Short " : "Long ") + (ce.length ? "Call" : "Put"));
  if (opts.length > 0) return withFut(`${opts.length}-leg`);
  return "Custom";
}

function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp((-x * x) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}
function normPdf(x) { return 0.3989423 * Math.exp((-x * x) / 2); }

// Per-unit greeks (delta, gamma, vega per 1% vol, theta per day).
export function bsGreeks(isCall, S, K, T, sigma) {
  if (!(S > 0) || !(K > 0) || T <= 0 || sigma <= 0) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (R + (sigma * sigma) / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const delta = isCall ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = normPdf(d1) / (S * sigma * sqrtT);
  const vega = (S * normPdf(d1) * sqrtT) / 100;
  const theta =
    (-(S * normPdf(d1) * sigma) / (2 * sqrtT) -
      (isCall ? 1 : -1) * R * K * Math.exp(-R * T) * normCdf(isCall ? d2 : -d2)) / 365;
  return { delta, gamma, vega, theta };
}

export function yearsToExpiry(expiry) {
  if (!expiry) return null;
  const ms = new Date(expiry + "T15:30:00") - new Date();
  return Math.max(ms / (365 * 86400000), 1e-5);
}

const MONTHS3 = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };

// Best-effort expiry Date for an F&O leg symbol. Monthly (YY+MMM, e.g. "26SEP…") resolves to the
// last Thursday of that month (NSE monthly convention); weekly (YY+M+DD digits, e.g. "26915…" =
// 15-Sep-26) uses the encoded date directly. Returns null when it can't be determined (e.g. an
// Oct–Dec weekly's letter-month form), so callers can degrade to a non-annualized figure.
export function legExpiry(symbol) {
  const body = (symbol.includes(":") ? symbol.split(":")[1] : symbol).toUpperCase();
  let m = body.match(/^[A-Z&-]+?(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(?:\d|FUT)/);
  if (m) {
    const d = new Date(2000 + +m[1], MONTHS3[m[2]] + 1, 0, 15, 30, 0); // last day of the month
    while (d.getDay() !== 4) d.setDate(d.getDate() - 1);               // walk back to Thursday
    return d;
  }
  m = body.match(/^[A-Z&-]+?(\d{2})([1-9])(\d{2})\d/); // weekly YY M DD (digit month = Jan–Sep)
  if (m) return new Date(2000 + +m[1], +m[2] - 1, +m[3], 15, 30, 0);
  return null;
}

// Days from now until the NEAREST leg expiry (the binding one for a multi-expiry structure).
export function daysToNearestExpiry(legs) {
  const ds = legs.map(l => legExpiry(l.symbol)).filter(Boolean)
    .map(d => (d - new Date()) / 86400000).filter(v => v > 0);
  return ds.length ? Math.min(...ds) : null;
}

// Moneyness of an option leg vs spot: ITM/ATM/OTM + signed distance % (spot vs strike).
export function moneyness(parsed, spot) {
  if (parsed.kind !== "option" || !spot) return null;
  const distPct = ((spot - parsed.strike) / parsed.strike) * 100;
  const itm = parsed.type === "CE" ? spot > parsed.strike : spot < parsed.strike;
  const atm = Math.abs(distPct) < 0.75;
  return { state: atm ? "ATM" : itm ? "ITM" : "OTM", distPct };
}

// Per-leg greeks scaled by signed quantity (+qty BUY, −qty SELL). Futures = ±qty delta.
export function legGreeks(leg, spot, tte) {
  const parsed = parseLeg(leg.symbol);
  const sign = leg.side === "BUY" ? 1 : -1;
  if (parsed.kind === "future") {
    return { delta: sign * leg.qty, gamma: 0, vega: 0, theta: 0 };
  }
  if (parsed.kind !== "option" || !spot || !tte || !leg.ltp) return null;
  const isCall = parsed.type === "CE";
  const iv = impliedVolPct(isCall, spot, parsed.strike, leg.ltp, tte);
  if (iv == null) return null;
  const g = bsGreeks(isCall, spot, parsed.strike, tte, iv / 100);
  if (!g) return null;
  const q = sign * leg.qty;
  return { delta: g.delta * q, gamma: g.gamma * q, vega: g.vega * q, theta: g.theta * q };
}

// Net EXTRINSIC (time) value the OPEN position can still capture from decay, in rupees.
// Per option leg: extrinsic/share = LTP − intrinsic (floored at 0 for bid/ask noise), signed
// SELL:+ (you keep it as it decays) / BUY:− (you lose it), × qty. Futures have no time value.
// This is the ceiling on remaining theta profit — the part of premium theta actually eats.
export function strategyTimeValue(strategy) {
  const spot = strategy.spot;
  if (!spot) return null;
  let total = 0, any = false;
  for (const leg of strategy.legs) {
    if (!(leg.qty > 0)) continue;                 // closed/flat legs hold no exposure
    const parsed = parseLeg(leg.symbol);
    if (parsed.kind !== "option" || !leg.ltp) continue;
    const intrinsic = parsed.type === "CE"
      ? Math.max(spot - parsed.strike, 0)
      : Math.max(parsed.strike - spot, 0);
    const extrinsic = Math.max(leg.ltp - intrinsic, 0);
    const sign = leg.side === "BUY" ? -1 : 1;
    total += sign * extrinsic * leg.qty;
    any = true;
  }
  return any ? total : null;
}

// Net greeks across a strategy's legs (nulls if nothing computable).
export function strategyGreeks(strategy) {
  const tte = yearsToExpiry(strategy.expiry);
  let delta = 0, gamma = 0, vega = 0, theta = 0, any = false;
  for (const leg of strategy.legs) {
    const g = legGreeks(leg, strategy.spot, tte);
    if (!g) continue;
    any = true;
    delta += g.delta; gamma += g.gamma; vega += g.vega; theta += g.theta;
  }
  return any ? { delta, gamma, vega, theta } : null;
}
