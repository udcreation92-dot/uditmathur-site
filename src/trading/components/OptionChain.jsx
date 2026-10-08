import { useState, useEffect, useCallback, Fragment } from "react";
import { api } from "../api";
import { findDominantWall, confidenceLabel } from "../pettittTest";
import { impliedVolPct } from "../iv";

function OiBar({ value, max, side }) {
  const pct = max > 0 ? Math.max((value / max) * 100, 2) : 0;
  const color = side === "CE" ? "bg-green-500/30" : "bg-red-500/30";
  const anchor = side === "CE" ? "right-0" : "left-0";
  return (
    <div
      className={`absolute top-0 bottom-0 ${anchor} ${color} pointer-events-none`}
      style={{ width: `${pct}%` }}
    />
  );
}

function DepthSide({ label, depth, color }) {
  if (!depth) return <div className="text-gray-500 text-xs">Loading…</div>;
  return (
    <div>
      <p className={`text-xs font-semibold mb-1 ${color}`}>{label}</p>
      <p className="text-xs text-gray-500 mb-1">
        Total Buy Qty: <span className="text-gray-300">{depth.totalbuyqty?.toLocaleString()}</span>
        {" · "}Total Sell Qty: <span className="text-gray-300">{depth.totalsellqty?.toLocaleString()}</span>
      </p>
      <div className="grid grid-cols-2 gap-2">
        <div>
          <p className="text-[10px] text-gray-500 mb-0.5">BID</p>
          {depth.bids?.slice(0, 5).map((b, i) => (
            <div key={i} className="flex justify-between text-xs text-green-400">
              <span>{b.price}</span>
              <span className="text-gray-400">{b.volume?.toLocaleString()}</span>
            </div>
          ))}
        </div>
        <div>
          <p className="text-[10px] text-gray-500 mb-0.5">ASK</p>
          {depth.ask?.slice(0, 5).map((a, i) => (
            <div key={i} className="flex justify-between text-xs text-red-400">
              <span>{a.price}</span>
              <span className="text-gray-400">{a.volume?.toLocaleString()}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const REFRESH_OPTIONS = [1000, 2000, 5000, 10000];

function LegSelectButtons({ selectedSide, onToggle, label }) {
  const base = "px-2.5 py-1 rounded text-[11px] font-semibold border transition-colors";
  return (
    <div className="flex gap-2 mt-2">
      <button onClick={() => onToggle("BUY")}
        className={`${base} ${selectedSide === "BUY"
          ? "bg-green-600 text-white border-green-500"
          : "bg-green-900/40 text-green-300 border-green-700 hover:bg-green-800/50"}`}>
        {selectedSide === "BUY" ? "✓ " : "+ "}Buy {label}
      </button>
      <button onClick={() => onToggle("SELL")}
        className={`${base} ${selectedSide === "SELL"
          ? "bg-red-600 text-white border-red-500"
          : "bg-red-900/40 text-red-300 border-red-700 hover:bg-red-800/50"}`}>
        {selectedSide === "SELL" ? "✓ " : "+ "}Sell {label}
      </button>
    </div>
  );
}

export default function OptionChain({ symbol, onAddLegs }) {
  const [strikeCount, setStrikeCount] = useState(10);
  const [expiry, setExpiry] = useState("");
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedStrike, setExpandedStrike] = useState(null);
  const [depthData, setDepthData] = useState({});
  const [depthLoading, setDepthLoading] = useState(false);
  const [live, setLive] = useState(true);
  const [refreshMs, setRefreshMs] = useState(2000);
  // Contracts staged to send to the Strategy Builder as one batch. Keyed by symbol so the same
  // contract can't be added twice; toggling the other side just flips it.
  const [selection, setSelection] = useState([]);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const result = await api.getOptionChain(symbol.symbol, strikeCount, expiry);
      setData(result.data);
    } catch (err) {
      if (!silent) setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [symbol.symbol, strikeCount, expiry]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { setExpandedStrike(null); setDepthData({}); setSelection([]); }, [symbol.symbol]);

  useEffect(() => {
    if (!live) return;
    const interval = setInterval(() => load(true), refreshMs);
    return () => clearInterval(interval);
  }, [live, refreshMs, load]);

  const loadDepth = useCallback(async (strike, ce, pe) => {
    try {
      const [ceDepth, peDepth] = await Promise.all([
        ce ? api.getDepth(ce.symbol) : Promise.resolve(null),
        pe ? api.getDepth(pe.symbol) : Promise.resolve(null),
      ]);
      setDepthData(prev => ({ ...prev, [strike]: { ce: ceDepth, pe: peDepth } }));
    } catch (err) {
      setDepthData(prev => ({ ...prev, [strike]: { error: err.message } }));
    }
  }, []);

  const selectedSide = (sym) => selection.find(l => l.symbol === sym)?.side;

  function toggleLeg(row, side) {
    if (!onAddLegs || !row?.symbol) return;
    const lot = row.lot_size || 1;
    setSelection(prev => {
      const existing = prev.find(l => l.symbol === row.symbol);
      // Clicking the already-selected side removes it; any other click sets/replaces the side.
      if (existing && existing.side === side) return prev.filter(l => l.symbol !== row.symbol);
      const rest = prev.filter(l => l.symbol !== row.symbol);
      return [...rest, {
        symbol: row.symbol, name: "", side, quantity: lot, lot_size: lot,
        order_type: "LMT", limit_price: row.ltp || 0, product_type: "MARGIN",
      }];
    });
  }

  function sendSelection() {
    if (!onAddLegs || selection.length === 0) return;
    onAddLegs(selection);
    setSelection([]);
  }

  async function toggleStrike(strike, ce, pe) {
    if (expandedStrike === strike) { setExpandedStrike(null); return; }
    setExpandedStrike(strike);
    setDepthLoading(true);
    await loadDepth(strike, ce, pe);
    setDepthLoading(false);
  }

  useEffect(() => {
    if (!live || expandedStrike == null || !data) return;
    const strikes = data.optionsChain.filter(o => o.option_type !== "");
    const byStrike = {};
    for (const row of strikes) {
      (byStrike[row.strike_price] ??= {})[row.option_type] = row;
    }
    const leg = byStrike[expandedStrike];
    if (!leg) return;
    const interval = setInterval(() => loadDepth(expandedStrike, leg.CE, leg.PE), refreshMs);
    return () => clearInterval(interval);
  }, [live, refreshMs, expandedStrike, data, loadDepth]);

  if (loading && !data) return <div className="text-gray-400 text-sm">Loading option chain…</div>;
  if (error) return <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-3">{error}</p>;
  if (!data) return null;

  const underlying = data.optionsChain.find(o => o.option_type === "");
  const strikes = data.optionsChain.filter(o => o.option_type !== "");

  const byStrike = {};
  for (const row of strikes) {
    if (!byStrike[row.strike_price]) byStrike[row.strike_price] = {};
    byStrike[row.strike_price][row.option_type] = row;
  }
  const sortedStrikes = Object.keys(byStrike).map(Number).sort((a, b) => a - b);
  const atmStrike = underlying
    ? sortedStrikes.reduce((prev, curr) =>
        Math.abs(curr - underlying.ltp) < Math.abs(prev - underlying.ltp) ? curr : prev, sortedStrikes[0])
    : null;
  const maxOi = Math.max(1, ...strikes.map(r => r.oi || 0));

  // CE OI concentration = resistance wall; PE OI concentration = support wall. Both series
  // are read in strike-ascending order, matching how findDominantWall expects an ordered sequence.
  const ceOiSeries = sortedStrikes.map(s => byStrike[s].CE?.oi || 0);
  const peOiSeries = sortedStrikes.map(s => byStrike[s].PE?.oi || 0);
  const resistanceWall = findDominantWall(ceOiSeries);
  const supportWall = findDominantWall(peOiSeries);
  const resistanceZone = resistanceWall
    ? { lo: sortedStrikes[resistanceWall.startIdx], hi: sortedStrikes[resistanceWall.endIdx], peak: sortedStrikes[resistanceWall.peakIdx], wall: resistanceWall }
    : null;
  const supportZone = supportWall
    ? { lo: sortedStrikes[supportWall.startIdx], hi: sortedStrikes[supportWall.endIdx], peak: sortedStrikes[supportWall.peakIdx], wall: supportWall }
    : null;
  const inZone = (strike, zone) => zone && strike >= zone.lo && strike <= zone.hi;

  // Time to expiry for IV: the selected expiry's unix timestamp, or the nearest one.
  const expiryTs = +(expiry || data.expiryData?.[0]?.expiry || 0);
  const yearsToExpiry = expiryTs ? Math.max((expiryTs * 1000 - Date.now()) / (365 * 86400000), 1e-4) : 0;
  const ivFor = (row, isCall) =>
    underlying && row?.ltp ? impliedVolPct(isCall, underlying.ltp, row.strike_price, row.ltp, yearsToExpiry) : null;

  return (
    <div className="space-y-4">
      {onAddLegs && selection.length > 0 && (
        <div className="sticky top-2 z-20 bg-blue-950/90 backdrop-blur border border-blue-700 rounded-lg px-4 py-2.5 flex items-center justify-between gap-3">
          <span className="text-xs text-blue-200 min-w-0">
            <span className="font-semibold">{selection.length} leg{selection.length > 1 ? "s" : ""} staged:</span>{" "}
            <span className="text-blue-300">
              {selection.map(l => `${l.side === "BUY" ? "B" : "S"} ${l.symbol.replace(/^NSE:/, "")}`).join("  ·  ")}
            </span>
          </span>
          <div className="flex gap-2 shrink-0">
            <button onClick={() => setSelection([])}
              className="text-[11px] px-2.5 py-1 rounded border border-gray-600 text-gray-300 hover:bg-gray-800">
              Clear
            </button>
            <button onClick={sendSelection}
              className="text-[11px] px-3 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white font-semibold">
              Send {selection.length} to Builder →
            </button>
          </div>
        </div>
      )}
      <div className="bg-gray-900 rounded-lg p-4 border border-gray-800">
        <div className="flex flex-wrap gap-4 items-end justify-between">
          <div>
            {underlying && (
              <>
                <p className="text-xs text-gray-400">{underlying.symbol}</p>
                <p className="text-2xl font-semibold text-white">
                  ₹{underlying.ltp.toFixed(2)}
                  <span className={`text-sm ml-2 ${underlying.ltpch >= 0 ? "text-green-400" : "text-red-400"}`}>
                    {underlying.ltpch >= 0 ? "+" : ""}{underlying.ltpch} ({underlying.ltpchp}%)
                  </span>
                </p>
              </>
            )}
          </div>

          <div className="flex gap-3 items-end">
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Expiry
              <select value={expiry} onChange={e => setExpiry(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200 text-sm">
                <option value="">Nearest</option>
                {data.expiryData?.map(e => (
                  <option key={e.expiry} value={e.expiry}>{e.date}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Strikes
              <select value={strikeCount} onChange={e => setStrikeCount(+e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200 text-sm">
                {[5, 10, 15, 20].map(v => <option key={v} value={v}>{v}</option>)}
              </select>
            </label>
            <button onClick={() => load(false)} disabled={loading}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium">
              {loading ? "…" : "Refresh"}
            </button>
            <label className="flex flex-col gap-1 text-xs text-gray-400">
              Every
              <select value={refreshMs} onChange={e => setRefreshMs(+e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200 text-sm">
                {REFRESH_OPTIONS.map(ms => <option key={ms} value={ms}>{ms / 1000}s</option>)}
              </select>
            </label>
            <button onClick={() => setLive(l => !l)}
              className={`px-3 py-1.5 rounded text-sm font-medium flex items-center gap-1.5 ${
                live ? "bg-green-900/40 text-green-400 border border-green-700" : "bg-gray-800 text-gray-400 border border-gray-700"
              }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${live ? "bg-green-400 animate-pulse" : "bg-gray-500"}`} />
              {live ? "Live" : "Paused"}
            </button>
          </div>
        </div>

        {data.callOi != null && data.putOi != null && (
          <div className="flex gap-6 mt-3 text-xs text-gray-400">
            <span>Call OI: <span className="text-gray-200">{data.callOi.toLocaleString()}</span></span>
            <span>Put OI: <span className="text-gray-200">{data.putOi.toLocaleString()}</span></span>
            <span>PCR: <span className="text-gray-200">{(data.putOi / data.callOi).toFixed(2)}</span></span>
          </div>
        )}
        <p className="text-[11px] text-gray-500 mt-2">Click any strike row to view live bid/ask depth &amp; quantity. Stage Buy/Sell legs across multiple strikes, then send them all to the Strategy Builder at once.</p>
      </div>

      {(resistanceZone || supportZone) && (
        <div className="bg-gray-900 rounded-lg p-3 border border-gray-800 flex flex-wrap gap-6 text-xs">
          {resistanceZone && (
            <span>
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-green-500/40 mr-1.5 align-middle" />
              Resistance zone (CE OI wall): <span className="text-gray-200 font-medium">{resistanceZone.lo}–{resistanceZone.hi}</span>
              <span className="text-gray-500"> (peak {resistanceZone.peak})</span>
              {resistanceZone.wall.rightPValue != null && (
                <span className="text-gray-500"> · {confidenceLabel(resistanceZone.wall.rightPValue)} edge</span>
              )}
            </span>
          )}
          {supportZone && (
            <span>
              <span className="inline-block w-2.5 h-2.5 rounded-sm bg-red-500/40 mr-1.5 align-middle" />
              Support zone (PE OI wall): <span className="text-gray-200 font-medium">{supportZone.lo}–{supportZone.hi}</span>
              <span className="text-gray-500"> (peak {supportZone.peak})</span>
              {supportZone.wall.rightPValue != null && (
                <span className="text-gray-500"> · {confidenceLabel(supportZone.wall.rightPValue)} edge</span>
              )}
            </span>
          )}
          <span className="text-gray-600">Estimated via Pettitt's-test change-point detection on OI-by-strike — location is more reliable than the formal p-value at this sample size.</span>
        </div>
      )}

      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-400 border-b border-gray-800">
              <th colSpan={5} className="py-2 text-center bg-green-900/20">CALLS</th>
              <th className="py-2 px-3 text-center">Strike</th>
              <th colSpan={5} className="py-2 text-center bg-red-900/20">PUTS</th>
            </tr>
            <tr className="text-gray-500 border-b border-gray-800">
              <th className="py-1.5 px-2 text-right">OI</th>
              <th className="py-1.5 px-2 text-right">OI Chg%</th>
              <th className="py-1.5 px-2 text-right">LTP</th>
              <th className="py-1.5 px-2 text-right" title="Implied volatility (Black-Scholes, computed from LTP)">IV%</th>
              <th className="py-1.5 px-2 text-right">Chg%</th>
              <th className="py-1.5 px-3 text-center font-semibold">Price</th>
              <th className="py-1.5 px-2 text-right">Chg%</th>
              <th className="py-1.5 px-2 text-right" title="Implied volatility (Black-Scholes, computed from LTP)">IV%</th>
              <th className="py-1.5 px-2 text-right">LTP</th>
              <th className="py-1.5 px-2 text-right">OI Chg%</th>
              <th className="py-1.5 px-2 text-right">OI</th>
            </tr>
          </thead>
          <tbody>
            {sortedStrikes.map(strike => {
              const ce = byStrike[strike].CE;
              const pe = byStrike[strike].PE;
              const isAtm = strike === atmStrike;
              const isExpanded = expandedStrike === strike;
              const inResistance = inZone(strike, resistanceZone);
              const inSupport = inZone(strike, supportZone);
              return (
                <Fragment key={strike}>
                  <tr
                    onClick={() => toggleStrike(strike, ce, pe)}
                    className={`border-b border-gray-800/50 cursor-pointer hover:bg-gray-800/60 ${isAtm ? "bg-blue-900/20" : ""} ${isExpanded ? "bg-gray-800" : ""}`}
                  >
                    <td className={`relative py-1.5 px-2 text-right text-gray-300 ${inResistance ? "outline outline-1 outline-green-600/60" : ""}`}>
                      <OiBar value={ce?.oi || 0} max={maxOi} side="CE" />
                      <span className="relative">{ce?.oi?.toLocaleString() ?? "-"}</span>
                    </td>
                    <td className={`py-1.5 px-2 text-right ${ce?.oichp >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {ce ? `${ce.oichp}%` : "-"}
                    </td>
                    <td className="py-1.5 px-2 text-right text-gray-100 font-medium">{ce?.ltp?.toFixed(2) ?? "-"}</td>
                    <td className="py-1.5 px-2 text-right text-purple-300">
                      {(() => { const iv = ivFor(ce, true); return iv != null ? iv.toFixed(1) : "-"; })()}
                    </td>
                    <td className={`py-1.5 px-2 text-right ${ce?.ltpchp >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {ce ? `${ce.ltpchp}%` : "-"}
                    </td>
                    <td className={`py-1.5 px-3 text-center font-semibold ${isAtm ? "text-blue-400" : "text-gray-200"}`}>
                      {strike}
                      {inResistance && <span className="block text-[9px] font-normal text-green-500">resistance</span>}
                      {inSupport && <span className="block text-[9px] font-normal text-red-500">support</span>}
                    </td>
                    <td className={`py-1.5 px-2 text-right ${pe?.ltpchp >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {pe ? `${pe.ltpchp}%` : "-"}
                    </td>
                    <td className="py-1.5 px-2 text-right text-purple-300">
                      {(() => { const iv = ivFor(pe, false); return iv != null ? iv.toFixed(1) : "-"; })()}
                    </td>
                    <td className="py-1.5 px-2 text-right text-gray-100 font-medium">{pe?.ltp?.toFixed(2) ?? "-"}</td>
                    <td className={`py-1.5 px-2 text-right ${pe?.oichp >= 0 ? "text-green-400" : "text-red-400"}`}>
                      {pe ? `${pe.oichp}%` : "-"}
                    </td>
                    <td className={`relative py-1.5 px-2 text-right text-gray-300 ${inSupport ? "outline outline-1 outline-red-600/60" : ""}`}>
                      <OiBar value={pe?.oi || 0} max={maxOi} side="PE" />
                      <span className="relative">{pe?.oi?.toLocaleString() ?? "-"}</span>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr className="bg-gray-800/40 border-b border-gray-800">
                      <td colSpan={11} className="p-3">
                        {depthLoading && !depthData[strike] ? (
                          <p className="text-gray-500 text-xs">Loading depth…</p>
                        ) : depthData[strike]?.error ? (
                          <p className="text-red-400 text-xs">{depthData[strike].error}</p>
                        ) : (
                          <div className="grid grid-cols-2 gap-6">
                            <div>
                              <DepthSide label={`CALL ${strike}`} depth={depthData[strike]?.ce} color="text-green-400" />
                              {onAddLegs && ce?.symbol && (
                                <LegSelectButtons symbol={ce.symbol} selectedSide={selectedSide(ce.symbol)}
                                  onToggle={side => toggleLeg(ce, side)} label="CE" />
                              )}
                            </div>
                            <div>
                              <DepthSide label={`PUT ${strike}`} depth={depthData[strike]?.pe} color="text-red-400" />
                              {onAddLegs && pe?.symbol && (
                                <LegSelectButtons symbol={pe.symbol} selectedSide={selectedSide(pe.symbol)}
                                  onToggle={side => toggleLeg(pe, side)} label="PE" />
                              )}
                            </div>
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
