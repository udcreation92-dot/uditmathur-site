import { useState, useEffect } from "react";
import { api } from "../api";

const SIGNAL_COLOR = { BUY: "text-green-400", SELL: "text-red-400", HOLD: "text-yellow-400" };
const SIGNAL_BG = { BUY: "bg-green-900/40 border-green-700", SELL: "bg-red-900/40 border-red-700", HOLD: "bg-yellow-900/30 border-yellow-700" };

export default function AnalysisPanel({ symbol }) {
  const [modules, setModules] = useState([]);
  const [enabled, setEnabled] = useState({});
  const [resolution, setResolution] = useState("5");
  const [days, setDays] = useState(10);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.listModules().then(mods => {
      setModules(mods);
      setEnabled(Object.fromEntries(mods.map(m => [m.id, true])));
    }).catch(() => {});
  }, []);

  async function run() {
    setLoading(true); setError(null); setResult(null);
    try {
      const activeModules = Object.keys(enabled).filter(k => enabled[k]);
      const data = await api.runAnalysis({
        symbol: symbol.symbol,
        resolution,
        days,
        modules: activeModules,
      });
      setResult(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      {/* Config */}
      <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
        <h2 className="text-sm font-semibold text-gray-300 mb-3">Configuration</h2>
        <div className="flex flex-wrap gap-4 items-end">
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            Candle interval (min)
            <select value={resolution} onChange={e => setResolution(e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200 text-sm">
              {["1", "3", "5", "10", "15", "30", "60", "D"].map(v => <option key={v} value={v}>{v}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-gray-400">
            History (days)
            <select value={days} onChange={e => setDays(+e.target.value)}
              className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200 text-sm">
              {[5, 10, 20, 30].map(v => <option key={v}>{v}</option>)}
            </select>
          </label>
        </div>

        <div className="mt-3">
          <p className="text-xs text-gray-400 mb-2">Active modules</p>
          <div className="flex flex-wrap gap-2">
            {modules.map(m => (
              <button
                key={m.id}
                onClick={() => setEnabled(p => ({ ...p, [m.id]: !p[m.id] }))}
                title={m.description}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  enabled[m.id]
                    ? "bg-blue-600 border-blue-500 text-white"
                    : "bg-gray-800 border-gray-700 text-gray-400"
                }`}
              >
                {m.name}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={run}
          disabled={loading}
          className="mt-4 px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium transition-colors"
        >
          {loading ? "Running…" : "Run Analysis"}
        </button>
      </div>

      {error && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-3">{error}</p>}

      {result && (
        <>
          {/* Consensus */}
          <div className={`rounded-lg p-5 border ${SIGNAL_BG[result.consensus]}`}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-gray-400 mb-1">Consensus Signal</p>
                <p className={`text-4xl font-bold ${SIGNAL_COLOR[result.consensus]}`}>{result.consensus}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-400">Latest Close</p>
                <p className="text-2xl font-semibold text-white">₹{result.latest_close.toFixed(2)}</p>
              </div>
            </div>
            <div className="flex gap-4 mt-3 text-sm">
              <span className="text-green-400">{result.buy_votes} BUY</span>
              <span className="text-red-400">{result.sell_votes} SELL</span>
              <span className="text-yellow-400">{result.hold_votes} HOLD</span>
              <span className="text-gray-400 ml-auto">{result.candles} candles analysed</span>
            </div>
          </div>

          {/* Module results */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {Object.entries(result.modules).map(([id, mod]) => (
              <div key={id} className="bg-gray-900 border border-gray-800 rounded-lg p-4">
                <div className="flex justify-between items-start mb-2">
                  <span className="text-sm font-medium text-gray-200 capitalize">{id.replace(/_/g, " ")}</span>
                  {mod.error
                    ? <span className="text-red-400 text-xs">error</span>
                    : <span className={`text-xs font-bold ${SIGNAL_COLOR[mod.signal]}`}>{mod.signal}</span>
                  }
                </div>
                {mod.error
                  ? <p className="text-xs text-red-400">{mod.error}</p>
                  : <>
                      <p className="text-xs text-gray-400 mb-2">{mod.reason}</p>
                      <div className="flex flex-wrap gap-2">
                        {Object.entries(mod.indicators).map(([k, v]) => (
                          <span key={k} className="text-xs bg-gray-800 px-2 py-0.5 rounded text-gray-300">
                            {k}: {v}
                          </span>
                        ))}
                      </div>
                      <div className="mt-2 h-1 rounded bg-gray-800">
                        <div
                          className={`h-1 rounded ${mod.signal === "BUY" ? "bg-green-500" : mod.signal === "SELL" ? "bg-red-500" : "bg-yellow-500"}`}
                          style={{ width: `${(mod.confidence * 100).toFixed(0)}%` }}
                        />
                      </div>
                      <p className="text-xs text-gray-500 mt-1">Confidence: {(mod.confidence * 100).toFixed(0)}%</p>
                    </>
                }
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
