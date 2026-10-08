const INDEX_PF_CODE = { NIFTY50: "NIFTY", NIFTYBANK: "BANKNIFTY", FINNIFTY: "FINNIFTY", MIDCPNIFTY: "MIDCPNIFTY", NIFTYNXT50: "NIFTYNXT50" };

export function pfCodeFor(sym) {
  const ticker = sym.replace(/^NSE:/, "").replace(/-INDEX$|-EQ$/, "");
  return INDEX_PF_CODE[ticker] || ticker;
}

export function toYYYYMMDD(ddmmyyyy) {
  const [dd, mm, yyyy] = ddmmyyyy.split("-");
  return `${yyyy}${mm}${dd}`;
}

// NSE Extreme Loss Margin: 2% of notional for index derivatives, 3.5% for stock derivatives.
// Source: nseclearing.in risk-management/equity-derivatives/margins.
//
// Additional index-expiry ELM: on the EXPIRY DAY of an index option, the exchange levies an
// extra 2% ELM on short (sold) index option contracts — applies even if the position is hedged
// or intraday. Effective 2024-11-20. So a short index option expiring today carries 4% ELM
// instead of 2%. Since this app only ever applies ELM to short legs (both strangle legs; the
// sell leg of a spread), the "short" condition is always met where elmRateFor is used here.
// Source: support.zerodha.com/.../additional-elm-for-index-expiry
export const EXPIRY_DAY_ADDITIONAL_ELM = 0.02;

export function isIndexSymbol(sym) {
  return sym.endsWith("-INDEX");
}

// Both scanners compute days_to_expiry as (expiry_date - today).days + 1, so expiry day == 1.
export function isExpiryDay(daysToExpiry) {
  return daysToExpiry === 1;
}

export function elmRateFor(sym, expiryDay = false) {
  const base = isIndexSymbol(sym) ? 0.02 : 0.035;
  const extra = isIndexSymbol(sym) && expiryDay ? EXPIRY_DAY_ADDITIONAL_ELM : 0;
  return base + extra;
}

export function parseCsv(text) {
  return text.trim().split(/\r?\n/).map(line => {
    const cells = [];
    let cur = "", inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === "," && !inQuotes) { cells.push(cur); cur = ""; }
      else cur += c;
    }
    cells.push(cur);
    return cells;
  });
}

// Parses a PC-SPAN Results.csv into { [firmIndex0Based]: totalReqInit }. When `expectedRunId`
// is given, only rows whose Portfolio column ("{firm} - {acctId} - ...") carries that exact
// acctId are accepted — this rejects a Results.csv left over from a different/older .pos
// export instead of silently mismatching firm numbers to the wrong combos.
export function parseSpanMargins(csvText, expectedRunId) {
  const rows = parseCsv(csvText);
  const header = rows[0];
  const portfolioIdx = header.findIndex(h => h.trim().toLowerCase() === "portfolio");
  const marginIdx = header.findIndex(h => h.trim().toLowerCase() === "total req/init");
  if (portfolioIdx === -1 || marginIdx === -1) {
    throw new Error('CSV must have "Portfolio" and "Total Req/Init" columns');
  }
  const margins = {};
  let matchedAny = false;
  for (const row of rows.slice(1)) {
    if (row.length < 2) continue;
    const parts = row[portfolioIdx].split("-").map(p => p.trim());
    const firm = parseInt(parts[0], 10);
    const acctId = parts[1];
    if (expectedRunId) {
      if (acctId !== expectedRunId) continue;
      matchedAny = true;
    }
    const margin = parseFloat(row[marginIdx]);
    if (!Number.isNaN(firm) && !Number.isNaN(margin)) margins[firm - 1] = margin;
  }
  if (expectedRunId && !matchedAny) {
    throw new Error(
      `Results.csv doesn't contain run ${expectedRunId} — it looks like PC-SPAN hasn't processed this export yet, ` +
      `or Results.csv is left over from a different run. Re-export, run it through PC-SPAN, then load again.`
    );
  }
  return margins;
}

// Persists scan + SPAN state to localStorage so it survives page reloads/navigation —
// it's only replaced when the user explicitly re-scans or re-exports/re-imports.
export function saveSpanState(key, state) {
  try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* storage unavailable */ }
}

export function loadSpanState(key) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
