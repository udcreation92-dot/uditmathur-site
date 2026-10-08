import { useState, useEffect, useRef } from "react";
import { api } from "../api";

export default function VolatilityScanner({ onSelect }) {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  function poll() {
    api.getFoVolatilityStatus()
      .then(s => {
        setStatus(s);
        if (!s.running && pollRef.current) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      })
      .catch(() => {});
  }

  useEffect(() => {
    poll();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function scan() {
    setError(null);
    try {
      const s = await api.startFoVolatilityScan();
      setStatus(s);
      if (!pollRef.current) pollRef.current = setInterval(poll, 2000);
    } catch (err) {
      setError(err.message);
    }
  }

  const data = status?.data;
  const running = status?.running;
  // Map last scan's volatility ratio by symbol so each current row can show its change.
  const prevRatio = {};
  (status?.previous || []).forEach(r => { prevRatio[r.symbol] = r.volatility_ratio; });
  const hasPrev = (status?.previous || []).length > 0;

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <h2 className="text-sm font-semibold text-gray-300 mb-1">F&amp;O Volatility Scanner</h2>
        <p className="text-xs text-gray-500 mb-4">
          Ranks every F&amp;O underlying (~200 stocks + indices) by how much of its option OI, on the nearest expiry,
          sits in-the-money — a proxy for how far/fast the underlying has already moved through its option chain.
          For each side: ITM OI ratio = (OI at strikes ITM) / (total OI on that side) — CE is ITM below spot, PE is ITM
          above spot. Volatility Ratio = max of the CE and PE ratios. Runs in the background — Fyers rate-limits
          option-chain well below what a fast scan would need, so this is paced and takes a few minutes.
        </p>
        <div className="flex flex-wrap gap-4 items-center">
          <button onClick={scan} disabled={running}
            className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium">
            {running ? `Scanning… (${status.done}/${status.total})` : "Scan"}
          </button>
          {status?.finished_at && !running && (
            <span className="text-xs text-gray-500">
              As of {new Date(status.finished_at * 1000).toLocaleTimeString()}
              {hasPrev && status?.previous_finished_at && (
                <> · Δ vs last scan at {new Date(status.previous_finished_at * 1000).toLocaleTimeString()}</>
              )}
            </span>
          )}
        </div>
        {error && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-2 mt-3">{error}</p>}
        {status?.error && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-2 mt-3">{status.error}</p>}
      </div>

      {data && (
        data.length === 0 ? (
          <p className="text-gray-500 text-sm">No underlyings returned live option chain data.</p>
        ) : (
          <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left py-2 px-2">Symbol</th>
                  <th className="text-right px-2">Spot</th>
                  <th className="text-right px-2">Expiry</th>
                  <th className="text-right px-2">CE ITM OI %</th>
                  <th className="text-right px-2">PE ITM OI %</th>
                  <th className="text-right px-2">Volatility Ratio</th>
                  {hasPrev && <th className="text-right px-2">Δ vs last</th>}
                </tr>
              </thead>
              <tbody>
                {data.map((r, i) => {
                  const prev = prevRatio[r.symbol];
                  const delta = prev != null ? +(r.volatility_ratio - prev).toFixed(2) : null;
                  return (
                    <tr key={r.symbol}
                      onClick={() => onSelect?.({ symbol: r.symbol, name: r.root })}
                      title="Select — loads its option chain"
                      className="border-b border-gray-800/50 hover:bg-gray-800/40 cursor-pointer">
                      <td className="py-1.5 px-2 text-blue-400 font-medium whitespace-nowrap hover:underline">
                        {i + 1}. {r.root}{r.is_index ? " (index)" : ""}
                      </td>
                      <td className="text-right px-2 text-gray-300">{r.spot}</td>
                      <td className="text-right px-2 text-gray-400">{r.expiry_date}</td>
                      <td className="text-right px-2 text-gray-300">{r.ce_ratio}%</td>
                      <td className="text-right px-2 text-gray-300">{r.pe_ratio}%</td>
                      <td className="text-right px-2 font-semibold text-green-400">{r.volatility_ratio}%</td>
                      {hasPrev && (
                        delta == null ? (
                          <td className="text-right px-2 text-gray-600" title="Not in last scan">new</td>
                        ) : delta === 0 ? (
                          <td className="text-right px-2 text-gray-500">0.00</td>
                        ) : (
                          <td className={`text-right px-2 font-medium ${delta > 0 ? "text-amber-400" : "text-sky-400"}`}
                            title={`Last scan: ${prev}%`}>
                            {delta > 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(2)}
                          </td>
                        )
                      )}
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
