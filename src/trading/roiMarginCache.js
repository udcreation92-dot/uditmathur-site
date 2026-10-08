// Per-day cache of real Zerodha basket margins for ROI-scanner combos, kept in localStorage.
// Keyed by script + trading date, so the slow "fetch real margin for every combo" pass is paid
// at most ONCE per script per day. Later scans reuse these margins to pick the top candidates,
// then re-fetch only that short-list fresh. A new day → empty cache → the full pass runs again.
function todayStr() {
  return new Date().toISOString().slice(0, 10);   // YYYY-MM-DD (local-ish; fine for a daily bucket)
}

function storeKey(symbol) {
  return `roiMarginCache_${symbol}_${todayStr()}`;
}

// Stable identity for a combo across scans: expiry + both strikes (symbols can vary in formatting).
export function cacheKeyFor(c) {
  return `${c.expiry_ts}|${c.ce_strike}|${c.pe_strike}`;
}

export function loadMarginCache(symbol) {
  try {
    return JSON.parse(localStorage.getItem(storeKey(symbol)) || "{}");
  } catch {
    return {};
  }
}

export function saveMarginCache(symbol, map) {
  try {
    const cur = storeKey(symbol);
    localStorage.setItem(cur, JSON.stringify(map));
    // Drop this script's stale (previous-day) caches so localStorage doesn't accrete forever.
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(`roiMarginCache_${symbol}_`) && k !== cur) stale.push(k);
    }
    stale.forEach(k => localStorage.removeItem(k));
  } catch {
    /* quota exceeded or storage disabled — cache is best-effort, scan still works */
  }
}

// Fraction (0..1) of the given combos that already have a cached net margin today.
export function cacheCoverage(cache, rows) {
  if (!rows.length) return 0;
  let hit = 0;
  for (const c of rows) if (cache[cacheKeyFor(c)]?.net != null) hit++;
  return hit / rows.length;
}
