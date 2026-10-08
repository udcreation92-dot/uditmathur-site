import { useState, useEffect } from "react";
import { api } from "../api";
import { toZerodhaOrder } from "../zerodhaSymbol";

export default function TBills() {
  const [bills, setBills] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [orderState, setOrderState] = useState({}); // symbol -> { qty, limitPrice, confirm, submitting, result, error }
  const [broker, setBroker] = useState("fyers"); // manual Buy button only — Auto-Buy Watch below is Fyers-only

  const [watches, setWatches] = useState([]); // active + stopped auto-buy watches
  const [watchLog, setWatchLog] = useState([]);
  const [watchLoading, setWatchLoading] = useState(false);
  const [watchError, setWatchError] = useState(null);
  const [targetRoi, setTargetRoi] = useState(6);
  const [budget, setBudget] = useState(10000);
  const [watchBroker, setWatchBroker] = useState("fyers");
  const MAX_WATCHES = 2;
  const activeWatches = watches.filter(w => w.active);

  const [traded, setTraded] = useState(null);      // market-traded yields (LTP-based, volume>0)
  const [tradedAt, setTradedAt] = useState(null);  // last refresh timestamp

  function loadTraded() {
    api.getTBillTradedYields()
      .then(rows => { setTraded(rows); setTradedAt(new Date()); })
      .catch(() => {});
  }

  function load() {
    setLoading(true); setError(null);
    api.getTBills()
      .then(setBills)
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }

  function loadWatch() {
    api.getTBillWatch()
      .then(({ watches, log }) => { setWatches(watches || []); setWatchLog(log || []); })
      .catch(() => {});
  }

  useEffect(() => {
    load();
    loadWatch();
    loadTraded();
    const interval = setInterval(loadWatch, 15000);
    const tradedInterval = setInterval(loadTraded, 5 * 60 * 1000); // market-traded yields refresh every 5 min
    return () => { clearInterval(interval); clearInterval(tradedInterval); };
  }, []);

  async function startWatch() {
    setWatchLoading(true); setWatchError(null);
    try {
      const { watches, log } = await api.startTBillWatch(+targetRoi, +budget, watchBroker);
      setWatches(watches || []); setWatchLog(log || []);
    } catch (err) {
      setWatchError(err.message);
    } finally {
      setWatchLoading(false);
    }
  }

  async function stopWatch(id) {
    setWatchLoading(true); setWatchError(null);
    try {
      const { watches, log } = await api.stopTBillWatch(id);
      setWatches(watches || []); setWatchLog(log || []);
    } catch (err) {
      setWatchError(err.message);
    } finally {
      setWatchLoading(false);
    }
  }

  function orderFor(bill) {
    return orderState[bill.symbol] || { qty: bill.lot_size, limitPrice: bill.ask, confirm: false, submitting: false, result: null, error: null };
  }

  function setOrder(bill, patch) {
    setOrderState(p => ({ ...p, [bill.symbol]: { ...orderFor(bill), ...patch } }));
  }

  async function buy(bill) {
    const o = orderFor(bill);
    if (!o.confirm) { setOrder(bill, { confirm: true }); return; }
    setOrder(bill, { submitting: true, error: null, confirm: false });
    try {
      const payload = {
        symbol: bill.symbol,
        side: "BUY",
        quantity: +o.qty,
        order_type: "LMT",
        limit_price: +o.limitPrice,
        stop_price: 0,
        product_type: "CNC",
      };
      const data = broker === "fyers"
        ? await api.placeOrder(payload)
        : broker === "shoonya"
          ? await api.shoonyaPlaceOrder(payload)
          : await api.zerodhaPlaceOrder(toZerodhaOrder(payload));
      api.recordTbillPurchase(bill.symbol).catch(() => {});
      // Also record a purchase LOT so repeated buys of the same instrument auto-tranche
      // (shared hook — any dashboard buy UI should call this after a successful holding buy).
      const bare = bill.symbol.includes(":") ? bill.symbol.split(":")[1] : bill.symbol;
      api.addHoldingLot(broker, bare, new Date().toISOString().slice(0, 10), +o.qty, +o.limitPrice).catch(() => {});
      setOrder(bill, { submitting: false, result: data });
    } catch (err) {
      setOrder(bill, { submitting: false, error: err.message });
    }
  }

  return (
    <div className="space-y-4">
      {/* Market-traded yields — what the market is ACTUALLY dealing at (LTP, volume>0), best first */}
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <div className="flex items-start justify-between gap-4 mb-2">
          <div>
            <h2 className="text-sm font-semibold text-gray-300 mb-1">Market-Traded Yields <span className="text-[10px] text-gray-500 font-normal">(LTP-based · traded today)</span></h2>
            <p className="text-xs text-gray-500">
              Effective ROI from each bill's LAST TRADED PRICE (volume &gt; 0), best yield first — where the market is actually dealing. Spot a bill that traded above your target that your order missed or caught late. ROI% = (100 − LTP) / LTP × (365 / days) × 100.
            </p>
          </div>
          <div className="text-right whitespace-nowrap">
            <button onClick={loadTraded} className="px-3 py-1.5 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded text-xs font-medium">Refresh</button>
            <p className="text-[10px] text-gray-600 mt-1">auto every 5 min{tradedAt ? ` · ${tradedAt.toLocaleTimeString()}` : ""}</p>
          </div>
        </div>
        {traded == null ? (
          <p className="text-gray-500 text-sm">Loading traded yields…</p>
        ) : traded.length === 0 ? (
          <p className="text-gray-500 text-sm">No T-Bills have traded yet today (no volume).</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead><tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-1.5 font-normal">T-Bill</th>
                <th className="text-right px-2 font-normal">Maturity</th>
                <th className="text-right px-2 font-normal">Days</th>
                <th className="text-right px-2 font-normal">LTP</th>
                <th className="text-right px-2 font-normal">ROI p.a.</th>
                <th className="text-right px-2 font-normal">Volume</th>
              </tr></thead>
              <tbody>
                {traded.map(r => (
                  <tr key={r.symbol} className="border-b border-gray-800/50 hover:bg-gray-800/40">
                    <td className="py-1.5 text-gray-200 font-medium">{r.symbol.replace("NSE:", "").replace("-TB", "")}</td>
                    <td className="text-right px-2 text-gray-400">{r.maturity_date}</td>
                    <td className="text-right px-2 text-gray-500">{r.days_to_maturity}</td>
                    <td className="text-right px-2 text-gray-300 tabular-nums">₹{r.ltp}</td>
                    <td className="text-right px-2 text-green-400 font-semibold tabular-nums">{r.roi_pct}%</td>
                    <td className="text-right px-2 text-gray-300 tabular-nums">{r.volume.toLocaleString("en-IN")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-300 mb-1">GOI T-Bills — ROI Scanner</h2>
            <p className="text-xs text-gray-500">
              Live ask prices for all NSE-traded Treasury Bills, ranked by annualized ROI (best to worst).
              ROI% = (100 − ask) / ask × (365 / days to maturity) × 100 — T-Bills are zero-coupon, bought at a discount and redeemed at ₹100 face value.
            </p>
          </div>
          <button onClick={load} disabled={loading}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium whitespace-nowrap">
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
        {error && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-2 mt-3">{error}</p>}
        <div className="flex items-center gap-3 mt-3">
          <span className="text-xs text-gray-400">Buy via:</span>
          <div className="flex gap-2">
            {["fyers", "zerodha", "shoonya"].map(b => (
              <button key={b} onClick={() => setBroker(b)}
                className={`px-3 py-1 rounded text-xs font-semibold capitalize ${
                  broker === b ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}>
                {b}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-1">Auto-Buy Watch <span className="text-[10px] text-gray-500 font-normal">(up to {MAX_WATCHES} independent watches)</span></h2>
        <p className="text-xs text-gray-500 mb-3">
          Runs continuously on the backend (independent of this browser tab). Every T-Bill ask tick wakes the check instantly
          (plus a 5s safety poll), so a fleeting high-yield ask is caught in ~sub-second. Whenever a bill clears a watch's target
          ROI, it buys as much as the live ask liquidity allows, up to that watch's budget. Run two watches with different targets
          and brokers side by side. Real orders are placed automatically once started, with no per-order confirmation.
        </p>

        {/* Active watches */}
        {activeWatches.length > 0 && (
          <div className="space-y-2 mb-4">
            {activeWatches.map((w, i) => (
              <div key={w.id} className="flex flex-wrap items-center gap-4 text-sm bg-gray-800/40 border border-gray-800 rounded p-3">
                <span className="text-[11px] font-semibold text-gray-500">#{i + 1}</span>
                <span className="text-gray-400">Target ROI: <span className="text-green-400 font-semibold">{w.target_roi}%</span></span>
                <span className="text-gray-400">Budget: <span className="text-gray-200 font-semibold">₹{w.budget_remaining.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span> of ₹{w.budget_total.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                <span className="text-gray-400">Broker: <span className="text-blue-400 font-semibold capitalize">{w.broker || "fyers"}</span></span>
                <button onClick={() => stopWatch(w.id)} disabled={watchLoading}
                  className="ml-auto px-4 py-1.5 bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded text-xs font-semibold">
                  {watchLoading ? "…" : "Stop"}
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Start a new watch (until the cap is reached) */}
        {activeWatches.length < MAX_WATCHES ? (
          <div className="flex flex-wrap gap-4 items-end">
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              ROI Required % (p.a.)
              <input type="number" min={0} step={0.1} value={targetRoi} onChange={e => setTargetRoi(e.target.value)}
                className="input-field w-32" />
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Amount to Buy (₹)
              <input type="number" min={1} step={100} value={budget} onChange={e => setBudget(e.target.value)}
                className="input-field w-36" />
            </label>
            <div className="flex flex-col gap-1 text-xs text-gray-400">
              Buy via
              <div className="flex gap-2">
                {["fyers", "zerodha", "shoonya"].map(b => (
                  <button key={b} type="button" onClick={() => setWatchBroker(b)}
                    className={`px-3 py-1.5 rounded text-xs font-semibold capitalize ${
                      watchBroker === b ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                    }`}>
                    {b}
                  </button>
                ))}
              </div>
            </div>
            <button onClick={startWatch} disabled={watchLoading}
              className="px-6 py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded text-sm font-semibold">
              {watchLoading ? "Starting…" : activeWatches.length > 0 ? "Add Watch" : "Start Watching"}
            </button>
          </div>
        ) : (
          <p className="text-xs text-gray-500">Maximum of {MAX_WATCHES} auto-buys running. Stop one to add another.</p>
        )}
        {watchError && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-2 mt-3">{watchError}</p>}

        {watchLog.length > 0 && (
          <div className="mt-4">
            <h3 className="text-xs font-semibold text-gray-400 mb-2">Recent auto-buy activity</h3>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left py-1 px-2">Time</th>
                  <th className="text-left px-2">Symbol</th>
                  <th className="text-right px-2">Qty</th>
                  <th className="text-right px-2">Price</th>
                  <th className="text-right px-2">Cost</th>
                  <th className="text-left px-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {watchLog.map(l => {
                  const isSkip = l.status === "skipped";
                  return (
                    <tr key={l.id} className="border-b border-gray-800/50">
                      <td className="py-1 px-2 text-gray-500 whitespace-nowrap">{new Date(l.created_at + "Z").toLocaleString()}</td>
                      <td className="px-2 text-gray-300 whitespace-nowrap">{l.symbol.replace("NSE:", "")}</td>
                      <td className="text-right px-2 text-gray-300">{isSkip ? "—" : l.qty}</td>
                      <td className="text-right px-2 text-gray-300">{isSkip ? "—" : `₹${l.price}`}</td>
                      <td className="text-right px-2 text-gray-300">{isSkip ? "—" : `₹${l.cost.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}</td>
                      <td className="px-2">
                        {l.status === "traded"
                          ? <span className="text-green-400">✓ Traded{l.filled_qty ? ` ${l.filled_qty}` : ""}{l.avg_price ? ` @ ₹${l.avg_price}` : ""} <span className="text-gray-600">· {l.order_id}</span></span>
                          : l.status === "placed"
                            ? <span className="text-yellow-300" title="Order accepted by the broker — waiting to fill">⏳ Placed, awaiting fill <span className="text-gray-600">· {l.order_id}</span></span>
                            : l.status === "cancelled"
                              ? <span className="text-gray-400">✕ Cancelled <span className="text-gray-600">· {l.order_id}</span></span>
                              : l.status === "rejected"
                                ? <span className="text-red-400">✕ Rejected{l.message ? ` — ${l.message}` : ""}</span>
                                : isSkip
                                  ? <span className="text-yellow-500/90">Skipped — {l.message}</span>
                                  : <span className="text-red-400">{l.message}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {bills && (
        bills.length === 0 ? (
          <p className="text-gray-500 text-sm">No live-quoted T-Bills found right now.</p>
        ) : (
          <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left py-2 px-2">Symbol</th>
                  <th className="text-right px-2">Tenor</th>
                  <th className="text-right px-2">Maturity</th>
                  <th className="text-right px-2">Days Left</th>
                  <th className="text-right px-2">Ask</th>
                  <th className="text-right px-2">Ask Qty</th>
                  <th className="text-right px-2">ROI % p.a.</th>
                  <th className="text-right px-2">Qty</th>
                  <th className="px-2"></th>
                </tr>
              </thead>
              <tbody>
                {bills.map(b => {
                  const o = orderFor(b);
                  return (
                    <tr key={b.symbol} className="border-b border-gray-800/50 hover:bg-gray-800/40 align-top">
                      <td className="py-1.5 px-2 text-gray-300 whitespace-nowrap">{b.symbol.replace("NSE:", "")}</td>
                      <td className="text-right px-2 text-gray-400">{b.tenor_days}D</td>
                      <td className="text-right px-2 text-gray-400">{b.maturity_date}</td>
                      <td className="text-right px-2 text-gray-400">{b.days_to_maturity}</td>
                      <td className="text-right px-2 text-gray-200 font-medium">₹{b.ask}</td>
                      <td className="text-right px-2 text-gray-400">{b.ask_qty != null ? b.ask_qty.toLocaleString() : "—"}</td>
                      <td className="text-right px-2 font-semibold text-green-400">{b.roi_pct}%</td>
                      <td className="text-right px-2">
                        <input type="number" min={b.lot_size} step={b.lot_size} value={o.qty}
                          onChange={e => setOrder(b, { qty: e.target.value, confirm: false, result: null })}
                          className="input-field w-20 text-right py-1" />
                      </td>
                      <td className="px-2 whitespace-nowrap">
                        <button onClick={() => buy(b)} disabled={o.submitting}
                          className={`text-[10px] px-2 py-1 rounded font-medium whitespace-nowrap disabled:opacity-50 ${
                            o.confirm ? "bg-yellow-600 hover:bg-yellow-700" : "bg-green-600 hover:bg-green-700"
                          }`}>
                          {o.submitting ? "Placing…" : o.confirm ? "Confirm Buy" : "Buy"}
                        </button>
                        {o.result && <p className="text-green-400 mt-1">Order {o.result.id || o.result.order_id}</p>}
                        {o.error && <p className="text-red-400 mt-1 max-w-[140px]">{o.error}</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-[10px] text-gray-600 p-2">
              Buy orders are placed as CNC limit orders at the entered price (defaults to live ask). Quantity must be a multiple of the lot size (face value ₹100/unit).
            </p>
          </div>
        )
      )}
    </div>
  );
}
