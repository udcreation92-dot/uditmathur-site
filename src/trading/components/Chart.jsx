import { useEffect, useRef, useState } from "react";
import { init, dispose } from "klinecharts";
import { api } from "../api";

// Phase 1 of the trading chart (see docs/chart-klinecharts-plan.md): raw klinecharts candles for the
// selected symbol, with a timeframe selector. Phase 2 adds draggable SL/target overlays wired to the
// scalp engine — built on the same instance, which is why we use raw klinecharts (not KLineChart Pro,
// which hides its chart instance).

const PERIODS = [
  { id: "1", label: "1m", days: 3 },
  { id: "5", label: "5m", days: 7 },
  { id: "15", label: "15m", days: 20 },
  { id: "60", label: "1h", days: 60 },
  { id: "D", label: "1D", days: 360 },   // Fyers caps a single daily request at ~366 days
];

// klinecharts' default theme is light; these overrides make it readable on the dark dashboard.
const DARK_STYLES = {
  grid: { horizontal: { color: "#1f2937" }, vertical: { color: "#1f2937" } },
  candle: {
    bar: { upColor: "#22c55e", downColor: "#ef4444", upBorderColor: "#22c55e", downBorderColor: "#ef4444", upWickColor: "#22c55e", downWickColor: "#ef4444" },
    tooltip: { text: { color: "#9ca3af" } },
    priceMark: { last: { text: { color: "#0b0f17" } } },
  },
  xAxis: { axisLine: { color: "#374151" }, tickText: { color: "#9ca3af" }, tickLine: { color: "#374151" } },
  yAxis: { axisLine: { color: "#374151" }, tickText: { color: "#9ca3af" }, tickLine: { color: "#374151" } },
  separator: { color: "#374151" },
  crosshair: {
    horizontal: { line: { color: "#6b7280" }, text: { backgroundColor: "#374151" } },
    vertical: { line: { color: "#6b7280" }, text: { backgroundColor: "#374151" } },
  },
  indicator: { tooltip: { text: { color: "#9ca3af" } } },
};

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

export default function Chart({ symbol }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const [period, setPeriod] = useState("15");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Create the chart once; dispose on unmount. A ResizeObserver keeps it sized to the container.
  useEffect(() => {
    const el = containerRef.current;
    const chart = init(el, { styles: DARK_STYLES });
    chart.createIndicator("VOL", false);   // volume in its own sub-pane
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => { ro.disconnect(); dispose(el); chartRef.current = null; };
  }, []);

  // (Re)load candles whenever the symbol or timeframe changes.
  useEffect(() => {
    if (!symbol?.symbol || !chartRef.current) return;
    let cancelled = false;
    setLoading(true); setError(null);
    const p = PERIODS.find(x => x.id === period) || PERIODS[2];
    const to = ymd(new Date());
    const from = ymd(new Date(Date.now() - p.days * 864e5));
    api.getCandles(symbol.symbol, period, from, to)
      .then(resp => {
        if (cancelled) return;
        const bars = (resp.candles || []).map(c => ({
          timestamp: c[0] * 1000, open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
        }));
        chartRef.current.applyNewData(bars);
        if (!bars.length) setError("No candle data for this symbol/timeframe.");
      })
      .catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [symbol?.symbol, period]);

  return (
    <div className="bg-gray-900 rounded-lg border border-gray-800 p-3">
      <div className="flex items-center gap-3 mb-2">
        <span className="text-sm font-semibold text-gray-300">{symbol?.symbol || "—"}</span>
        <div className="flex gap-1">
          {PERIODS.map(p => (
            <button key={p.id} onClick={() => setPeriod(p.id)}
              className={`px-2 py-0.5 text-xs rounded ${period === p.id ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>
              {p.label}
            </button>
          ))}
        </div>
        {loading && <span className="text-xs text-gray-500">loading…</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
      <div ref={containerRef} style={{ width: "100%", height: 540, backgroundColor: "#0b0f17" }} />
    </div>
  );
}
