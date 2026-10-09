// Expiry-payoff breakevens for an option strategy's legs, reused by the chart's breakeven overlays.
// Mirrors the payoff math in PayoffPanel but standalone (takes raw strategy legs → breakeven prices).

// Parse strike + option type from a Fyers option symbol. Two encodings:
//   weekly  "NSE:NIFTY26O1322100PE" -> YY + M + DD date code (M is 1-9 Jan-Sep, O/N/D Oct-Dec)
//   monthly "NSE:NIFTY26OCT22100CE" -> YY + MMM
const MONTHLY_RE = /^([A-Z&-]+)(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d+(?:\.\d+)?)(CE|PE)$/;
const WEEKLY_RE = /^([A-Z&-]+)(\d{2}[1-9OND]\d{2})(\d+(?:\.\d+)?)(CE|PE)$/;

export function parseOptionLeg(symbol) {
  const body = (symbol.includes(":") ? symbol.split(":")[1] : symbol).toUpperCase();
  let m = body.match(MONTHLY_RE);
  if (m) return { strike: parseFloat(m[4]), type: m[5] };
  m = body.match(WEEKLY_RE);
  if (m) return { strike: parseFloat(m[3]), type: m[4] };
  return null; // not an option (future/equity) — contributes no curvature to breakevens
}

// Net expiry payoff (in ₹) at underlying price S for a set of legs.
function payoffAt(parsed, S) {
  let total = 0;
  for (const l of parsed) {
    const intrinsic = l.type === "CE" ? Math.max(S - l.strike, 0) : Math.max(l.strike - S, 0);
    const perUnit = l.side === "BUY" ? intrinsic - l.premium : l.premium - intrinsic;
    total += perUnit * l.qty;
  }
  return total;
}

// Breakeven underlying prices (where net payoff crosses zero) for a strategy's legs.
// `legs`: [{ symbol, side, qty|open_qty, entry }]. `spot`: reference price to center the scan.
export function strategyBreakevens(legs, spot) {
  const parsed = [];
  for (const l of legs || []) {
    const p = parseOptionLeg(l.symbol);
    if (!p) continue; // skip non-option legs
    const qty = Math.abs(l.open_qty ?? l.qty ?? 0);
    const premium = l.entry ?? l.avg_sell ?? l.avg_buy ?? 0;
    if (!qty || !premium) continue;
    parsed.push({ strike: p.strike, type: p.type, side: (l.side || "").toUpperCase(), premium, qty });
  }
  if (parsed.length === 0) return [];

  const strikes = parsed.map(p => p.strike);
  const center = spot || (strikes.reduce((a, b) => a + b, 0) / strikes.length);
  const lo = Math.max(1, Math.min(center * 0.5, ...strikes) * 0.9);
  const hi = Math.max(center * 1.5, ...strikes) * 1.1;
  const steps = 2000;
  const dx = (hi - lo) / steps;

  const bes = [];
  let prevS = lo, prevY = payoffAt(parsed, lo);
  for (let i = 1; i <= steps; i++) {
    const S = lo + i * dx;
    const y = payoffAt(parsed, S);
    if ((prevY <= 0 && y > 0) || (prevY >= 0 && y < 0)) {
      // linear interpolation of the zero crossing
      const be = prevS + (S - prevS) * (Math.abs(prevY) / (Math.abs(prevY) + Math.abs(y) || 1));
      bes.push(Math.round(be * 100) / 100);
    }
    prevS = S; prevY = y;
  }
  return bes;
}
