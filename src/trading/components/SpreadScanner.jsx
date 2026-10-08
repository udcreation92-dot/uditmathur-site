import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import { pfCodeFor, toYYYYMMDD, elmRateFor, isExpiryDay, parseSpanMargins, saveSpanState, loadSpanState } from "../spanUtils";
import SpanFileStatus from "./SpanFileStatus";
import ZerodhaMarginButton from "./ZerodhaMarginButton";
import { useZerodhaMargins } from "../useZerodhaMargins";
import { roiFromMargin } from "../zerodhaMargin";

export default function SpreadScanner({ symbol, onUseCombo }) {
  const persistKey = `spreadScannerState_${symbol.symbol}`;
  const persisted = loadSpanState(persistKey) || {};

  const [optionType, setOptionType] = useState("CE");
  const [expiries, setExpiries] = useState([]); // [{expiry, date}]
  const [expiryTs, setExpiryTs] = useState("");
  const [strikes, setStrikes] = useState([]); // available strikes for optionType+expiry
  const [sellStrike, setSellStrike] = useState("");
  const [strikesLoading, setStrikesLoading] = useState(false);
  const [strikesError, setStrikesError] = useState(null);
  const [spot, setSpot] = useState(persisted.spot ?? null);

  const [results, setResults] = useState(persisted.results ?? null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // spanMargins persists across reloads until a new scan or export/import replaces it.
  const [resultsVersion, setResultsVersion] = useState(persisted.resultsVersion ?? 0);
  const [exportedVersion, setExportedVersion] = useState(persisted.exportedVersion ?? null);
  const [runId, setRunId] = useState(persisted.runId ?? null); // stamped into the exported .pos's acctId
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState(null);
  const [exportError, setExportError] = useState(null);
  const [spanMargins, setSpanMargins] = useState(persisted.spanMargins ?? null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(null);

  // Zerodha per-combo margins (on demand). A covered spread = SELL the short leg + BUY the hedge.
  const legsFor = useCallback((r) => [
    { symbol: r.sell_symbol, side: "SELL", quantity: r.lot_size },
    { symbol: r.buy_symbol, side: "BUY", quantity: r.lot_size },
  ], []);
  const { margins: zMargins, bulkLoading: zBulk, checkOne: zCheckOne, checkAll: zCheckAll, reset: zReset } = useZerodhaMargins(legsFor);

  useEffect(() => {
    saveSpanState(persistKey, { results, resultsVersion, exportedVersion, runId, spanMargins, spot });
  }, [persistKey, results, resultsVersion, exportedVersion, runId, spanMargins, spot]);

  useEffect(() => {
    let cancelled = false;
    api.getOptionChain(symbol.symbol, 1)
      .then(result => {
        if (cancelled) return;
        const list = result.data?.expiryData || [];
        setExpiries(list);
        setExpiryTs(list[0]?.expiry || "");
      })
      .catch(() => { if (!cancelled) setExpiries([]); });
    return () => { cancelled = true; };
  }, [symbol.symbol]);

  useEffect(() => {
    if (!expiryTs) return;
    let cancelled = false;
    setStrikesLoading(true); setStrikesError(null);
    api.getOptionChain(symbol.symbol, 20, expiryTs)
      .then(result => {
        if (cancelled) return;
        const rows = (result.data?.optionsChain || []).filter(r => r.option_type === optionType);
        const uniqueStrikes = [...new Set(rows.map(r => r.strike_price))].sort((a, b) => a - b);
        setStrikes(uniqueStrikes);
        const spotPrice = result.data?.optionsChain?.find(r => r.option_type === "")?.ltp;
        const closest = spotPrice != null
          ? uniqueStrikes.reduce((best, s) => Math.abs(s - spotPrice) < Math.abs(best - spotPrice) ? s : best, uniqueStrikes[0])
          : uniqueStrikes[0];
        setSellStrike(closest ?? "");
      })
      .catch(err => { if (!cancelled) setStrikesError(err.message); })
      .finally(() => { if (!cancelled) setStrikesLoading(false); });
    return () => { cancelled = true; };
  }, [symbol.symbol, expiryTs, optionType]);

  async function scan() {
    if (!sellStrike || !expiryTs) return;
    setLoading(true); setError(null);
    try {
      const data = await api.spreadScan({
        underlying: symbol.symbol,
        option_type: optionType,
        sell_strike: +sellStrike,
        expiry_ts: +expiryTs,
        strike_count: 20,
      });
      setResults(data);
      setResultsVersion(v => v + 1);
      zReset(); // stale margins/ROI shouldn't carry to a fresh result set
      const chain = await api.getOptionChain(symbol.symbol, 1, expiryTs).catch(() => null);
      setSpot(chain?.data?.optionsChain?.find(r => r.option_type === "")?.ltp ?? null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function useCombo(r) {
    onUseCombo([
      { symbol: r.sell_symbol, name: "", side: "SELL", quantity: r.lot_size, lot_size: r.lot_size, order_type: "LMT", limit_price: r.sell_bid || 0, product_type: "MARGIN" },
      { symbol: r.buy_symbol, name: "", side: "BUY", quantity: r.lot_size, lot_size: r.lot_size, order_type: "LMT", limit_price: r.buy_ask || 0, product_type: "MARGIN" },
    ]);
  }

  async function exportPos() {
    if (!results || results.length === 0) return;
    setExporting(true); setExportError(null); setExportMessage(null);
    try {
      const expiryDate = expiries.find(e => String(e.expiry) === String(expiryTs))?.date;
      const expiryYYYYMMDD = toYYYYMMDD(expiryDate);
      const pfCode = pfCodeFor(symbol.symbol);
      const oCode = optionType === "CE" ? "C" : "P";
      const portfolios = results.map(r => [
        { pf_code: pfCode, expiry: expiryYYYYMMDD, option_type: oCode, strike: r.sell_strike, net: -r.lot_size },
        { pf_code: pfCode, expiry: expiryYYYYMMDD, option_type: oCode, strike: r.buy_strike, net: r.lot_size },
      ]);
      const { path, run_id } = await api.exportSpanPos(portfolios, `spread_${pfCode}_${expiryYYYYMMDD}`);
      setExportMessage(`Saved to ${path}`);
      setExportedVersion(resultsVersion);
      setRunId(run_id);
      setSpanMargins(null);
    } catch (err) {
      setExportError(err.message);
    } finally {
      setExporting(false);
    }
  }

  async function importSpanCsv() {
    setImporting(true); setImportError(null);
    try {
      setSpanMargins(parseSpanMargins(await api.getSpanResults(), runId));
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImporting(false);
    }
  }

  const spanStale = exportedVersion !== resultsVersion;
  // All rows in one spread scan share the selected expiry, so expiry-day status is uniform —
  // derive it from the results. On the short index leg's expiry day an extra 2% ELM applies
  // (even though hedged), so the rate becomes 4% instead of 2%.
  const scanIsExpiryDay = (results || []).length > 0 && isExpiryDay(results[0].days_to_expiry);
  const elmRate = elmRateFor(symbol.symbol, scanIsExpiryDay);
  // Only the short (sell) leg attracts ELM — the long hedge leg's risk is capped at premium paid.
  const elmPerCombo = (r) => spot != null ? spot * r.lot_size * elmRateFor(symbol.symbol, isExpiryDay(r.days_to_expiry)) : null;

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-1">Covered Spread Scanner</h2>
        <p className="text-xs text-gray-500 mb-4">
          Pick the strike you want to sell — this scans every hedge (buy) strike further OTM on the same side
          (e.g. sell 24000 CE + buy 24100 CE, sell 24000 CE + buy 24150 CE, …). Real total margin = SPAN + ELM:
          export the combos to PC-SPAN for real per-width SPAN margin (it varies a lot with strike width and this
          account's margin API doesn't model that), and ELM — {(elmRate * 100).toFixed(1)}% of notional, charged
          only on the short (sell) leg since the long hedge leg's risk is capped at the premium paid — is computed
          instantly below without needing PC-SPAN.
          {scanIsExpiryDay && <span className="text-amber-300"> On this expiry day, the short index leg carries an
          additional 2% ELM (4% total) per NSE's index-expiry rule — already applied.</span>}
        </p>

        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex flex-col gap-1 text-xs text-gray-400">
            Option Type
            <div className="flex gap-2">
              {["CE", "PE"].map(t => (
                <button key={t} onClick={() => setOptionType(t)}
                  className={`px-4 py-2 rounded text-sm font-semibold ${optionType === t ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Expiry
            <select value={expiryTs} onChange={e => setExpiryTs(e.target.value)} className="input-field w-36">
              {expiries.map(e => <option key={e.expiry} value={e.expiry}>{e.date}</option>)}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Sell Strike ({optionType})
            <select value={sellStrike} onChange={e => { setSellStrike(e.target.value); setResults(null); }}
              disabled={strikesLoading} className="input-field w-28">
              {strikes.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>

          <button onClick={scan} disabled={loading || strikesLoading || !sellStrike}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium">
            {loading ? "Scanning…" : "Scan Buy Strikes"}
          </button>
        </div>

        {strikesError && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-2 mt-3">{strikesError}</p>}
        {error && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-2 mt-3">{error}</p>}
      </div>

      {results && results.length > 0 && (
        <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
          <h2 className="text-sm font-semibold text-gray-300 mb-1">Real Margin via PC-SPAN</h2>
          <p className="text-xs text-gray-500 mb-3">
            Export a .pos file for all {results.length} combos above, run it through PC-SPAN, then re-import its Results.csv
            to get each combo's real SPAN margin — added to the ELM already shown below for the true total margin and ROI.
            Both files live in <span className="text-gray-400">TradingData\SPAN\</span> — no picking/uploading needed.
          </p>
          <div className="flex flex-wrap gap-4 items-center">
            <button onClick={exportPos} disabled={exporting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium">
              {exporting ? "Exporting…" : "Export .pos for PC-SPAN"}
            </button>
            <button onClick={importSpanCsv} disabled={importing}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 disabled:opacity-50 rounded text-sm font-medium text-gray-200">
              {importing ? "Loading…" : "Load Results.csv"}
            </button>
          </div>
          {exportMessage && <p className="text-green-400 text-sm mt-3">{exportMessage}</p>}
          {exportError && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-2 mt-3">{exportError}</p>}
          {importError && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-2 mt-3">{importError}</p>}
          {spanMargins && spanStale && (
            <p className="text-yellow-400 text-sm bg-yellow-900/20 border border-yellow-800 rounded p-2 mt-3">
              Results changed since this .pos was exported — re-export before importing to keep rows aligned.
            </p>
          )}
          <SpanFileStatus />
        </div>
      )}

      {results && (
        results.length === 0 ? (
          <p className="text-gray-500 text-sm">No valid hedge combinations found (no live bid/ask on the legs).</p>
        ) : (
          <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
            <div className="flex flex-wrap items-center gap-3 px-3 py-2 border-b border-gray-800">
              <button onClick={() => zCheckAll(results)} disabled={zBulk}
                className="text-xs px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded font-medium">
                {zBulk ? "Checking margins…" : "Check all margins (Zerodha)"}
              </button>
              <span className="text-[11px] text-gray-500">
                Pulls each combo's Zerodha basket margin (real account, with hedge benefit) and recomputes the ROI column from it.
              </span>
            </div>
            {scanIsExpiryDay && (
              <p className="text-[11px] text-amber-300 bg-amber-900/20 border-b border-amber-800/50 px-3 py-2">
                Expiry day: the short index leg carries an additional 2% ELM (4% total instead of 2%),
                per NSE's index-expiry margin rule — already reflected in the ELM and Total columns below.
              </p>
            )}
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left py-2 px-2">Buy Strike</th>
                  <th className="text-right px-2">Width</th>
                  <th className="text-right px-2">Sell Bid</th>
                  <th className="text-right px-2">Buy Ask</th>
                  <th className="text-right px-2">Net Premium</th>
                  <th className="text-right px-2">ELM</th>
                  {spanMargins && !spanStale ? (
                    <>
                      <th className="text-right px-2">SPAN Margin</th>
                      <th className="text-right px-2">Total (SPAN+ELM)</th>
                      <th className="text-right px-2">ROI %</th>
                    </>
                  ) : (
                    <th className="text-right px-2">ROI % (ELM only)</th>
                  )}
                  <th className="px-2"></th>
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => {
                  const elm = elmPerCombo(r);
                  const elmRoi = elm ? (r.premium_money / elm) * (365 / r.days_to_expiry) * 100 : null;

                  const spanMargin = spanMargins && !spanStale ? spanMargins[i] : undefined;
                  const spanTotal = spanMargin != null && elm != null ? spanMargin + elm : null;
                  const spanTotalRoi = spanTotal ? (r.premium_money / spanTotal) * (365 / r.days_to_expiry) * 100 : null;
                  // When a Zerodha margin has been pulled for this row, it overrides the ROI column.
                  const zNet = zMargins[i]?.net;
                  const zRoi = zNet != null ? roiFromMargin(r.premium_money, zNet, r.days_to_expiry) : null;

                  return (
                    <tr key={i} className="border-b border-gray-800/50 hover:bg-gray-800/40">
                      <td className="py-1.5 px-2 text-gray-200 font-medium">{r.buy_strike}</td>
                      <td className="text-right px-2 text-gray-400">{r.width}</td>
                      <td className="text-right px-2 text-gray-300">{r.sell_bid}</td>
                      <td className="text-right px-2 text-gray-300">{r.buy_ask}</td>
                      <td className="text-right px-2 text-gray-100 font-medium">₹{r.premium_money.toLocaleString()}</td>
                      <td className="text-right px-2 text-gray-400">{elm != null ? `₹${elm.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}</td>
                      {spanMargins && !spanStale ? (
                        <>
                          <td className="text-right px-2 text-gray-200">{spanMargin != null ? `₹${spanMargin.toLocaleString()}` : "—"}</td>
                          <td className="text-right px-2 text-gray-200">{spanTotal != null ? `₹${spanTotal.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}</td>
                          <td className="text-right px-2 font-semibold">
                            {zRoi != null
                              ? <span className="text-indigo-400" title="ROI computed from Zerodha margin">{zRoi.toFixed(2)}%ᶻ</span>
                              : <span className="text-blue-400">{spanTotalRoi != null ? `${spanTotalRoi.toFixed(2)}%` : "—"}</span>}
                          </td>
                        </>
                      ) : (
                        <td className="text-right px-2 font-semibold">
                          {zRoi != null
                            ? <span className="text-indigo-400" title="ROI computed from Zerodha margin">{zRoi.toFixed(2)}%ᶻ</span>
                            : <span className="text-green-400">{elmRoi != null ? `${elmRoi.toFixed(2)}%` : "—"}</span>}
                        </td>
                      )}
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
