import { useState, useEffect, useMemo } from "react";
import { api } from "../api";
import PayoffPanel from "./PayoffPanel";

const fmt = (v) => (v == null ? "—" : "₹" + Math.round(v).toLocaleString("en-IN"));

// What-if: preview how the payoff / breakevens / ROI change if you add ONE OR MORE trial legs,
// before placing anything. When you like it, the legs are handed to the Strategy Builder (with this
// strategy's broker pre-set) where you place them.
export default function WhatIfPayoff({ strategy, onSendToBuilder }) {
  const [chain, setChain] = useState(null);
  const [err, setErr] = useState(null);
  const [trials, setTrials] = useState([]);   // [{ symbol, label, lot_size, ltp, bid, ask, side, lots }]
  const [picking, setPicking] = useState(true); // is the strike picker open (open by default for the 1st leg)
  const [margin, setMargin] = useState(null);
  const [analysis, setAnalysis] = useState(null); // from PayoffPanel: breakevens / max P&L

  useEffect(() => {
    if (!strategy.underlying_symbol) { setErr("No underlying for this strategy."); return; }
    api.getOptionChain(strategy.underlying_symbol, 14, "").then(r => setChain(r.data)).catch(e => setErr(e.message));
  }, [strategy.underlying_symbol]);

  const baseLegs = useMemo(() => strategy.legs.filter(l => l.qty > 0).map(l => ({
    symbol: l.symbol, side: l.side, quantity: l.qty, limit_price: l.entry || 0, bid: l.bid, ask: l.ask,
  })), [strategy.legs]);

  // Each trial leg's realistic entry premium: a short fills near the bid, a long near the ask.
  const trialLegs = trials.map(t => ({
    symbol: t.symbol, side: t.side, quantity: t.lots * t.lot_size,
    limit_price: (t.side === "SELL" ? t.bid : t.ask) || t.ltp, bid: t.bid, ask: t.ask,
  }));
  const combined = [...baseLegs, ...trialLegs];
  const trialKey = JSON.stringify(trials.map(t => [t.symbol, t.side, t.lots]));

  // Possible combined margin (real Zerodha basket) whenever the trial set changes.
  useEffect(() => {
    if (trials.length === 0) { setMargin(null); return; }
    let alive = true;
    api.whatIfMargin(combined.map(l => ({ symbol: l.symbol, side: l.side, qty: l.quantity })))
      .then(r => { if (alive) setMargin(r.margin); }).catch(() => { if (alive) setMargin(null); });
    return () => { alive = false; };
  }, [trialKey]); // eslint-disable-line

  const daysToExpiry = useMemo(() => {
    if (!strategy.expiry) return null;
    return Math.max(Math.round((new Date(strategy.expiry + "T15:30:00") - new Date()) / 86400000) + 1, 1);
  }, [strategy.expiry]);

  // Possible ROIs on the new margin, annualized. Live = forward capture at close-out marks
  // (short→ask, long→bid) + realized; Max = the payoff's best case.
  const possible = useMemo(() => {
    if (!margin || !daysToExpiry) return null;
    let fwd = strategy.realized_total || 0;
    for (const l of combined) {
      const px = l.side === "SELL" ? (l.ask ?? l.limit_price) : (l.bid ?? l.limit_price);
      if (px == null) return null;
      fwd += (l.side === "SELL" ? 1 : -1) * px * l.quantity;
    }
    const ann = (pl) => (pl / margin) * (365 / daysToExpiry) * 100;
    return { liveRoi: ann(fwd), maxRoi: analysis && !analysis.profitUnbounded ? ann(analysis.maxProfit) : null };
  }, [trialKey, margin, daysToExpiry, analysis, strategy.realized_total]); // eslint-disable-line

  function addTrial(row, label) {
    setTrials(prev => [...prev, { symbol: row.symbol, label, lot_size: row.lot_size, ltp: row.ltp, bid: row.bid, ask: row.ask, side: "SELL", lots: 1 }]);
    setPicking(false);
  }
  const patch = (i, p) => setTrials(prev => prev.map((t, idx) => idx === i ? { ...t, ...p } : t));
  const removeTrial = (i) => setTrials(prev => prev.filter((_, idx) => idx !== i));

  function sendToBuilder() {
    const legs = trials.map(t => ({
      symbol: t.symbol, name: "", side: t.side, quantity: t.lots * t.lot_size, lot_size: t.lot_size,
      order_type: "LMT", limit_price: (t.side === "SELL" ? t.bid : t.ask) || t.ltp || 0, product_type: "MARGIN",
    }));
    onSendToBuilder?.(legs, "replace", strategy.broker);
  }

  // --- chain picker -------------------------------------------------------------------------
  const underlying = chain?.optionsChain?.find(o => o.option_type === "");
  const byStrike = {};
  for (const row of (chain?.optionsChain || [])) if (row.option_type) (byStrike[row.strike_price] ??= {})[row.option_type] = row;
  const strikes = Object.keys(byStrike).map(Number).sort((a, b) => a - b);
  const atm = underlying ? strikes.reduce((p, c) => Math.abs(c - underlying.ltp) < Math.abs(p - underlying.ltp) ? c : p, strikes[0]) : null;

  return (
    <div className="mt-2 bg-gray-900/50 border border-indigo-900/50 rounded p-3 text-xs">
      <p className="text-indigo-300 font-semibold mb-2">🔬 What-if — add trial leg(s) to preview the payoff before ordering</p>
      {err && <p className="text-red-400 mb-2">{err}</p>}

      {/* selected trial legs */}
      {trials.length > 0 && (
        <div className="space-y-1 mb-2">
          {trials.map((t, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 bg-gray-900/70 border border-gray-800 rounded px-2 py-1">
              <b className="text-gray-100">{t.label}</b>
              <div className="flex gap-1">
                {["SELL", "BUY"].map(sd => (
                  <button key={sd} onClick={() => patch(i, { side: sd })} className={`px-2 py-0.5 rounded ${t.side === sd ? (sd === "SELL" ? "bg-red-600 text-white" : "bg-green-600 text-white") : "bg-gray-800 text-gray-400"}`}>{sd}</button>
                ))}
              </div>
              <label className="text-gray-400">Lots <input type="number" min={1} value={t.lots} onChange={e => patch(i, { lots: Math.max(1, +e.target.value || 1) })} className="input-field text-xs w-14 ml-1" /></label>
              <span className="text-gray-500">= {t.lots * t.lot_size} qty @ ~₹{t.side === "SELL" ? (t.bid || t.ltp) : (t.ask || t.ltp)}</span>
              <button onClick={() => removeTrial(i)} className="text-gray-500 hover:text-red-400 ml-auto">✕ remove</button>
            </div>
          ))}
        </div>
      )}

      {/* strike picker */}
      {picking ? (
        chain ? (
          <div className="max-h-56 overflow-y-auto border border-gray-800 rounded">
            <table className="w-full text-[12px]">
              <thead className="text-gray-500 sticky top-0 bg-gray-900">
                <tr><th className="py-1 text-right px-3">Call LTP</th><th className="py-1 text-center">Strike</th><th className="py-1 text-left px-3">Put LTP</th></tr>
              </thead>
              <tbody>
                {strikes.map(s => {
                  const ce = byStrike[s].CE, pe = byStrike[s].PE;
                  return (
                    <tr key={s} className={`border-t border-gray-800/50 ${s === atm ? "bg-blue-900/15" : ""}`}>
                      <td className="text-right px-3 py-1.5">{ce ? <button onClick={() => addTrial(ce, `${s} CALL`)} className="text-green-300 hover:underline">{ce.ltp?.toFixed(2)}</button> : "-"}</td>
                      <td className="text-center py-1.5 text-gray-300 font-medium">{s}</td>
                      <td className="text-left px-3 py-1.5">{pe ? <button onClick={() => addTrial(pe, `${s} PUT`)} className="text-pink-300 hover:underline">{pe.ltp?.toFixed(2)}</button> : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {trials.length > 0 && <button onClick={() => setPicking(false)} className="text-gray-400 hover:text-gray-200 mt-1">Done adding</button>}
          </div>
        ) : <p className="text-gray-500">Loading option chain…</p>
      ) : (
        <button onClick={() => setPicking(true)} className="text-indigo-300 hover:text-indigo-200 border border-indigo-900/60 bg-indigo-900/10 rounded px-3 py-1">+ add another trial leg</button>
      )}

      {trials.length > 0 && (
        <div className="mt-2 space-y-2">
          {/* Combined payoff — its own labels show the POSSIBLE breakevens / max P&L */}
          <PayoffPanel legs={combined} realized={strategy.realized_total || 0} onAnalysis={setAnalysis} />

          <div className="flex flex-wrap gap-x-6 gap-y-1 bg-gray-900/70 border border-gray-800 rounded px-3 py-2">
            <span className="text-gray-400">Possible breakeven{(analysis?.breakevens?.length ?? 0) !== 1 ? "s" : ""}: <b className="text-gray-200">{analysis?.breakevens?.length ? analysis.breakevens.map(b => Math.round(b)).join(" · ") : "—"}</b></span>
            <span className="text-gray-400">Possible margin: <b className="text-gray-200">{fmt(margin)}</b></span>
            <span className="text-gray-400">Possible Live ROI: <b className={possible?.liveRoi >= 0 ? "text-green-400" : "text-red-400"}>{possible ? possible.liveRoi.toFixed(1) + "% p.a." : "…"}</b>
              <span className="text-gray-600"> (now {strategy.roi_pct ?? "—"}%)</span></span>
            {possible?.maxRoi != null && <span className="text-gray-400">Possible max ROI: <b className="text-green-400">{possible.maxRoi.toFixed(1)}% p.a.</b></span>}
          </div>

          <button onClick={sendToBuilder}
            className="px-3 py-1.5 bg-indigo-600 hover:bg-indigo-700 rounded font-medium">
            Looks good → send {trials.length} leg{trials.length !== 1 ? "s" : ""} to Strategy Builder ({(strategy.broker || "fyers").toUpperCase()})
          </button>
        </div>
      )}
    </div>
  );
}
