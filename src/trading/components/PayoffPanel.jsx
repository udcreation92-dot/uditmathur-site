import { useState, useEffect, useMemo } from "react";
import { api } from "../api";

// Parses strike + option type out of a Fyers option symbol. Two formats exist:
// weekly  "NSE:NIFTY2670724800CE"  -> root NIFTY, YYMDD "26707", strike 24800
// monthly "NSE:NIFTY26JUL24800CE"  -> root NIFTY, YYMMM "26JUL", strike 24800
const MONTHLY_RE = /^([A-Z-&]+)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d+(?:\.\d+)?)(CE|PE)$/;
const WEEKLY_RE = /^([A-Z-&]+)(\d{5})(\d+(?:\.\d+)?)(CE|PE)$/;

export function parseOptionSymbol(symbol) {
  const body = (symbol.includes(":") ? symbol.split(":")[1] : symbol).toUpperCase();
  let m = body.match(MONTHLY_RE);
  if (m) return { root: m[1], strike: +m[4], type: m[5] };
  m = body.match(WEEKLY_RE);
  if (m) return { root: m[1], strike: +m[3], type: m[4] };
  return null;
}

function isFutureSymbol(symbol) {
  const body = (symbol.includes(":") ? symbol.split(":")[1] : symbol).toUpperCase();
  return /FUT$/.test(body);
}

function payoffAt(spot, legs) {
  let total = 0;
  for (const l of legs) {
    const sign = l.side === "BUY" ? 1 : -1;
    if (l.type === "FUT") {
      // A future is linear: P&L per unit = spot − entry (long), inverted for a short. `premium`
      // holds the entry price. This is the leg that a collar/hedge uses to cap an option tail.
      total += sign * (spot - l.premium) * l.qty;
    } else {
      const intrinsic = l.type === "CE" ? Math.max(spot - l.strike, 0) : Math.max(l.strike - spot, 0);
      total += sign * (intrinsic - l.premium) * l.qty;
    }
  }
  return total;
}

function fmtMoney(v) {
  const abs = Math.abs(v);
  const s = abs >= 100000 ? `${(abs / 100000).toFixed(2)}L` : abs.toLocaleString(undefined, { maximumFractionDigits: 0 });
  return `${v < 0 ? "-" : ""}₹${s}`;
}

// Expiry payoff panel for the strategy being built — Sensibull-style: max profit / max loss /
// breakevens up top, green-above-zero red-below-zero payoff curve underneath. Premiums come
// from each leg's limit price when set, else the live LTP.
export default function PayoffPanel({ legs: rawLegs, realized = 0, onAnalysis }) {
  const [quotes, setQuotes] = useState({}); // symbol -> ltp
  const [loadingQuotes, setLoadingQuotes] = useState(false);

  // Option AND future legs both shape the payoff — a future is a linear leg (type "FUT") that can
  // cap or steepen an option tail (e.g. a short future collared by a long call). Parsing both means
  // a futures+options combo draws its true expiry curve instead of an option-only approximation.
  const instrLegs = useMemo(() => rawLegs
    .map(l => {
      if (!(l.quantity > 0)) return null;
      if (isFutureSymbol(l.symbol || "")) {
        return { type: "FUT", side: l.side, qty: l.quantity, symbol: l.symbol, limit_price: l.limit_price };
      }
      const parsed = parseOptionSymbol(l.symbol || "");
      if (!parsed) return null;
      return { ...parsed, side: l.side, qty: l.quantity, symbol: l.symbol, limit_price: l.limit_price };
    })
    .filter(Boolean), [rawLegs]);

  // Fetch LTPs for market-priced legs (limit-priced legs use their own price).
  useEffect(() => {
    const need = instrLegs.filter(l => !(l.limit_price > 0) && quotes[l.symbol] === undefined).map(l => l.symbol);
    if (need.length === 0) return;
    let cancelled = false;
    (async () => {
      setLoadingQuotes(true);
      const fetched = {};
      await Promise.all(need.map(async sym => {
        try {
          const resp = await api.getQuote(sym);
          fetched[sym] = resp?.d?.[0]?.v?.lp ?? null;
        } catch {
          fetched[sym] = null;
        }
      }));
      if (!cancelled) {
        setQuotes(prev => ({ ...prev, ...fetched }));
        setLoadingQuotes(false);
      }
    })();
    return () => { cancelled = true; };
  }, [instrLegs, quotes]);

  const legs = instrLegs
    .map(l => ({ ...l, premium: l.limit_price > 0 ? l.limit_price : quotes[l.symbol] }))
    .filter(l => l.premium != null && l.premium > 0);

  const analysis = useMemo(() => {
    if (legs.length === 0) return null;
    const signed = l => (l.side === "BUY" ? l.qty : -l.qty);
    // Reference prices for the plot window: option strikes and future entry prices (a pure-future
    // leg has no strike, so its entry anchors the range).
    const refPrices = legs.map(l => l.type === "FUT" ? l.premium : l.strike).filter(v => v > 0);
    const netCallQty = legs.reduce((a, l) => a + (l.type === "CE" ? signed(l) : 0), 0);
    const netPutQty = legs.reduce((a, l) => a + (l.type === "PE" ? signed(l) : 0), 0);
    const netFutQty = legs.reduce((a, l) => a + (l.type === "FUT" ? signed(l) : 0), 0);
    // Tail slopes (dP&L/dSpot) INCLUDING the linear future leg. A future adds a constant slope
    // across the whole range, so it can flatten an option tail (collar → bounded) or steepen it.
    // Right tail (high spot): ITM calls move 1:1, puts are flat. Left tail (low spot): ITM puts
    // move −1:1, calls flat. If a tail's net slope is 0 that side is bounded.
    const rightSlope = netCallQty + netFutQty;   // dP/dS as spot → ∞
    const leftSlope = -netPutQty + netFutQty;     // dP/dS as spot → 0
    let lo = Math.min(...refPrices) * 0.93;
    let hi = Math.max(...refPrices) * 1.07;
    // A realized offset shifts breakevens outward along an unbounded tail by (offset / tail slope);
    // widen the window so those shifted breakevens stay on-chart. Skip a flat (bounded) tail.
    if (realized) {
      if (rightSlope) hi += Math.abs(realized) / Math.abs(rightSlope);
      if (leftSlope) lo -= Math.abs(realized) / Math.abs(leftSlope);
    }
    const N = 240;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const s = lo + (hi - lo) * (i / N);
      // Realized P&L from already-closed legs is banked regardless of spot, so it shifts the whole
      // curve by a constant — moving max profit/loss and the breakevens (the money-pot view).
      pts.push([s, payoffAt(s, legs) + realized]);
    }
    const ys = pts.map(p => p[1]);
    let maxProfit = Math.max(...ys), maxLoss = Math.min(...ys);
    // A tail runs to +∞ profit if its slope points that way, −∞ loss if the other. Right tail rises
    // with spot (slope > 0 → profit), left tail rises as spot falls (slope < 0 → profit). With the
    // future folded in, a collar whose long option cancels the future's slope reads as bounded.
    const profitUnbounded = rightSlope > 0 || leftSlope < 0;
    const lossUnbounded = rightSlope < 0 || leftSlope > 0;
    // Breakevens: sign changes between grid points, linearly interpolated.
    const breakevens = [];
    for (let i = 1; i < pts.length; i++) {
      const [s0, y0] = pts[i - 1], [s1, y1] = pts[i];
      if ((y0 <= 0 && y1 > 0) || (y0 >= 0 && y1 < 0)) {
        breakevens.push(s0 + (s1 - s0) * (Math.abs(y0) / (Math.abs(y0) + Math.abs(y1) || 1)));
      }
    }
    return { pts, lo, hi, maxProfit, maxLoss, profitUnbounded, lossUnbounded, breakevens, netCallQty, netPutQty };
  }, [JSON.stringify(legs), realized]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (onAnalysis) onAnalysis(analysis); }, [analysis]); // eslint-disable-line react-hooks/exhaustive-deps

  if (instrLegs.length === 0) return null;

  if (!analysis) {
    return (
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4 text-xs text-gray-500">
        {loadingQuotes ? "Fetching option prices for payoff…" : "Payoff needs a premium per leg — set a limit price or wait for live quotes."}
      </div>
    );
  }

  const { pts, maxProfit, maxLoss, profitUnbounded, lossUnbounded, breakevens } = analysis;

  // SVG geometry
  const W = 640, H = 220, PAD_X = 46, PAD_Y = 18;
  const yMax = Math.max(maxProfit, 0), yMin = Math.min(maxLoss, 0);
  const ySpan = (yMax - yMin) || 1;
  const X = s => PAD_X + ((s - analysis.lo) / (analysis.hi - analysis.lo)) * (W - 2 * PAD_X);
  const Y = v => PAD_Y + ((yMax - v) / ySpan) * (H - 2 * PAD_Y);
  const zeroY = Y(0);
  const linePath = pts.map(([s, v], i) => `${i ? "L" : "M"}${X(s).toFixed(1)},${Y(v).toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L${X(analysis.hi).toFixed(1)},${zeroY.toFixed(1)} L${X(analysis.lo).toFixed(1)},${zeroY.toFixed(1)} Z`;
  const xTicks = [0, 0.25, 0.5, 0.75, 1].map(f => analysis.lo + (analysis.hi - analysis.lo) * f);

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
      <div className="flex flex-wrap gap-x-8 gap-y-2 mb-3 text-sm">
        <div>
          <p className="text-[10px] text-gray-500">Max Profit</p>
          <p className="font-semibold text-green-400">{profitUnbounded ? "Unlimited" : fmtMoney(maxProfit)}</p>
        </div>
        <div>
          <p className="text-[10px] text-gray-500">Max Loss</p>
          <p className="font-semibold text-red-400">{lossUnbounded ? "Unlimited" : fmtMoney(maxLoss)}</p>
        </div>
        <div>
          <p className="text-[10px] text-gray-500">Breakeven{breakevens.length !== 1 ? "s" : ""}</p>
          <p className="font-semibold text-gray-200">
            {breakevens.length > 0 ? breakevens.map(b => b.toLocaleString(undefined, { maximumFractionDigits: 0 })).join(" · ") : "—"}
          </p>
        </div>
        {!profitUnbounded && !lossUnbounded && maxLoss < 0 && (
          <div>
            <p className="text-[10px] text-gray-500">Reward / Risk</p>
            <p className="font-semibold text-gray-200">{(maxProfit / Math.abs(maxLoss)).toFixed(2)}</p>
          </div>
        )}
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <defs>
          <clipPath id="payoff-above"><rect x="0" y="0" width={W} height={zeroY} /></clipPath>
          <clipPath id="payoff-below"><rect x="0" y={zeroY} width={W} height={H - zeroY} /></clipPath>
        </defs>
        {/* profit region green, loss region red; payoff line amber — terminal palette */}
        <path d={areaPath} fill="rgb(63 178 107 / 0.16)" clipPath="url(#payoff-above)" />
        <path d={areaPath} fill="rgb(224 108 117 / 0.15)" clipPath="url(#payoff-below)" />
        <line x1={PAD_X} y1={zeroY} x2={W - PAD_X} y2={zeroY} stroke="#3a3a3a" strokeWidth="1" />
        <path d={linePath} fill="none" stroke="#e0a83b" strokeWidth="2" />
        {breakevens.map((b, i) => (
          <g key={i}>
            <line x1={X(b)} y1={PAD_Y} x2={X(b)} y2={H - PAD_Y} stroke="#8a8a8a" strokeWidth="1" strokeDasharray="3 3" />
            <text x={X(b)} y={PAD_Y - 4} textAnchor="middle" fill="#8a8a8a" fontSize="9">
              BE {b.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </text>
          </g>
        ))}
        {xTicks.map((t, i) => (
          <text key={i} x={X(t)} y={H - 3} textAnchor="middle" fill="#7a7a7a" fontSize="9">
            {t.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </text>
        ))}
        <text x={PAD_X - 4} y={Y(yMax) + 8} textAnchor="end" fill="#7a7a7a" fontSize="9">{fmtMoney(yMax)}</text>
        <text x={PAD_X - 4} y={zeroY + 3} textAnchor="end" fill="#7a7a7a" fontSize="9">0</text>
        <text x={PAD_X - 4} y={Y(yMin)} textAnchor="end" fill="#7a7a7a" fontSize="9">{fmtMoney(yMin)}</text>
      </svg>
      <p className="text-[10px] text-gray-600 mt-1">
        Payoff at expiry · premiums from {legs.some(l => !(l.limit_price > 0)) ? "live LTP / limit prices" : "limit prices"}
      </p>
    </div>
  );
}
