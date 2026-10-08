import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

const REFRESH_OPTIONS = [1000, 2000, 5000, 10000];

export default function MarketDepth({ symbol, onPriceClick }) {
  const [depth, setDepth] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [live, setLive] = useState(true);
  const [refreshMs, setRefreshMs] = useState(2000);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await api.getDepth(symbol);
      setDepth(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useEffect(() => {
    if (!live) return;
    const interval = setInterval(load, refreshMs);
    return () => clearInterval(interval);
  }, [live, refreshMs, load]);

  if (loading && !depth) return <div className="text-gray-500 text-xs p-3">Loading depth…</div>;
  if (error) return <p className="text-red-400 text-xs bg-red-900/20 border border-red-800 rounded p-2">{error}</p>;
  if (!depth) return null;

  const bids = depth.bids || [];
  const asks = depth.ask || [];
  const maxQty = Math.max(1, ...bids.map(b => b.volume), ...asks.map(a => a.volume));

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex justify-between items-center mb-3">
        <h3 className="text-sm font-semibold text-gray-300">Market Depth (DOM)</h3>
        <div className="flex gap-2 items-center">
          <select value={refreshMs} onChange={e => setRefreshMs(+e.target.value)}
            className="bg-gray-800 border border-gray-700 rounded px-1.5 py-0.5 text-gray-300 text-[10px]">
            {REFRESH_OPTIONS.map(ms => <option key={ms} value={ms}>{ms / 1000}s</option>)}
          </select>
          <button onClick={() => setLive(l => !l)}
            className={`text-[10px] px-2 py-0.5 rounded flex items-center gap-1 font-medium ${
              live ? "bg-green-900/40 text-green-400 border border-green-700" : "bg-gray-800 text-gray-400 border border-gray-700"
            }`}>
            <span className={`w-1 h-1 rounded-full ${live ? "bg-green-400 animate-pulse" : "bg-gray-500"}`} />
            {live ? "Live" : "Paused"}
          </button>
        </div>
      </div>

      <div className="flex justify-between text-xs text-gray-500 mb-3 pb-2 border-b border-gray-800">
        <span>Buy Qty: <span className="text-green-400">{depth.totalbuyqty?.toLocaleString()}</span></span>
        <span>LTP: <span className="text-gray-200 font-medium">{depth.ltp}</span></span>
        <span>Sell Qty: <span className="text-red-400">{depth.totalsellqty?.toLocaleString()}</span></span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="grid grid-cols-2 text-[10px] text-gray-500 mb-1 px-1">
            <span>Qty</span>
            <span className="text-right">Bid</span>
          </div>
          {bids.slice(0, 5).map((b, i) => (
            <button
              key={i}
              onClick={() => onPriceClick?.(b.price)}
              className="relative w-full grid grid-cols-2 text-xs py-1 px-1 rounded hover:bg-gray-800 group"
            >
              <div
                className="absolute inset-y-0 right-0 bg-green-500/10 group-hover:bg-green-500/20"
                style={{ width: `${(b.volume / maxQty) * 100}%` }}
              />
              <span className="relative text-gray-400">{b.volume?.toLocaleString()}</span>
              <span className="relative text-right text-green-400 font-medium">{b.price}</span>
            </button>
          ))}
        </div>

        <div>
          <div className="grid grid-cols-2 text-[10px] text-gray-500 mb-1 px-1">
            <span>Ask</span>
            <span className="text-right">Qty</span>
          </div>
          {asks.slice(0, 5).map((a, i) => (
            <button
              key={i}
              onClick={() => onPriceClick?.(a.price)}
              className="relative w-full grid grid-cols-2 text-xs py-1 px-1 rounded hover:bg-gray-800 group"
            >
              <div
                className="absolute inset-y-0 left-0 bg-red-500/10 group-hover:bg-red-500/20"
                style={{ width: `${(a.volume / maxQty) * 100}%` }}
              />
              <span className="relative text-red-400 font-medium">{a.price}</span>
              <span className="relative text-right text-gray-400">{a.volume?.toLocaleString()}</span>
            </button>
          ))}
        </div>
      </div>

      {(depth.o != null) && (
        <div className="grid grid-cols-4 gap-2 mt-3 pt-2 border-t border-gray-800 text-[11px] text-gray-500">
          <span>O: <span className="text-gray-300">{depth.o}</span></span>
          <span>H: <span className="text-gray-300">{depth.h}</span></span>
          <span>L: <span className="text-gray-300">{depth.l}</span></span>
          <span>C: <span className="text-gray-300">{depth.c}</span></span>
        </div>
      )}

      <p className="text-[10px] text-gray-600 mt-2">Click a price to fill it into the order form.</p>
    </div>
  );
}
