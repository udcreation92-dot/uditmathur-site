import { useState, useEffect } from "react";
import { api } from "../api";
import MarketDepth from "./MarketDepth";

// Fyers symbol for market-data lookups (Zerodha legs are stored bare, Fyers/Shoonya with "NSE:").
function legFyersSymbol(sym) {
  return sym.includes(":") ? sym : `NSE:${sym}`;
}

const brokerLabel = (b) => (b || "fyers").charAt(0).toUpperCase() + (b || "fyers").slice(1);

// Manual limit-price entry — for a price not on the visible depth ladder yet (e.g. placing ahead
// of the market). Mirrors the depth's onPriceClick so the downstream confirm step is identical.
function ManualPriceRow({ onSet }) {
  const [v, setV] = useState("");
  const ok = +v > 0;
  const submit = () => { if (ok) onSet(+v); };
  return (
    <div className="flex items-center gap-2 mt-2">
      <span className="text-[11px] text-gray-500">Or type a price:</span>
      <input type="number" step="0.05" min="0" value={v} onChange={e => setV(e.target.value)}
        onKeyDown={e => e.key === "Enter" && submit()} placeholder="e.g. 47.25"
        className="w-24 text-right bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-gray-100" />
      <button onClick={submit} disabled={!ok}
        className="px-2 py-0.5 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 rounded text-gray-200">Use price</button>
      <span className="text-[10px] text-gray-600">for a limit not on the ladder yet</span>
    </div>
  );
}

// ---- Exit a leg: pick a price off the depth ladder, confirm, place the OFFSETTING order into
// the same strategy. On fill it nets the position down and books realized P&L automatically —
// an exit is just an opposite order in the money-pot model. ----
export function ExitLegPanel({ strategy, leg, onDone, onCancel }) {
  const lot = leg.lot_size > 1 ? leg.lot_size : 1;
  const openQty = leg.qty;  // merged net open qty
  const maxLots = Math.max(1, Math.round(openQty / lot));
  const [lots, setLots] = useState(maxLots);
  const [pending, setPending] = useState(null); // { price }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const exitSide = leg.side === "BUY" ? "SELL" : "BUY";
  const qty = Math.min(lots * lot, openQty);

  async function confirmExit() {
    setBusy(true); setError(null);
    try {
      const r = await api.addLeg({
        strategy_id: strategy.id, symbol: leg.symbol, side: exitSide,
        qty, price: pending.price, broker: leg.broker || "fyers",
      });
      setResult(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="bg-green-900/20 border border-green-800 rounded p-2 text-xs">
        <p className="text-green-400 font-medium">Exit order placed: {exitSide} {qty} @ ₹{pending?.price} (order {result.order_id}) — <span className="text-yellow-300">pending</span>.</p>
        <p className="text-gray-400 mt-1">When it fills it nets this leg down and books the realized P&L into the strategy automatically.</p>
        <button onClick={onDone} className="mt-1.5 text-[11px] px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded">Done</button>
      </div>
    );
  }

  return (
    <div className="bg-gray-900/70 border border-gray-700 rounded p-3 text-xs">
      <div className="flex items-center justify-between mb-2">
        <span className="text-gray-300 font-medium">
          Exit leg — will place a <span className={exitSide === "BUY" ? "text-green-400" : "text-red-400"}>{exitSide}</span> limit order on {brokerLabel(leg.broker)}
        </span>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-300">Cancel</button>
      </div>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-gray-500">Lots (×{lot}):</span>
        <button onClick={() => setLots(l => Math.max(1, l - 1))} className="w-6 bg-gray-700 hover:bg-gray-600 rounded">−</button>
        <input type="number" min={1} max={maxLots} value={lots}
          onChange={e => setLots(Math.max(1, Math.min(maxLots, +e.target.value || 1)))}
          className="w-14 text-center bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-gray-100" />
        <button onClick={() => setLots(l => Math.min(maxLots, l + 1))} className="w-6 bg-gray-700 hover:bg-gray-600 rounded">+</button>
        <span className="text-gray-500">= {qty} qty (open {openQty})</span>
      </div>
      <p className="text-[11px] text-gray-500 mb-2">Click a price in the depth to place the exit at that limit, or type one below.</p>
      <MarketDepth symbol={legFyersSymbol(leg.symbol)} onPriceClick={(price) => setPending({ price })} />
      <ManualPriceRow onSet={(price) => setPending({ price })} />
      {pending && (
        <div className="bg-yellow-900/20 border border-yellow-800 rounded p-2 mt-2">
          <p className="text-yellow-300 font-medium">
            Confirm: place <span className={exitSide === "BUY" ? "text-green-400" : "text-red-400"}>{exitSide} {qty}</span> @ ₹{pending.price} on {brokerLabel(leg.broker)}?
          </p>
          <div className="flex gap-2 mt-1.5">
            <button onClick={confirmExit} disabled={busy}
              className="px-3 py-1 bg-yellow-600 hover:bg-yellow-700 disabled:opacity-50 rounded font-semibold">
              {busy ? "Placing…" : "Confirm exit"}
            </button>
            <button onClick={() => setPending(null)} className="text-gray-400 hover:text-gray-200 px-2">Back</button>
          </div>
        </div>
      )}
      {error && <p className="text-red-400 mt-2">{error}</p>}
    </div>
  );
}

// ---- Record realized P&L on an exited leg (app exit or direct broker exit) ----
export function RecordRealizedForm({ leg, onDone, onCancel }) {
  const lot = leg.lot_size > 1 ? leg.lot_size : 1;
  const openLots = Math.max(1, Math.round(leg.open_qty / lot));
  const [lots, setLots] = useState(openLots);
  const qty = Math.min(lots * lot, leg.open_qty);

  // Default realized from entry vs current LTP (editable — the user confirms the real number,
  // since a broker-side exit's exact fill price isn't known to the app).
  const est = (() => {
    if (leg.entry == null || leg.ltp == null) return 0;
    const per = leg.side === "SELL" ? leg.entry - leg.ltp : leg.ltp - leg.entry;
    return Math.round(per * qty * 100) / 100;
  })();
  const [realized, setRealized] = useState(est);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setBusy(true); setError(null);
    try {
      await api.bookRealized(leg.id, qty, +realized);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="bg-gray-900/70 border border-gray-700 rounded p-3 text-xs space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-gray-300 font-medium">Record realized P&L (books it & closes this qty in tracking)</span>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-300">Cancel</button>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-gray-500">Closed lots (×{lot}):</span>
        <input type="number" min={1} max={openLots} value={lots}
          onChange={e => setLots(Math.max(1, Math.min(openLots, +e.target.value || 1)))}
          className="w-14 text-center bg-gray-800 border border-gray-700 rounded px-1 py-0.5 text-gray-100" />
        <span className="text-gray-500">= {qty} qty</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="text-gray-500">Realized P&L (₹):</span>
        <input type="number" step="0.01" value={realized}
          onChange={e => setRealized(e.target.value)}
          className="w-28 text-right bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-gray-100" />
        <span className="text-[10px] text-gray-600">est. from entry vs LTP — edit to the actual figure</span>
      </div>
      <div className="flex gap-2">
        <button onClick={submit} disabled={busy}
          className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded font-semibold">
          {busy ? "Saving…" : "Book & close"}
        </button>
      </div>
      {error && <p className="text-red-400">{error}</p>}
    </div>
  );
}

// ---- Add a new leg to a strategy: mini option chain -> depth -> Buy/Sell -> confirm -> order ----
export function AddLegPanel({ strategy, onDone, onCancel }) {
  const [chain, setChain] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null); // { symbol, ltp, lot_size, label }
  const [pending, setPending] = useState(null);    // { price, side }
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (!strategy.underlying_symbol) { setError("No underlying symbol for this strategy."); return; }
    api.getOptionChain(strategy.underlying_symbol, 12, "")
      .then(r => setChain(r.data))
      .catch(e => setError(e.message));
  }, [strategy.underlying_symbol]);

  async function confirmAdd() {
    setBusy(true); setError(null);
    try {
      const r = await api.addLeg({
        strategy_id: strategy.id, symbol: selected.symbol, side: pending.side,
        qty: selected.lot_size || 1, price: pending.price, broker: strategy.broker || "fyers",
      });
      setResult(r);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <div className="bg-green-900/20 border border-green-800 rounded p-2 text-xs">
        <p className="text-green-400 font-medium">Order placed (order {result.order_id}) — <span className="text-yellow-300">pending</span>.</p>
        <p className="text-gray-400 mt-1">It's <span className="text-gray-200">not counted as a leg yet</span>. As soon as it fills at the broker, it's added to the strategy automatically. Until then it shows as a pending order below.</p>
        <button onClick={onDone} className="mt-1.5 text-[11px] px-2 py-1 bg-gray-700 hover:bg-gray-600 rounded">Done</button>
      </div>
    );
  }

  const underlying = chain?.optionsChain?.find(o => o.option_type === "");
  const byStrike = {};
  for (const row of (chain?.optionsChain || [])) {
    if (row.option_type) (byStrike[row.strike_price] ??= {})[row.option_type] = row;
  }
  const strikes = Object.keys(byStrike).map(Number).sort((a, b) => a - b);
  const atm = underlying ? strikes.reduce((p, c) => Math.abs(c - underlying.ltp) < Math.abs(p - underlying.ltp) ? c : p, strikes[0]) : null;

  return (
    <div className="bg-gray-900/70 border border-gray-700 rounded p-3 text-xs">
      <div className="flex items-center justify-between mb-2">
        <span className="text-gray-300 font-medium">Add a leg to “{strategy.name}” — on {brokerLabel(strategy.broker)}</span>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-300">Cancel</button>
      </div>
      {error && <p className="text-red-400 mb-2">{error}</p>}

      {!selected && (
        chain ? (
          <div className="max-h-64 overflow-y-auto border border-gray-800 rounded">
            <table className="w-full text-[12px]">
              <thead className="text-gray-500 sticky top-0 bg-gray-900">
                <tr><th className="py-1 text-right px-3">Call LTP</th><th className="py-1 text-center">Strike</th><th className="py-1 text-left px-3">Put LTP</th></tr>
              </thead>
              <tbody>
                {strikes.map(s => {
                  const ce = byStrike[s].CE, pe = byStrike[s].PE;
                  return (
                    <tr key={s} className={`border-t border-gray-800/50 ${s === atm ? "bg-blue-900/15" : ""}`}>
                      <td className="text-right px-3 py-1.5">
                        {ce ? <button onClick={() => setSelected({ symbol: ce.symbol, ltp: ce.ltp, lot_size: ce.lot_size, label: `${s} CALL` })}
                          className="text-green-300 hover:underline">{ce.ltp?.toFixed(2)}</button> : "-"}
                      </td>
                      <td className="text-center py-1.5 text-gray-300 font-medium">{s}</td>
                      <td className="text-left px-3 py-1.5">
                        {pe ? <button onClick={() => setSelected({ symbol: pe.symbol, ltp: pe.ltp, lot_size: pe.lot_size, label: `${s} PUT` })}
                          className="text-pink-300 hover:underline">{pe.ltp?.toFixed(2)}</button> : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="text-gray-500">Loading option chain…</p>
      )}

      {selected && (
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-gray-300">Selected: <span className="font-medium text-gray-100">{selected.label}</span> · 1 lot = {selected.lot_size} qty</span>
            <button onClick={() => { setSelected(null); setPending(null); }} className="text-gray-500 hover:text-gray-300">Change strike</button>
          </div>
          <p className="text-[11px] text-gray-500 mb-2">Click a price in the depth, or type one below, then choose Buy or Sell.</p>
          <MarketDepth symbol={selected.symbol} onPriceClick={(price) => setPending({ price, side: null })} />
          <ManualPriceRow onSet={(price) => setPending({ price, side: null })} />
          {pending && (
            <div className="bg-gray-800/60 border border-gray-700 rounded p-2 mt-2">
              {!pending.side ? (
                <div className="flex items-center gap-2">
                  <span className="text-gray-400">At ₹{pending.price} —</span>
                  <button onClick={() => setPending(p => ({ ...p, side: "BUY" }))} className="px-3 py-1 bg-green-600 hover:bg-green-700 rounded font-semibold">Buy</button>
                  <button onClick={() => setPending(p => ({ ...p, side: "SELL" }))} className="px-3 py-1 bg-red-600 hover:bg-red-700 rounded font-semibold">Sell</button>
                  <button onClick={() => setPending(null)} className="text-gray-400 hover:text-gray-200 px-2">Back</button>
                </div>
              ) : (
                <div>
                  <p className="text-yellow-300 font-medium">
                    Confirm: <span className={pending.side === "BUY" ? "text-green-400" : "text-red-400"}>{pending.side} {selected.lot_size}</span> {selected.label} @ ₹{pending.price} on {brokerLabel(strategy.broker)}?
                  </p>
                  <div className="flex gap-2 mt-1.5">
                    <button onClick={confirmAdd} disabled={busy}
                      className="px-3 py-1 bg-yellow-600 hover:bg-yellow-700 disabled:opacity-50 rounded font-semibold">
                      {busy ? "Placing…" : "Confirm order"}
                    </button>
                    <button onClick={() => setPending(p => ({ ...p, side: null }))} className="text-gray-400 hover:text-gray-200 px-2">Back</button>
                  </div>
                </div>
              )}
            </div>
          )}
          {error && <p className="text-red-400 mt-2">{error}</p>}
        </div>
      )}
    </div>
  );
}
