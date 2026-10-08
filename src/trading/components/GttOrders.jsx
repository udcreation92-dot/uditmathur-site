import { useState, useEffect, useCallback } from "react";
import { api } from "../api";
import { fyersToZerodha } from "../zerodhaSymbol";

function FyersGtt({ symbol }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const [side, setSide] = useState("SELL");
  const [productType, setProductType] = useState("CNC");
  const [price, setPrice] = useState(0);
  const [triggerPrice, setTriggerPrice] = useState(0);
  const [qty, setQty] = useState(1);
  const [oco, setOco] = useState(false);
  const [price2, setPrice2] = useState(0);
  const [triggerPrice2, setTriggerPrice2] = useState(0);
  const [qty2, setQty2] = useState(1);
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await api.listGtt();
      setOrders(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function place() {
    setPlacing(true); setPlaceError(null);
    try {
      await api.placeGtt({
        symbol: symbol.symbol,
        side,
        product_type: productType,
        leg1: { price: +price, trigger_price: +triggerPrice, quantity: +qty },
        leg2: oco ? { price: +price2, trigger_price: +triggerPrice2, quantity: +qty2 } : undefined,
      });
      setShowForm(false);
      load();
    } catch (err) {
      setPlaceError(err.message);
    } finally {
      setPlacing(false);
    }
  }

  async function cancel(orderId) {
    try {
      await api.cancelGtt(orderId);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-sm font-semibold text-gray-300">GTT Orders — {symbol.symbol}</h2>
          <button onClick={() => setShowForm(f => !f)}
            className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded font-medium">
            {showForm ? "Cancel" : "+ New GTT"}
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Good Till Triggered orders persist across days until the trigger price is hit — unlike regular DAY orders.
        </p>

        {showForm && (
          <div className="mt-4 space-y-3 bg-gray-800/50 rounded p-3">
            <div className="flex gap-2">
              {["BUY", "SELL"].map(s => (
                <button key={s} onClick={() => setSide(s)}
                  className={`flex-1 py-1.5 rounded text-xs font-semibold ${
                    side === s ? (s === "BUY" ? "bg-green-600 text-white" : "bg-red-600 text-white") : "bg-gray-700 text-gray-400"
                  }`}>
                  {s}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-gray-400 flex flex-col gap-1">
                Product
                <select value={productType} onChange={e => setProductType(e.target.value)} className="input-field">
                  <option value="CNC">CNC</option>
                  <option value="MARGIN">MARGIN</option>
                  <option value="MTF">MTF</option>
                </select>
              </label>
              <label className="text-xs text-gray-400 flex flex-col gap-1">
                Leg 1 Qty
                <input type="number" min={1} value={qty} onChange={e => setQty(e.target.value)} className="input-field" />
              </label>
              <label className="text-xs text-gray-400 flex flex-col gap-1">
                Leg 1 Price
                <input type="number" step="0.05" value={price} onChange={e => setPrice(e.target.value)} className="input-field" />
              </label>
              <label className="text-xs text-gray-400 flex flex-col gap-1">
                Leg 1 Trigger Price
                <input type="number" step="0.05" value={triggerPrice} onChange={e => setTriggerPrice(e.target.value)} className="input-field" />
              </label>
            </div>

            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input type="checkbox" checked={oco} onChange={e => setOco(e.target.checked)} />
              OCO (add a second leg — One Cancels Other)
            </label>

            {oco && (
              <div className="grid grid-cols-2 gap-2 pl-2 border-l-2 border-gray-700">
                <label className="text-xs text-gray-400 flex flex-col gap-1">
                  Leg 2 Qty
                  <input type="number" min={1} value={qty2} onChange={e => setQty2(e.target.value)} className="input-field" />
                </label>
                <label className="text-xs text-gray-400 flex flex-col gap-1">
                  Leg 2 Price
                  <input type="number" step="0.05" value={price2} onChange={e => setPrice2(e.target.value)} className="input-field" />
                </label>
                <label className="text-xs text-gray-400 flex flex-col gap-1 col-span-2">
                  Leg 2 Trigger Price
                  <input type="number" step="0.05" value={triggerPrice2} onChange={e => setTriggerPrice2(e.target.value)} className="input-field" />
                </label>
              </div>
            )}

            {placeError && <p className="text-red-400 text-xs">{placeError}</p>}

            <button onClick={place} disabled={placing}
              className="w-full py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded text-sm font-medium">
              {placing ? "Placing…" : "Place GTT Order"}
            </button>
          </div>
        )}
      </div>

      {loading ? <div className="text-gray-400 text-sm">Loading…</div> :
       error ? <p className="text-red-400 text-sm">{error}</p> :
       orders.length === 0 ? <p className="text-gray-500 text-sm">No GTT orders.</p> : (
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-2 px-2">Symbol</th>
                <th className="text-left px-2">Side</th>
                <th className="text-right px-2">Trigger</th>
                <th className="text-right px-2">Price</th>
                <th className="text-right px-2">Qty</th>
                <th className="text-left px-2">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o, i) => (
                <tr key={i} className="border-b border-gray-800/50">
                  <td className="py-1.5 px-2 text-gray-200">{o.symbol}</td>
                  <td className={o.side === 1 ? "text-green-400" : "text-red-400"}>{o.side === 1 ? "BUY" : "SELL"}</td>
                  <td className="text-right px-2 text-gray-300">{o.orderInfo?.leg1?.triggerPrice}</td>
                  <td className="text-right px-2 text-gray-300">{o.orderInfo?.leg1?.price}</td>
                  <td className="text-right px-2 text-gray-300">{o.orderInfo?.leg1?.qty}</td>
                  <td className="px-2 text-gray-400">{o.status}</td>
                  <td className="px-2">
                    <button onClick={() => cancel(o.id)}
                      className="text-[10px] px-2 py-1 bg-red-900/40 hover:bg-red-900/60 text-red-400 border border-red-800 rounded">
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ZerodhaGtt({ symbol }) {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showForm, setShowForm] = useState(false);

  const [side, setSide] = useState("SELL");
  const [product, setProduct] = useState("CNC");
  const [price, setPrice] = useState(0);
  const [triggerPrice, setTriggerPrice] = useState(0);
  const [qty, setQty] = useState(1);
  const [oco, setOco] = useState(false);
  const [price2, setPrice2] = useState(0);
  const [triggerPrice2, setTriggerPrice2] = useState(0);
  const [qty2, setQty2] = useState(1);
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const data = await api.zerodhaListGtt();
      setOrders(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function place() {
    setPlacing(true); setPlaceError(null);
    try {
      const { exchange, tradingsymbol } = fyersToZerodha(symbol.symbol);
      const quote = await api.getQuote(symbol.symbol);
      const lastPrice = quote?.d?.[0]?.v?.lp || 0;

      const triggerValues = oco ? [+triggerPrice, +triggerPrice2] : [+triggerPrice];
      const ordersPayload = oco
        ? [
            { transaction_type: side, quantity: +qty, price: +price },
            { transaction_type: side, quantity: +qty2, price: +price2 },
          ]
        : [{ transaction_type: side, quantity: +qty, price: +price }];

      await api.zerodhaPlaceGtt({
        trigger_type: oco ? "two-leg" : "single",
        exchange,
        tradingsymbol,
        last_price: lastPrice,
        trigger_values: triggerValues,
        orders: ordersPayload,
      });
      setShowForm(false);
      load();
    } catch (err) {
      setPlaceError(err.message);
    } finally {
      setPlacing(false);
    }
  }

  async function cancel(triggerId) {
    try {
      await api.zerodhaCancelGtt(triggerId);
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-sm font-semibold text-gray-300">GTT Orders (Zerodha) — {symbol.symbol}</h2>
          <button onClick={() => setShowForm(f => !f)}
            className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded font-medium">
            {showForm ? "Cancel" : "+ New GTT"}
          </button>
        </div>
        <p className="text-xs text-gray-500">
          Good Till Triggered orders persist across days until the trigger price is hit. Last price is pulled from
          the Fyers quote for this symbol (Zerodha market data isn't wired into this app).
        </p>

        {showForm && (
          <div className="mt-4 space-y-3 bg-gray-800/50 rounded p-3">
            <div className="flex gap-2">
              {["BUY", "SELL"].map(s => (
                <button key={s} onClick={() => setSide(s)}
                  className={`flex-1 py-1.5 rounded text-xs font-semibold ${
                    side === s ? (s === "BUY" ? "bg-green-600 text-white" : "bg-red-600 text-white") : "bg-gray-700 text-gray-400"
                  }`}>
                  {s}
                </button>
              ))}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="text-xs text-gray-400 flex flex-col gap-1">
                Product
                <select value={product} onChange={e => setProduct(e.target.value)} className="input-field">
                  <option value="CNC">CNC</option>
                  <option value="MIS">MIS</option>
                  <option value="NRML">NRML</option>
                </select>
              </label>
              <label className="text-xs text-gray-400 flex flex-col gap-1">
                Leg 1 Qty
                <input type="number" min={1} value={qty} onChange={e => setQty(e.target.value)} className="input-field" />
              </label>
              <label className="text-xs text-gray-400 flex flex-col gap-1">
                Leg 1 Price
                <input type="number" step="0.05" value={price} onChange={e => setPrice(e.target.value)} className="input-field" />
              </label>
              <label className="text-xs text-gray-400 flex flex-col gap-1">
                Leg 1 Trigger Price
                <input type="number" step="0.05" value={triggerPrice} onChange={e => setTriggerPrice(e.target.value)} className="input-field" />
              </label>
            </div>

            <label className="flex items-center gap-2 text-xs text-gray-400">
              <input type="checkbox" checked={oco} onChange={e => setOco(e.target.checked)} />
              OCO (two-leg — One Cancels Other)
            </label>

            {oco && (
              <div className="grid grid-cols-2 gap-2 pl-2 border-l-2 border-gray-700">
                <label className="text-xs text-gray-400 flex flex-col gap-1">
                  Leg 2 Qty
                  <input type="number" min={1} value={qty2} onChange={e => setQty2(e.target.value)} className="input-field" />
                </label>
                <label className="text-xs text-gray-400 flex flex-col gap-1">
                  Leg 2 Price
                  <input type="number" step="0.05" value={price2} onChange={e => setPrice2(e.target.value)} className="input-field" />
                </label>
                <label className="text-xs text-gray-400 flex flex-col gap-1 col-span-2">
                  Leg 2 Trigger Price
                  <input type="number" step="0.05" value={triggerPrice2} onChange={e => setTriggerPrice2(e.target.value)} className="input-field" />
                </label>
              </div>
            )}

            {placeError && <p className="text-red-400 text-xs">{placeError}</p>}

            <button onClick={place} disabled={placing}
              className="w-full py-2 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded text-sm font-medium">
              {placing ? "Placing…" : "Place GTT Order"}
            </button>
          </div>
        )}
      </div>

      {loading ? <div className="text-gray-400 text-sm">Loading…</div> :
       error ? <p className="text-red-400 text-sm">{error}</p> :
       orders.length === 0 ? <p className="text-gray-500 text-sm">No GTT orders.</p> : (
        <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b border-gray-800">
                <th className="text-left py-2 px-2">Symbol</th>
                <th className="text-left px-2">Side</th>
                <th className="text-right px-2">Trigger(s)</th>
                <th className="text-right px-2">Price</th>
                <th className="text-right px-2">Qty</th>
                <th className="text-left px-2">Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o, i) => (
                <tr key={i} className="border-b border-gray-800/50">
                  <td className="py-1.5 px-2 text-gray-200">{o.condition?.tradingsymbol}</td>
                  <td className={o.orders?.[0]?.transaction_type === "BUY" ? "text-green-400" : "text-red-400"}>
                    {o.orders?.[0]?.transaction_type}
                  </td>
                  <td className="text-right px-2 text-gray-300">{o.condition?.trigger_values?.join(", ")}</td>
                  <td className="text-right px-2 text-gray-300">{o.orders?.[0]?.price}</td>
                  <td className="text-right px-2 text-gray-300">{o.orders?.[0]?.quantity}</td>
                  <td className="px-2 text-gray-400">{o.status}</td>
                  <td className="px-2">
                    <button onClick={() => cancel(o.id)}
                      className="text-[10px] px-2 py-1 bg-red-900/40 hover:bg-red-900/60 text-red-400 border border-red-800 rounded">
                      Cancel
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function GttOrders({ symbol }) {
  const [broker, setBroker] = useState("fyers");
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400">Broker:</span>
        <div className="flex gap-2">
          {["fyers", "zerodha"].map(b => (
            <button key={b} onClick={() => setBroker(b)}
              className={`px-3 py-1 rounded text-xs font-semibold capitalize ${
                broker === b ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
              }`}>
              {b}
            </button>
          ))}
        </div>
      </div>
      {broker === "fyers" ? <FyersGtt symbol={symbol} /> : <ZerodhaGtt symbol={symbol} />}
    </div>
  );
}
