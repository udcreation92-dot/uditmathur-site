import { useState, useEffect, useCallback, useMemo } from "react";
import { api } from "../api";
import { isExpiryDay, saveSpanState, loadSpanState } from "../spanUtils";
import ZerodhaMarginButton from "./ZerodhaMarginButton";
import { useZerodhaMargins } from "../useZerodhaMargins";
import { roiFromMargin, comboZerodhaMargin } from "../zerodhaMargin";
import { compositeScores } from "../roiScore";
import { loadMarginCache, saveMarginCache, cacheKeyFor, cacheCoverage } from "../roiMarginCache";

export default function RoiScanner({ symbol, onUseCombo }) {
  const persistKey = `roiScannerState_${symbol.symbol}`;
  const persisted = loadSpanState(persistKey) || {};

  const [strikeCount, setStrikeCount] = useState(20);
  const [safeCe, setSafeCe] = useState("");   // optional: only CE strikes >= this (nearest strike)
  const [safePe, setSafePe] = useState("");   // optional: only PE strikes <= this (nearest strike)
  const [expiryList, setExpiryList] = useState([]);   // [{ date, expiry(ts) }, ...] nearest first
  const [expiryIndex, setExpiryIndex] = useState(0);  // single expiry index, or "all" to sweep every expiry
  const [sortKey, setSortKey] = useState("score");    // default rank by composite score
  const [sortDir, setSortDir] = useState("desc");
  const [results, setResults] = useState(persisted.results ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [ignoreCache, setIgnoreCache] = useState(false);   // force the full slow pass even if cached
  const [progress, setProgress] = useState(null);          // { done, total } during the margin pass
  const [scanNote, setScanNote] = useState(null);          // e.g. "full pass" vs "cached" hint

  // Zerodha per-combo margins (on demand). A short strangle = both legs SELL at lot size.
  const legsFor = useCallback((r) => [
    { symbol: r.ce_symbol, side: "SELL", quantity: r.lot_size },
    { symbol: r.pe_symbol, side: "SELL", quantity: r.lot_size },
  ], []);
  const { margins: zMargins, bulkLoading: zBulk, checkOne: zCheckOne, checkAll: zCheckAll, reset: zReset, seed: zSeed } = useZerodhaMargins(legsFor);

  // Fetch real Zerodha basket margin for a list of combos with bounded concurrency, writing each
  // into the day-cache and reporting progress. Returns a { cacheKey -> {net,gross} } map. Rows that
  // error are simply skipped (they fall back to the ELM estimate for scoring).
  const CONCURRENCY = 6;   // Kite's margin API tolerates this; keeps the pass fast without 429s
  const bulkFetchMargins = useCallback(async (rows, cache, onProgress) => {
    const out = {};
    let done = 0, next = 0;
    onProgress({ done: 0, total: rows.length });
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= rows.length) break;
        const c = rows[i];
        const k = cacheKeyFor(c);
        try {
          const res = await comboZerodhaMargin(legsFor(c));
          const val = { net: res.net, gross: res.gross };
          out[k] = val; cache[k] = val;
        } catch { /* skip — scoring falls back to ELM for this combo */ }
        onProgress({ done: ++done, total: rows.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, rows.length) }, worker));
    return out;
  }, [legsFor]);

  useEffect(() => {
    saveSpanState(persistKey, { results });
  }, [persistKey, results]);

  useEffect(() => {
    let cancelled = false;
    api.getOptionChain(symbol.symbol, 1)
      .then(result => {
        if (!cancelled) { setExpiryList(result.data?.expiryData || []); setExpiryIndex(0); }
      })
      .catch(() => { if (!cancelled) { setExpiryList([]); setExpiryIndex(0); } });
    return () => { cancelled = true; };
  }, [symbol.symbol]);

  async function scan() {
    setLoading(true); setError(null); setProgress(null); setScanNote(null); zReset();
    try {
      const scanAll = expiryIndex === "all";
      // Pull EVERY candidate (limit:0) so the final top-40 is chosen on real margins — not an ELM pre-cut.
      const all = await api.roiScan({
        target_roi_pct: 0,                       // no ROI floor
        underlyings: [symbol.symbol],
        scan_all: scanAll,                       // "all" sweeps every listed expiry
        expiry_index: scanAll ? null : +expiryIndex,
        strike_count: +strikeCount,
        safe_ce: safeCe === "" ? null : +safeCe,
        safe_pe: safePe === "" ? null : +safePe,
        limit: 0,                                // return the full candidate set, uncapped
      });
      if (!all?.length) { setResults([]); return; }

      const cache = ignoreCache ? {} : loadMarginCache(symbol.symbol);
      const doFull = ignoreCache || cacheCoverage(cache, all) < 0.5;

      // A cold full pass over ALL expiries can be thousands of margin calls (minutes) — confirm first.
      if (doFull && all.length > 800 &&
          !window.confirm(`Full margin pass over ${all.length} combinations — this can take a few minutes. Run it now?`)) {
        return;
      }

      let marginByKey;
      if (doFull) {
        setScanNote(`Full pass — pricing all ${all.length} combos' real margin (cached for the rest of the day).`);
        marginByKey = await bulkFetchMargins(all, cache, setProgress);
      } else {
        // Warm cache: rank everything on cached margins, then re-price only the strongest short-list fresh.
        const cachedRoi = all.map(c => {
          const m = cache[cacheKeyFor(c)]?.net;
          return m != null ? roiFromMargin(c.premium_money, m, c.days_to_expiry) : c.roi_pct;
        });
        const prelim = compositeScores(all, cachedRoi);
        const shortList = all.map((_, i) => i).sort((a, b) => prelim[b] - prelim[a]).slice(0, 80).map(i => all[i]);
        setScanNote(`Cached margins (${new Date().toLocaleDateString()}) → re-pricing the top ${shortList.length} fresh.`);
        marginByKey = await bulkFetchMargins(shortList, cache, setProgress);
        // Keep cached margins for the rest so their scores stay margin-based (they won't reach top-40).
        for (const c of all) { const k = cacheKeyFor(c); if (!(k in marginByKey) && cache[k]) marginByKey[k] = cache[k]; }
      }
      saveMarginCache(symbol.symbol, cache);

      // Final ranking over every candidate on the margins we now have (ELM fallback where a call failed).
      const finalRoi = all.map(c => {
        const m = marginByKey[cacheKeyFor(c)]?.net;
        return m != null ? roiFromMargin(c.premium_money, m, c.days_to_expiry) : c.roi_pct;
      });
      const finalScores = compositeScores(all, finalRoi);
      const top = all.map((_, i) => i).sort((a, b) => finalScores[b] - finalScores[a]).slice(0, 40).map(i => all[i]);

      setResults(top);
      // Seed the shown rows' real margins by their NEW index so the table renders real ROI/Score at once.
      const seeded = {};
      top.forEach((c, i) => { const m = marginByKey[cacheKeyFor(c)]; if (m) seeded[i] = m; });
      zSeed(seeded);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setProgress(null);
    }
  }

  function useCombo(r) {
    onUseCombo([
      { symbol: r.ce_symbol, name: "", side: "SELL", quantity: r.lot_size, lot_size: r.lot_size, order_type: "LMT", limit_price: r.ce_bid || 0, product_type: "MARGIN" },
      { symbol: r.pe_symbol, name: "", side: "SELL", quantity: r.lot_size, lot_size: r.lot_size, order_type: "LMT", limit_price: r.pe_bid || 0, product_type: "MARGIN" },
    ]);
  }

  const anyExpiryDay = (results || []).some(r => isExpiryDay(r.days_to_expiry));

  function toggleSort(key) {
    if (sortKey === key) setSortDir(d => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  // Effective ROI per row: the REAL Zerodha basket-margin ROI once that combo's margin is checked,
  // else the ELM-only estimate from the scan. This is the ROI the row actually displays.
  const effRoi = useMemo(() => (results || []).map((r, i) => {
    const zNet = zMargins[i]?.net;
    return zNet != null ? roiFromMargin(r.premium_money, zNet, r.days_to_expiry) : r.roi_pct;
  }), [results, zMargins]);

  // Score recomputed CLIENT-SIDE from the EFFECTIVE ROI, so Score always tracks the SAME margin as
  // the ROI column: ELM-only at scan time, then real Zerodha margin for each row as you check it.
  // Mirrors the backend _add_scores — winsorize each metric to its 5th–95th pct, min-max, 40/30/30.
  const scores = useMemo(() => results ? compositeScores(results, effRoi) : [], [results, effRoi]);

  // Display order: indices into `results` sorted by the chosen column. We sort indices (not the
  // array) so each row keeps its ORIGINAL index for the per-row Zerodha margin cache (keyed by i).
  // Score and ROI% sort on the client-recomputed effective values so sorting matches what's shown.
  const order = useMemo(() => {
    if (!results) return [];
    const idx = results.map((_, i) => i);
    const val = (i) => {
      if (sortKey === "score") return scores[i] ?? -Infinity;
      if (sortKey === "roi_pct") return effRoi[i] ?? -Infinity;
      const v = results[i][sortKey];
      return v == null ? -Infinity : v;
    };
    idx.sort((a, b) => { const d = val(a) - val(b); return sortDir === "desc" ? -d : d; });
    return idx;
  }, [results, scores, effRoi, sortKey, sortDir]);

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-1">Short Strangle ROI Scanner</h2>
        <p className="text-xs text-gray-500 mb-4">
          Scanning <span className="text-gray-300 font-medium">{symbol.symbol}</span> for CE + PE selling combinations on the
          selected expiry (or <span className="text-gray-400">All expiries</span> at once). Ranked by a composite{" "}
          <span className="text-amber-300 font-medium">Score</span> (0–100) balancing annualized ROI, <span className="text-sky-300">Theta %</span>{" "}
          (daily decay ÷ premium) and <span className="text-gray-300">Dist σ</span> (nearest leg's distance in standard deviations
          = distance ÷ IV·√time, so the same % counts as safer with fewer days left) — so a reckless
          near-ATM combo with huge ROI ranks below a safer, high-decay one. Click any column header to re-sort. ROI%, the{" "}
          <span className="text-indigo-300">Margin</span> column and the Score all use each combo's <span className="text-indigo-300">real Zerodha
          basket margin</span> (with the hedge benefit between the two legs). The <span className="text-gray-400">first scan of a script each day</span>{" "}
          prices <span className="text-gray-400">every</span> combination's real margin (slow — a progress bar shows it) and caches them; later
          scans that day reuse the cache to shortlist, then re-price only the strongest fresh, so they return in seconds. Tick{" "}
          <span className="text-gray-400">Full rescan</span> to force the slow pass again. <span className="text-gray-400">All expiries</span> prices
          thousands of combos (minutes) — it asks before running. Only strikes within the selected range (each side of spot) are
          checked and the top 40 by score are shown — widen the strike range to reach further OTM / lower-premium combos.
          Optionally bound the combos with <span className="text-gray-400">Safe CE</span> (only CE strikes at/above it) and/or{" "}
          <span className="text-gray-400">Safe PE</span> (only PE strikes at/below it) — the figure snaps to the nearest available strike.
        </p>

        <div className="flex flex-wrap gap-4 items-end">
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Expiry
            <select value={expiryIndex} onChange={e => setExpiryIndex(e.target.value === "all" ? "all" : +e.target.value)} className="input-field w-56">
              {expiryList.length === 0
                ? <option value={0}>loading…</option>
                : [<option key="all" value="all">All expiries</option>,
                   ...expiryList.map((e, i) => <option key={e.expiry ?? i} value={i}>{e.date}</option>)]}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Strike range
            <select value={strikeCount} onChange={e => setStrikeCount(+e.target.value)} className="input-field w-24">
              {[5, 10, 15, 20].map(v => <option key={v} value={v}>±{v}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400" title="Optional: keep only CE strikes at or above this. Snapped to the nearest available strike. Leave blank for all CE.">
            Safe CE ≥ <span className="text-gray-600">(optional)</span>
            <input type="number" value={safeCe} onChange={e => setSafeCe(e.target.value)} placeholder="all CE"
              className="input-field w-28" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400" title="Optional: keep only PE strikes at or below this. Snapped to the nearest available strike. Leave blank for all PE.">
            Safe PE ≤ <span className="text-gray-600">(optional)</span>
            <input type="number" value={safePe} onChange={e => setSafePe(e.target.value)} placeholder="all PE"
              className="input-field w-28" />
          </label>
          <label className="flex items-center gap-2 text-xs text-gray-400 select-none" title="Ignore today's cached margins and re-price every combination from scratch (slow).">
            <input type="checkbox" checked={ignoreCache} onChange={e => setIgnoreCache(e.target.checked)} className="accent-blue-600" />
            Full rescan (ignore cache)
          </label>
          <button onClick={scan} disabled={loading}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium">
            {loading ? (progress ? `Pricing ${progress.done}/${progress.total}…` : "Scanning…") : "Scan"}
          </button>
        </div>

        {progress && (
          <div className="mt-3">
            <div className="h-1.5 bg-gray-800 rounded overflow-hidden">
              <div className="h-full bg-blue-500 transition-all"
                style={{ width: `${progress.total ? Math.round(progress.done / progress.total * 100) : 0}%` }} />
            </div>
            <p className="text-[11px] text-gray-500 mt-1">{scanNote} &nbsp;{progress.done}/{progress.total} combos priced.</p>
          </div>
        )}
        {!progress && scanNote && !loading && <p className="text-[11px] text-gray-600 mt-2">{scanNote}</p>}

        {error && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-2 mt-3">{error}</p>}
      </div>

      {results && (
        results.length === 0 ? (
          <p className="text-gray-500 text-sm">
            No combinations found on this expiry. Try a wider strike range.
          </p>
        ) : (
          <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
            <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-b border-gray-800">
              <button onClick={() => zCheckAll(results)} disabled={zBulk}
                className="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded font-medium">
                {zBulk ? "Refreshing margins…" : "↻ Refresh margins (Zerodha)"}
              </button>
              <span className="text-[11px] text-gray-500">
                ROI &amp; Score use each combo's real Zerodha basket margin (with hedge benefit), pulled automatically on scan.
                Re-pull here if quotes have moved.
              </span>
            </div>
            {anyExpiryDay && (
              <p className="text-[11px] text-amber-300 bg-amber-900/20 border-b border-amber-800/50 px-3 py-2">
                Expiry-day combos carry an additional 2% ELM per short index leg (4% total instead of 2%),
                per NSE's index-expiry margin rule — already reflected in the ELM column below.
              </p>
            )}
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th onClick={() => toggleSort("score")} className="text-right px-2 cursor-pointer hover:text-gray-300 select-none" title="Composite 0-100: 20% ROI, 40% Theta%, 40% σ-distance">
                    Score{sortKey === "score" ? (sortDir === "desc" ? " ▼" : " ▲") : ""}</th>
                  <th className="text-left py-2 px-2">Expiry</th>
                  <th className="text-right px-2">Days</th>
                  <th className="text-right px-2">CE Strike</th>
                  <th className="text-right px-2">CE Bid</th>
                  <th className="text-right px-2">PE Strike</th>
                  <th className="text-right px-2">PE Bid</th>
                  <th className="text-right px-2">Premium</th>
                  <th onClick={() => toggleSort("theta_pct")} className="text-right px-2 cursor-pointer hover:text-gray-300 select-none" title="Daily theta income as % of premium collected (both legs' decay ÷ premium)">
                    Theta %{sortKey === "theta_pct" ? (sortDir === "desc" ? " ▼" : " ▲") : ""}</th>
                  <th onClick={() => toggleSort("dist_sigma")} className="text-right px-2 cursor-pointer hover:text-gray-300 select-none" title="Nearest leg's distance from spot. % shown; σ (distance ÷ IV·√time) is the time-adjusted safety the Score ranks on — higher σ = harder to breach. Sorts by σ.">
                    Dist %/σ{sortKey === "dist_sigma" ? (sortDir === "desc" ? " ▼" : " ▲") : ""}</th>
                  <th className="text-right px-2" title="Real Zerodha basket margin (with hedge benefit) — the ROI/Score denominator">Margin</th>
                  <th onClick={() => toggleSort("roi_pct")} className="text-right px-2 cursor-pointer hover:text-gray-300 select-none" title="Annualized ROI on real Zerodha margin (ᶻ); falls back to ELM estimate only if the margin pull failed">
                    ROI %{sortKey === "roi_pct" ? (sortDir === "desc" ? " ▼" : " ▲") : ""}</th>
                  <th className="px-2"></th>
                </tr>
              </thead>
              <tbody>
                {order.map((i, rank) => {
                  const r = results[i];
                  // The ROI column defaults to the ELM-only estimate, and is overridden by the real
                  // Zerodha-margin ROI (ᶻ) once that combo's margin has been pulled. zMargins is keyed
                  // by the ORIGINAL result index i, which survives re-sorting.
                  const zNet = zMargins[i]?.net;
                  const zRoi = zNet != null ? roiFromMargin(r.premium_money, zNet, r.days_to_expiry) : null;
                  const top = rank === 0 && sortKey === "score" && sortDir === "desc";
                  const anyZ = zMargins[i]?.net != null;
                  return (
                    <tr key={i} className={`border-b border-gray-800/50 hover:bg-gray-800/40 ${top ? "bg-green-900/15" : ""}`}>
                      <td className="text-right px-2 font-bold tabular-nums text-amber-300"
                        title={`Composite score from ${anyZ ? "real Zerodha-margin" : "ELM-only"} ROI + Theta% + distance (higher = better balance)`}>
                        {scores[i] != null ? scores[i] : "—"}{top && <span className="ml-1 text-[9px] text-green-400">★</span>}
                      </td>
                      <td className="py-1.5 px-2 text-gray-300">
                        {r.expiry_date}
                        {isExpiryDay(r.days_to_expiry) && (
                          <span className="ml-1.5 text-[9px] px-1 py-0.5 rounded bg-amber-900/40 text-amber-300 border border-amber-800 align-middle"
                            title="Expiry day: +2% additional ELM applied to each short index leg (4% total)">
                            +2% ELM
                          </span>
                        )}
                      </td>
                      <td className="text-right px-2 text-gray-400">{r.days_to_expiry}</td>
                      <td className="text-right px-2 text-gray-200 font-medium">{r.ce_strike}</td>
                      <td className="text-right px-2 text-gray-300">{r.ce_bid}</td>
                      <td className="text-right px-2 text-gray-200 font-medium">{r.pe_strike}</td>
                      <td className="text-right px-2 text-gray-300">{r.pe_bid}</td>
                      <td className="text-right px-2 text-gray-100 font-medium">₹{r.premium_money.toLocaleString()}</td>
                      <td className="text-right px-2 text-sky-300 tabular-nums" title={r.theta_money != null ? `₹${r.theta_money.toLocaleString()}/day decay income` : ""}>
                        {r.theta_pct != null ? `${r.theta_pct}%` : "—"}
                      </td>
                      <td className="text-right px-2 text-gray-300 tabular-nums" title={`CE ${r.ce_dist_pct}% · PE ${r.pe_dist_pct}% from spot · nearest leg ${r.dist_sigma != null ? r.dist_sigma + "σ" : "—"} OTM (time-adjusted)`}>
                        {r.dist_atm_pct != null ? `${r.dist_atm_pct}%` : "—"}
                        {r.dist_sigma != null && <span className="ml-1 text-[10px] text-gray-500">{r.dist_sigma}σ</span>}
                      </td>
                      <td className="text-right px-2 tabular-nums">
                        {zMargins[i]?.loading
                          ? <span className="text-gray-600">…</span>
                          : zNet != null
                            ? <span className="text-indigo-300" title="Real Zerodha basket margin (with hedge benefit)">₹{Math.round(zNet).toLocaleString()}ᶻ</span>
                            : <span className="text-gray-500" title="ELM-only estimate — real margin pull failed; ↻ Refresh to retry">₹{r.elm_estimate.toLocaleString()}</span>}
                      </td>
                      <td className="text-right px-2 font-semibold">
                        {zMargins[i]?.loading
                          ? <span className="text-gray-600">…</span>
                          : zRoi != null
                            ? <span className="text-indigo-400" title="ROI from real Zerodha basket margin">{zRoi.toFixed(2)}%ᶻ</span>
                            : <span className="text-green-400" title="ELM-only estimate — real margin pull failed; ↻ Refresh to retry">{r.roi_pct}%</span>}
                      </td>
                      <td className="px-2">
                        <div className="flex items-center gap-1.5 justify-end">
                          <ZerodhaMarginButton entry={zMargins[i]} onCheck={() => zCheckOne(i, r)} />
                          <button onClick={() => useCombo(r)}
                            className="text-[10px] px-2 py-1 bg-blue-600 hover:bg-blue-700 rounded font-medium whitespace-nowrap">
                            Use in Builder
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      )}
    </div>
  );
}
