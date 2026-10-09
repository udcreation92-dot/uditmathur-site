import { useEffect, useRef, useState } from "react";
import { init, dispose } from "klinecharts";
import { api } from "../api";
import { strategyBreakevens } from "../payoff";

// Trading chart (see docs/chart-klinecharts-plan.md). Phase 1: candles + timeframes. Phase 1b (this
// file): realtime candle rolling from the Fyers WS tick cache (/stream), a live spot line, and
// breakeven overlays for open strategies on the charted underlying. Built on raw klinecharts so
// Phase 2's draggable SL/target order lines can attach to the same instance.

const PERIODS = [
  { id: "1", label: "1m", days: 3, ms: 60_000 },
  { id: "5", label: "5m", days: 7, ms: 300_000 },
  { id: "15", label: "15m", days: 20, ms: 900_000 },
  { id: "60", label: "1h", days: 60, ms: 3_600_000 },
  { id: "D", label: "1D", days: 360, ms: 86_400_000 },   // Fyers caps a single daily request at ~366 days
];

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

const ymd = (d) => d.toISOString().slice(0, 10);

// Distinct colours per expiry so two expiries' breakevens are tellable apart on the chart.
const EXPIRY_COLORS = ["#f59e0b", "#a855f7", "#06b6d4", "#ec4899", "#84cc16"];
const fmtExpiry = (iso) => {
  const d = new Date(iso + "T00:00:00");
  return isNaN(d) ? iso : d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
};

export default function Chart({ symbol }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const periodRef = useRef("15");
  const spotLineRef = useRef(null);   // overlay id of the live spot line
  const beIdsRef = useRef([]);        // overlay ids of breakeven lines
  const [period, setPeriod] = useState("15");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [beLegend, setBeLegend] = useState([]);   // [{ expiry, color, bes:[...] }] per expiry

  useEffect(() => { periodRef.current = period; }, [period]);

  // Create the chart once; dispose on unmount. ResizeObserver keeps it sized to the container.
  useEffect(() => {
    const el = containerRef.current;
    const chart = init(el, { styles: DARK_STYLES });
    chart.createIndicator("VOL", false);
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => { ro.disconnect(); dispose(el); chartRef.current = null; };
  }, []);

  // Load candles + open-strategy breakevens TOGETHER (one effect, no race). On the daily view, extend
  // the time axis with empty future trading-day bars up to the last expiry so the expiry VERTICAL lines
  // land at their true dates (klinecharts otherwise clamps overlays past the last candle). Then draw
  // per-expiry breakeven (horizontal) + expiry-date (vertical) overlays, colour-coded per expiry.
  useEffect(() => {
    if (!symbol?.symbol || !chartRef.current) return;
    let cancelled = false;
    setLoading(true); setError(null);
    beIdsRef.current.forEach(id => chartRef.current.removeOverlay(id));
    beIdsRef.current = [];
    setBeLegend([]);

    const p = PERIODS.find(x => x.id === period) || PERIODS[2];
    const to = ymd(new Date());
    const from = ymd(new Date(Date.now() - p.days * 864e5));

    Promise.all([
      api.getCandles(symbol.symbol, period, from, to),
      api.listStrategies().catch(() => []),
    ]).then(([resp, strats]) => {
      if (cancelled || !chartRef.current) return;
      const chart = chartRef.current;
      const bars = (resp.candles || []).map(c => ({
        timestamp: c[0] * 1000, open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5],
      }));

      const mine = (strats || []).filter(s => (s.status || "").toUpperCase() === "OPEN" && s.underlying_symbol === symbol.symbol);
      const spot = mine.find(s => s.spot)?.spot;
      const byExp = {};
      for (const s of mine) (byExp[s.expiry] = byExp[s.expiry] || []).push(s);
      const expiries = Object.keys(byExp).sort();

      // Extend the DAILY axis with empty future trading-day bars up to the last expiry (so vertical
      // expiry lines sit at the right dates). expDateToTs maps an expiry date -> its future bar ts.
      const expDateToTs = {};
      if (period === "D" && expiries.length && bars.length) {
        const DAY = 86400000;
        const istDate = (ms) => new Date(ms + 5.5 * 3600000).toISOString().slice(0, 10);
        const istDow = (ms) => new Date(ms + 5.5 * 3600000).getUTCDay();
        const lastTs = bars[bars.length - 1].timestamp;
        const lastClose = bars[bars.length - 1].close;   // flat placeholder value keeps the y-axis valid
        const maxExp = expiries[expiries.length - 1];
        for (let t = lastTs + DAY; istDate(t) <= maxExp; t += DAY) {
          if (istDow(t) === 0 || istDow(t) === 6) continue;   // skip weekends
          bars.push({ timestamp: t, open: lastClose, high: lastClose, low: lastClose, close: lastClose, volume: 0, _future: true });
          expDateToTs[istDate(t)] = t;
        }
      }

      chart.applyNewData(bars);
      try { chart.setBarSpace(12); } catch { /* noop */ }
      if (!bars.length) { setError("No candle data for this symbol/timeframe."); return; }

      const legend = [];
      expiries.forEach((exp, i) => {
        const color = EXPIRY_COLORS[i % EXPIRY_COLORS.length];
        const legs = byExp[exp].flatMap(s => s.legs || []);
        const bes = strategyBreakevens(legs, spot);
        bes.forEach(be => {
          const id = chart.createOverlay({
            name: "priceLine", lock: true, points: [{ value: be }],
            styles: { line: { color, style: "dashed", size: 1 }, text: { color } },
          });
          if (id) beIdsRef.current.push(id);
        });
        const vts = expDateToTs[exp] ?? new Date(exp + "T15:30:00+05:30").getTime();
        if (vts) {
          const vid = chart.createOverlay({
            name: "verticalStraightLine", lock: true, points: [{ timestamp: vts }],
            styles: { line: { color, style: "dashed", size: 1 } },
          });
          if (vid) beIdsRef.current.push(vid);
        }
        if (bes.length) legend.push({ expiry: exp, color, bes });
      });
      setBeLegend(legend);
    }).catch(e => { if (!cancelled) setError(e.message); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [symbol?.symbol, period]);

  // Realtime: subscribe the symbol to the live feed and poll the tick cache, rolling the forming
  // candle and keeping a live spot line. (No live ticks outside market hours — the line/candle just
  // hold the last value until the market opens.)
  useEffect(() => {
    if (!symbol?.symbol || !chartRef.current) return;
    let stopped = false;
    api.streamSubscribe([symbol.symbol]).catch(() => {});

    const tick = async () => {
      if (stopped) return;
      try {
        const resp = await api.streamQuotes([symbol.symbol]);
        const q = resp?.quotes?.[symbol.symbol];
        const ltp = q?.ltp;
        const chart = chartRef.current;
        if (ltp == null || !chart) return;

        // Live spot line (create once, then move it).
        const spotStyles = { styles: { line: { color: "#3b82f6", style: "dashed", size: 1 }, text: { color: "#3b82f6" } } };
        if (spotLineRef.current == null) {
          spotLineRef.current = chart.createOverlay({ name: "priceLine", lock: true, points: [{ value: ltp }], ...spotStyles });
        } else {
          chart.overrideOverlay({ id: spotLineRef.current, points: [{ value: ltp }] });
        }

        // Roll the forming candle on the series' own cadence (robust to IST/UTC boundary offsets).
        const list = chart.getDataList();
        if (!list.length) return;
        const now = Date.now();
        // Roll the last REAL candle — skip the empty future (expiry-axis) placeholder bars.
        let li = list.length - 1;
        while (li > 0 && (list[li].timestamp > now || list[li].close == null)) li--;
        const last = list[li];
        const periodMs = (PERIODS.find(p => p.id === periodRef.current) || PERIODS[2]).ms;
        let bar;
        if (now >= last.timestamp + periodMs) {
          bar = { timestamp: last.timestamp + periodMs, open: ltp, high: ltp, low: ltp, close: ltp, volume: 0 };
        } else {
          bar = { ...last, high: Math.max(last.high, ltp), low: Math.min(last.low, ltp), close: ltp };
        }
        chart.updateData(bar);
      } catch { /* transient — next tick retries */ }
    };

    const interval = setInterval(tick, 1500);
    tick();
    return () => {
      stopped = true;
      clearInterval(interval);
      const chart = chartRef.current;
      if (chart && spotLineRef.current != null) { chart.removeOverlay(spotLineRef.current); spotLineRef.current = null; }
    };
  }, [symbol?.symbol]);


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
        <span className="text-[11px] text-blue-400">— spot</span>
        {beLegend.map(l => (
          <span key={l.expiry} className="text-[11px]" style={{ color: l.color }}>
            — {fmtExpiry(l.expiry)} BE {l.bes.map(b => Math.round(b).toLocaleString("en-IN")).join(" / ")}
          </span>
        ))}
        {loading && <span className="text-xs text-gray-500">loading…</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
      <div ref={containerRef} style={{ width: "100%", height: 540, backgroundColor: "#0b0f17" }} />
    </div>
  );
}
