import { useState } from "react";
import { api } from "../api";
import MarketDepth from "./MarketDepth";
import { toZerodhaOrder } from "../zerodhaSymbol";

export default function OrderPanel({ symbol }) {
  const [broker, setBroker] = useState("fyers");
  const [form, setForm] = useState({
    side: "BUY",
    quantity: 1,
    order_type: "MKT",
    limit_price: 0,
    stop_price: "",
    product_type: "INTRADAY",
  });
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(false);

  function set(k, v) { setForm(p => ({ ...p, [k]: v })); }

  function fillPriceFromDepth(price) {
    setForm(p => ({
      ...p,
      order_type: p.order_type === "MKT" ? "LMT" : p.order_type,
      limit_price: price,
    }));
  }

  async function submit() {
    if (!confirm) { setConfirm(true); return; }
    setLoading(true); setError(null); setResult(null); setConfirm(false);
    try {
      const payload = {
        symbol: symbol.symbol,
        ...form,
        quantity: +form.quantity,
        limit_price: +form.limit_price,
        stop_price: form.stop_price ? +form.stop_price : 0,
      };
      const data = broker === "fyers"
        ? await api.placeOrder(payload)
        : await api.zerodhaPlaceOrder(toZerodhaOrder(payload));
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const needsLimit = form.order_type === "LMT" || form.order_type === "SL";
  const needsStop = form.order_type === "SL" || form.order_type === "SL-M";

  return (
    <div className="flex flex-wrap gap-4 items-start">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-5 w-full max-w-md">
        <h2 className="text-sm font-semibold text-gray-300 mb-4">
          Place Order — <span className="text-white">{symbol.symbol}</span>
        </h2>

        <div className="space-y-3">
          <Field label="Broker">
            <div className="flex gap-2">
              {["fyers", "zerodha"].map(b => (
                <button key={b} onClick={() => { setBroker(b); setResult(null); setConfirm(false); }}
                  className={`flex-1 py-1.5 rounded text-xs font-semibold capitalize ${
                    broker === b ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                  }`}>
                  {b}
                </button>
              ))}
            </div>
          </Field>

          {/* Buy / Sell */}
          <div className="flex gap-2">
            {["BUY","SELL"].map(val => (
              <button key={val} onClick={() => set("side", val)}
                className={`flex-1 py-2 rounded text-sm font-semibold transition-colors ${
                  form.side === val
                    ? val === "BUY" ? "bg-green-600 text-white" : "bg-red-600 text-white"
                    : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                }`}>
                {val}
              </button>
            ))}
          </div>

          <Field label="Product">
            <select value={form.product_type} onChange={e => set("product_type", e.target.value)}
              className="input-field">
              <option value="INTRADAY">Intraday</option>
              <option value="CNC">CNC / Delivery</option>
              <option value="MARGIN">Margin</option>
            </select>
          </Field>

          <Field label="Order Type">
            <select value={form.order_type} onChange={e => set("order_type", e.target.value)}
              className="input-field">
              <option value="MKT">Market</option>
              <option value="LMT">Limit</option>
              <option value="SL">Stop Loss Limit</option>
              <option value="SL-M">Stop Loss Market</option>
            </select>
          </Field>

          <Field label="Quantity">
            <input type="number" min={1} value={form.quantity}
              onChange={e => set("quantity", e.target.value)}
              className="input-field" />
          </Field>

          {needsLimit && (
            <Field label="Limit Price (₹)">
              <input type="number" step="0.05" value={form.limit_price}
                onChange={e => set("limit_price", e.target.value)}
                className="input-field" />
            </Field>
          )}

          {needsStop && (
            <Field label="Stop Price (₹)">
              <input type="number" step="0.05" value={form.stop_price}
                onChange={e => set("stop_price", e.target.value)}
                className="input-field" />
            </Field>
          )}

          {error && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-2">{error}</p>}
          {result && (
            <div className="bg-green-900/30 border border-green-700 rounded p-3 text-sm">
              <p className="text-green-400 font-medium">Order placed!</p>
              <p className="text-gray-300 text-xs mt-1">Order ID: {result.id || result.order_id}</p>
            </div>
          )}

          {confirm && (
            <div className="bg-yellow-900/30 border border-yellow-700 rounded p-3 text-sm">
              <p className="text-yellow-300 font-medium">Confirm: {form.side} {form.quantity} × {symbol.symbol} at {form.order_type}?</p>
            </div>
          )}

          <button onClick={submit} disabled={loading}
            className={`w-full py-2.5 rounded text-sm font-semibold transition-colors disabled:opacity-50 ${
              confirm ? "bg-yellow-600 hover:bg-yellow-700 text-white" :
              form.side === "BUY" ? "bg-green-600 hover:bg-green-700 text-white" : "bg-red-600 hover:bg-red-700 text-white"
            }`}>
            {loading ? "Placing…" : confirm ? "Confirm & Place Order" : "Place Order"}
          </button>
          {confirm && <button onClick={() => setConfirm(false)} className="w-full text-xs text-gray-400 hover:text-gray-200">Cancel</button>}
        </div>
      </div>

      <div className="w-full max-w-sm flex-1 min-w-[280px]">
        <MarketDepth symbol={symbol.symbol} onPriceClick={fillPriceFromDepth} />
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}
