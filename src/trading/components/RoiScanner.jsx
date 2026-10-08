import { useState, useEffect, useCallback, useMemo } from "react";
import { api } from "../api";
import { isExpiryDay, saveSpanState, loadSpanState } from "../spanUtils";
import ZerodhaMarginButton from "./ZerodhaMarginButton";
import { useZerodhaMargins } from "../useZerodhaMargins";
import { roiFromMargin } from "../zerodhaMargin";

export default function RoiScanner({ symbol, onUseCombo }) {
  const persistKey = `roiScannerState_${symbol.symbol}`;
  const persisted = loadSpanState(persistKey) || {};

  const [targetRoi, setTargetRoi] = useState(60);
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

  // Zerodha per-combo margins (on demand). A short strangle = both legs SELL at lot size.
  const legsFor = useCallback((r) => [
    { symbol: r.ce_symbol, side: "SELL", quantity: r.lot_size },
    { symbol: r.pe_symbol, side: "SELL", quantity: r.lot_size },
  ], []);
  const { margins: zMargins, bulkLoading: zBulk, checkOne: zCheckOne, checkAll: zCheckAll, reset: zReset } = useZerodhaMargins(legsFor);

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
    setLoading(true); setError(null);
    try {
      const scanAll = expiryIndex === "all";
      const data = await api.roiScan({
        target_roi_pct: +targetRoi,
        underlyings: [symbol.symbol],
        // "all" sweeps every listed expiry; otherwise scan ONLY the selected one.
        scan_all: scanAll,
        expiry_index: scanAll ? null : +expiryIndex,
        strike_count: +strikeCount,
        safe_ce: safeCe === "" ? null : +safeCe,   // only CE strikes >= this (nearest strike)
        safe_pe: safePe === "" ? null : +safePe,   // only PE strikes <= this (nearest strike)
      });
      setResults(data);
      zReset(); // stale margins/ROI shouldn't carry to a fresh result set
      // Auto-pull each combo's REAL Zerodha basket margin so ROI + Score are margin-based with no
      // manual click. The result set is capped (backend `limit`) to keep this fan-out bounded.
      if (data?.length) zCheckAll(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
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
  const scores = useMemo(() => {
    if (!results) return [];
    const pct = (s, p) => {
      if (!s.length) return 0;
      if (s.length === 1) return s[0];
      const idx = p * (s.length - 1), lo = Math.floor(idx), hi = Math.min(lo + 1, s.length - 1);
      return s[lo] + (s[hi] - s[lo]) * (idx - lo);
    };
    const norm = (vals) => {
      const s = vals.filter(v => v != null).sort((a, b) => a - b);
      const lo = pct(s, 0.05), hi = pct(s, 0.95), span = hi - lo;
      return (v) => (v == null || span <= 0) ? 0 : Math.max(0, Math.min(1, (v - lo) / span));
    };
    // Distance term uses σ-distance (time-adjusted) so cross-expiry safety is comparable.
    const nRoi = norm(effRoi), nTheta = norm(results.map(r => r.theta_pct)), nDist = norm(results.map(r => r.dist_sigma));
    return results.map((r, i) =>
      Math.round(1000 * (0.20 * nRoi(effRoi[i]) + 0.40 * nTheta(r.theta_pct) + 0.40 * nDist(r.dist_sigma))) / 10);
  }, [results, effRoi]);

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
          basket margin</span> (with the hedge benefit between the two legs) — pulled automatically on each scan, so there's nothing to
          click. The <span className="text-gray-400">Target ROI %</span> is a quick ELM-based pre-filter that trims the candidate set
          before those margins are fetched (it's a generous upper bound, so nothing that could clear your target on real margin is
          dropped). Only strikes within the selected range (on each side of spot) are checked — if the
          lowest result shown is well above your target, try a wider strike range to reach further OTM/lower-premium combos.
          Optionally bound the combos with <span className="text-gray-400">Safe CE</span> (only CE strikes at/above it) and/or{" "}
          <span className="text-gray-400">Safe PE</span> (only PE strikes at/below it) — the figure snaps to the nearest available strike.
        </p>

        <div className="flex flex-wrap gap-4 items-end">
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Target ROI % (p.a. · coarse pre-filter)
            <input type="number" min={1} value={targetRoi} onChange={e => setTargetRoi(e.target.value)}
              className="input-field w-28" />
          </label>
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
          <button onClick={scan} disabled={loading}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium">
            {loading ? "Scanning…" : "Scan"}
          </button>
        </div>

        {error && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-2 mt-3">{error}</p>}
      </div>

      {results && (
        results.length === 0 ? (
          <p className="text-gray-500 text-sm">
            No combinations found clearing the {targetRoi}% pre-filter on this expiry. Try a lower target or a wider strike range.
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
