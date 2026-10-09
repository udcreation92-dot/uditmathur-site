import { useState, useEffect, useCallback, useMemo, useRef, Fragment } from "react";
import { api } from "../api";
import { parseTbillSymbol } from "../zerodhaSymbol";
import { detectStrategyType, strategyGreeks, strategyTimeValue, parseLeg, moneyness, yearsToExpiry, legGreeks } from "../strategyAnalytics";
import PayoffPanel from "./PayoffPanel";
import WhatIfPayoff from "./WhatIfPayoff";
import { ExitLegPanel, AddLegPanel } from "./StrategyLegActions";
import MarketDepth from "./MarketDepth";

// A pending order row: cancel, or open the market depth to re-price it (chase a resting exit that
// isn't filling). Clicking a depth rung — or typing a price — modifies the live order at the broker.
function PendingOrderRow({ order: p, label, onChanged }) {
  const [modifying, setModifying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [manual, setManual] = useState("");
  const fysym = (p.symbol || "").includes(":") ? p.symbol : `NSE:${p.symbol}`;

  async function submit(price) {
    if (!(price > 0)) return;
    setBusy(true); setErr(null);
    try { await api.modifyOrder(p.id, price); setModifying(false); onChanged?.(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="py-0.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-300">
          <span className="text-[9px] bg-yellow-900/50 text-yellow-300 border border-yellow-800 rounded px-1 mr-1 align-middle">PENDING</span>
          <span className={p.side === "BUY" ? "text-green-400" : "text-red-400"}>{p.side}</span> {p.qty} {label} @ ₹{p.price}
          <span className="text-gray-600"> · {(p.broker || "").toUpperCase()}</span>
        </span>
        <span className="flex items-center gap-2">
          <button onClick={() => { setModifying(m => !m); setErr(null); }}
            className="text-[10px] text-blue-300 hover:text-blue-200 border border-gray-700 rounded px-2 py-0.5">
            {modifying ? "Close" : "Depth / modify"}
          </button>
          <button onClick={() => onChanged?.("cancel", p.id)}
            className="text-[10px] text-gray-400 hover:text-red-400 border border-gray-700 rounded px-2 py-0.5">Cancel order</button>
        </span>
      </div>
      {modifying && (
        <div className="mt-1.5 bg-gray-900/70 border border-gray-700 rounded p-2">
          <p className="text-[11px] text-gray-500 mb-1">Click a price in the depth to move the order there, or type one below.</p>
          <MarketDepth symbol={fysym} onPriceClick={(price) => submit(price)} />
          <div className="flex items-center gap-2 mt-2">
            <span className="text-[11px] text-gray-500">Or type a price:</span>
            <input type="number" step="0.05" min="0" value={manual} onChange={e => setManual(e.target.value)}
              onKeyDown={e => e.key === "Enter" && submit(+manual)} placeholder={`${p.price}`}
              className="w-24 text-right bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-xs text-gray-100" />
            <button onClick={() => submit(+manual)} disabled={busy || !(+manual > 0)}
              className="text-[11px] px-3 py-0.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded font-medium">
              {busy ? "Modifying…" : "Modify"}
            </button>
          </div>
          {err && <p className="text-red-400 text-[11px] mt-1">{err}</p>}
        </div>
      )}
    </div>
  );
}

// Shared existing/new strategy picker used by the assign + manual-order forms.
function StrategyPicker({ mode, setMode, strategyId, setStrategyId, newName, setNewName, strategyNames }) {
  return (
    <>
      <div className="flex gap-2">
        {strategyNames.length > 0 && (
          <button onClick={() => setMode("existing")}
            className={`px-2 py-1 rounded text-xs ${mode === "existing" ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-400"}`}>
            Existing Strategy
          </button>
        )}
        <button onClick={() => setMode("new")}
          className={`px-2 py-1 rounded text-xs ${mode === "new" ? "bg-blue-600 text-white" : "bg-gray-700 text-gray-400"}`}>
          New Strategy
        </button>
      </div>
      {mode === "existing" ? (
        <select value={strategyId} onChange={e => setStrategyId(e.target.value)} className="input-field text-xs">
          {strategyNames.map(s => <option key={s.id} value={s.id}>{s.name} (#{s.id})</option>)}
        </select>
      ) : (
        <input value={newName} onChange={e => setNewName(e.target.value)}
          placeholder="New strategy name" className="input-field text-xs" />
      )}
    </>
  );
}

function AssignOrderForm({ order, strategyNames, onDone, onCancel }) {
  const [mode, setMode] = useState(strategyNames.length > 0 ? "existing" : "new");
  const [strategyId, setStrategyId] = useState(strategyNames[0]?.id || "");
  const [newName, setNewName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setLoading(true); setError(null);
    try {
      await api.assignOrder({
        strategy_id: mode === "existing" ? +strategyId : undefined,
        strategy_name: mode === "new" ? newName.trim() : undefined,
        broker: order.broker, symbol: order.symbol, side: order.side,
        qty: order.qty, price: order.price, order_id: order.order_id,
      });
      onDone();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  return (
    <div className="bg-gray-800 rounded p-3 mt-2 space-y-2">
      <StrategyPicker {...{ mode, setMode, strategyId, setStrategyId, newName, setNewName, strategyNames }} />
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={loading || (mode === "new" && !newName.trim())}
          className="px-3 py-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded text-xs font-medium">
          {loading ? "Assigning…" : "Assign to strategy"}
        </button>
        <button onClick={onCancel} className="px-3 py-1 text-gray-400 hover:text-gray-200 text-xs">Cancel</button>
      </div>
    </div>
  );
}

// Add an order the dashboard didn't see (placed yesterday / directly at the broker). Once added
// it's a position — its absence from tomorrow's order book does NOT mean it was cancelled.
function ManualOrderForm({ strategyNames, onDone, onCancel }) {
  const [mode, setMode] = useState(strategyNames.length > 0 ? "existing" : "new");
  const [strategyId, setStrategyId] = useState(strategyNames[0]?.id || "");
  const [newName, setNewName] = useState("");
  const [broker, setBroker] = useState("fyers");
  const [symbol, setSymbol] = useState("");
  const [side, setSide] = useState("SELL");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [orderId, setOrderId] = useState("");
  const [status, setStatus] = useState("FILLED");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setLoading(true); setError(null);
    try {
      await api.manualOrder({
        strategy_id: mode === "existing" ? +strategyId : undefined,
        strategy_name: mode === "new" ? newName.trim() : undefined,
        broker, symbol: symbol.trim(), side, qty: +qty, price: +price,
        order_id: orderId.trim() || undefined, status,
      });
      onDone();
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }

  const valid = symbol.trim() && +qty > 0 && price !== "" && (mode !== "new" || newName.trim());

  return (
    <div className="bg-gray-800 rounded p-3 mt-2 space-y-2 max-w-2xl">
      <StrategyPicker {...{ mode, setMode, strategyId, setStrategyId, newName, setNewName, strategyNames }} />
      <div className="flex flex-wrap gap-2 items-center text-xs">
        <select value={broker} onChange={e => setBroker(e.target.value)} className="input-field text-xs w-24">
          {["fyers", "zerodha", "shoonya"].map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        {["BUY", "SELL"].map(s => (
          <button key={s} onClick={() => setSide(s)}
            className={`px-2 py-1 rounded font-medium ${side === s ? (s === "BUY" ? "bg-green-600" : "bg-red-600") + " text-white" : "bg-gray-700 text-gray-400"}`}>{s}</button>
        ))}
        <input value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="Symbol e.g. NSE:INDIGO26JUL5350PE"
          className="input-field text-xs flex-1 min-w-[220px]" />
      </div>
      <div className="flex flex-wrap gap-2 items-center text-xs">
        <label className="text-[10px] text-gray-500 flex items-center gap-1">Qty
          <input type="number" min={1} value={qty} onChange={e => setQty(e.target.value)} className="input-field text-xs w-24" /></label>
        <label className="text-[10px] text-gray-500 flex items-center gap-1">Price
          <input type="number" min={0} step="0.05" value={price} onChange={e => setPrice(e.target.value)} className="input-field text-xs w-24" /></label>
        <label className="text-[10px] text-gray-500 flex items-center gap-1">Order id (optional)
          <input value={orderId} onChange={e => setOrderId(e.target.value)} className="input-field text-xs w-40" /></label>
        <select value={status} onChange={e => setStatus(e.target.value)} className="input-field text-xs w-28" title="A real past fill (FILLED) or a resting order (PENDING)">
          <option value="FILLED">FILLED</option>
          <option value="PENDING">PENDING</option>
        </select>
      </div>
      <p className="text-[10px] text-gray-600">Symbol in Fyers format (bare tradingsymbol for Zerodha). Qty is total units (lots × lot size).</p>
      {error && <p className="text-red-400 text-xs">{error}</p>}
      <div className="flex gap-2">
        <button onClick={submit} disabled={loading || !valid}
          className="px-3 py-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded text-xs font-medium">
          {loading ? "Adding…" : "Add order"}
        </button>
        <button onClick={onCancel} className="px-3 py-1 text-gray-400 hover:text-gray-200 text-xs">Cancel</button>
      </div>
    </div>
  );
}

const fmtInr = (n) => "₹" + Math.round(Number(n) || 0).toLocaleString("en-IN");

// Backend timestamps are naive UTC (datetime.utcnow().isoformat(), no timezone) — JS would
// misread them as local time, so append 'Z' when there's no offset before parsing, so they
// convert correctly to the browser's local zone (e.g. IST).
function fmtDateTime(ts) {
  if (!ts) return "";
  const iso = /[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : ts + "Z";
  return new Date(iso).toLocaleString();
}


function daysToExpiry(expiry) {
  if (!expiry) return null;
  const ms = new Date(expiry + "T15:30:00") - new Date();
  return Math.ceil(ms / 86400000);
}

function PnlSparkline({ strategyId }) {
  const [points, setPoints] = useState(null);

  useEffect(() => {
    api.getPnlHistory(strategyId).then(setPoints).catch(() => setPoints([]));
  }, [strategyId]);

  if (points === null) return <p className="text-gray-500 text-xs p-2">Loading…</p>;
  if (points.length < 2) return <p className="text-gray-500 text-xs p-2">Not enough snapshots yet — P&L is recorded every 15 minutes while the market is open.</p>;

  const W = 560, H = 90, PAD = 4;
  const pls = points.map(p => p.pl);
  const min = Math.min(...pls, 0), max = Math.max(...pls, 0);
  const range = max - min || 1;
  const x = i => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = v => H - PAD - ((v - min) / range) * (H - 2 * PAD);
  const path = pls.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const zeroY = y(0);
  const last = pls[pls.length - 1];

  return (
    <div className="p-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-24 bg-gray-900/60 rounded">
        <line x1={PAD} y1={zeroY} x2={W - PAD} y2={zeroY} stroke="#3a3a3a" strokeWidth="1" strokeDasharray="3,3" />
        <path d={path} fill="none" stroke={last >= 0 ? "#3fb26b" : "#e06c75"} strokeWidth="1.5" />
      </svg>
      <p className="text-[10px] text-gray-500 mt-1">
        {new Date(points[0].ts + "Z").toLocaleString()} → {new Date(points[points.length - 1].ts + "Z").toLocaleString()}
        {" · "}last ₹{last.toFixed(0)} · {points.length} snapshots
      </p>
    </div>
  );
}

function NotesEditor({ strategy, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(strategy.notes || "");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await api.setStrategyNotes(strategy.id, text);
      setEditing(false);
      onSaved?.();
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <p className="text-[11px] text-gray-500 mt-1 italic">
        {strategy.notes ? <span className="text-gray-400 whitespace-pre-wrap">{strategy.notes}</span> : "No journal notes."}
        <button onClick={() => { setText(strategy.notes || ""); setEditing(true); }}
          className="ml-2 not-italic text-[10px] px-1.5 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 border border-gray-700 rounded">
          {strategy.notes ? "Edit" : "Add note"}
        </button>
      </p>
    );
  }
  return (
    <div className="mt-1 space-y-1">
      <textarea value={text} onChange={e => setText(e.target.value)} rows={3}
        placeholder="Why entered, plan, exit rule…" className="input-field text-xs w-full" />
      <div className="flex gap-2">
        <button onClick={save} disabled={saving}
          className="text-[10px] px-2 py-0.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded">
          {saving ? "…" : "Save"}
        </button>
        <button onClick={() => setEditing(false)} className="text-[10px] text-gray-400 hover:text-gray-200">Cancel</button>
      </div>
    </div>
  );
}

const GREEK_FMT = (n, d = 0) => (n >= 0 ? "+" : "") + n.toFixed(d);
const fmtLakh = (n) => {
  const v = Number(n) || 0;
  return Math.abs(v) >= 100000 ? "₹" + (v / 100000).toFixed(2) + "L" : "₹" + Math.round(v).toLocaleString("en-IN");
};

// A labelled metric tile for the strategy card header. `tone` colors the value by sign.
function StatTile({ label, value, sub, tone, title }) {
  const color = tone == null ? "text-gray-200" : tone >= 0 ? "text-green-400" : "text-red-400";
  return (
    <div className="bg-gray-900/60 rounded-lg px-3 py-2" title={title}>
      <div className="text-[11px] text-gray-500 whitespace-nowrap">{label}</div>
      <div className={`text-[15px] font-semibold mt-0.5 ${color}`}>{value}{sub && <span className="text-[10px] text-gray-500 font-normal ml-1">{sub}</span>}</div>
    </div>
  );
}

// Live F&O volatility ratio for the strategy's underlying (ITM OI concentration on the nearest
// expiry — see the Volatility Scanner). Polls every 2 min; hides itself if the underlying isn't
// an F&O name or no chain data is available.
function VolatilityTile({ root }) {
  const [vol, setVol] = useState(null);

  useEffect(() => {
    if (!root) { setVol(null); return; }
    let alive = true;
    const load = () => api.getVolatilityForRoot(root)
      .then(v => { if (alive) setVol(v && v.volatility_ratio != null ? v : null); })
      .catch(() => {});
    load();
    const id = setInterval(load, 120000);
    return () => { alive = false; clearInterval(id); };
  }, [root]);

  if (!vol) return null;
  const side = vol.ce_ratio >= vol.pe_ratio ? "CE" : "PE";
  return (
    <div className="bg-gray-900/60 rounded-lg px-3 py-2" title={`ITM OI concentration on nearest expiry · CE ${vol.ce_ratio}% / PE ${vol.pe_ratio}% · updates every 2 min`}>
      <div className="text-[11px] text-gray-500 whitespace-nowrap">Vol Ratio</div>
      <div className="text-[15px] font-semibold mt-0.5 text-amber-300">
        {vol.volatility_ratio}%<span className="text-[10px] text-gray-500 font-normal ml-1">{side} side</span>
      </div>
    </div>
  );
}

// Auto-exit arming: profit-taking on live ROI decay. Entry locks in ~X% p.a.; when the card's
// LIVE ROI (annualized remaining capture) decays to <= the target, the backend watcher
// AUTOMATICALLY places limit exit orders at the current bid/ask — the fat part of the edge is
// banked and the residual isn't worth the risk. Real money — arming is the explicit consent.
function AutoExitControl({ strategy, onChanged }) {
  const armed = strategy.auto_exit;
  const [confirming, setConfirming] = useState(false);
  const [mode, setMode] = useState("roi");     // 'roi' | 'spot'
  const [target, setTarget] = useState("");    // ROI target
  const [spotTarget, setSpotTarget] = useState("");
  const [spotDir, setSpotDir] = useState("above");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const liveRoi = strategy.roi_pct; // annualized forward capture — same figure as the Live ROI tile
  const spot = strategy.spot;
  const wouldFireNow = mode === "roi"
    ? (liveRoi != null && target !== "" && liveRoi <= +target)
    : (spot != null && spotTarget !== "" && (spotDir === "above" ? spot >= +spotTarget : spot <= +spotTarget));
  const canArm = mode === "roi" ? !!target : +spotTarget > 0;

  async function arm() {
    setBusy(true); setError(null);
    const body = mode === "spot"
      ? { trigger_type: "spot", target_spot: +spotTarget, spot_dir: spotDir }
      : { trigger_type: "roi", target_roi_pct: +target };
    try { await api.armAutoExit(strategy.id, body); setConfirming(false); setTarget(""); setSpotTarget(""); onChanged?.(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function disarm() {
    setBusy(true); setError(null);
    try { await api.disarmAutoExit(strategy.id); onChanged?.(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (armed?.status === "ARMED") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs bg-yellow-900/20 border border-yellow-800/60 rounded px-3 py-1.5">
        {armed.trigger_type === "spot" ? (
          <>
            <span className="text-amber-300 font-semibold">⚡ Auto-exit ARMED — fires when underlying {armed.spot_dir === "above" ? "≥" : "≤"} {armed.target_spot}</span>
            {spot != null && <span className="text-gray-400">spot now <span className="text-gray-300">{spot}</span></span>}
          </>
        ) : (
          <>
            <span className="text-amber-300 font-semibold">⚡ Auto-exit ARMED — fires when Live ROI ≤ {armed.target_roi_pct}% p.a.</span>
            {liveRoi != null && (
              <span className="text-gray-400">current <span className={liveRoi <= armed.target_roi_pct ? "text-green-400" : "text-gray-300"}>{liveRoi.toFixed(1)}%</span></span>
            )}
          </>
        )}
        <span className="text-gray-600">places limit orders at bid/ask automatically</span>
        <button onClick={disarm} disabled={busy} className="ml-auto text-[11px] px-2 py-0.5 text-gray-400 hover:text-red-400 border border-gray-700 rounded">Disarm</button>
        {error && <span className="text-red-400 w-full">{error}</span>}
      </div>
    );
  }
  if (armed?.status === "FIRED") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs bg-green-900/20 border border-green-800/60 rounded px-3 py-1.5">
        <span className="text-green-300 font-semibold">⚡ Auto-exit FIRED — limit exit orders placed</span>
        {armed.note && <span className="text-gray-500">{armed.note}</span>}
        <button onClick={disarm} disabled={busy} className="ml-auto text-[11px] px-2 py-0.5 text-gray-400 hover:text-gray-200 border border-gray-700 rounded">Clear</button>
      </div>
    );
  }
  return (
    <div className="mt-2">
      {!confirming ? (
        <button onClick={() => setConfirming(true)}
          className="text-xs text-amber-300 hover:text-amber-200 border border-yellow-900/60 bg-yellow-900/10 rounded px-3 py-1">
          ⚡ Auto-exit…
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs bg-gray-900/60 border border-gray-800 rounded p-2">
          <div className="flex items-center gap-1 mr-1">
            {[["roi", "Live ROI"], ["spot", "Underlying LTP"]].map(([id, label]) => (
              <button key={id} onClick={() => setMode(id)}
                className={`px-2 py-0.5 rounded ${mode === id ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>{label}</button>
            ))}
          </div>
          {mode === "roi" ? (
            <>
              <span className="text-gray-400">exit when Live ROI ≤</span>
              <input type="number" step="1" value={target} onChange={e => setTarget(e.target.value)}
                className="input-field text-xs w-20" placeholder="e.g. 10" autoFocus />
              <span className="text-gray-500">% p.a.</span>
              <span className="text-gray-500">· current {liveRoi != null ? liveRoi.toFixed(1) + "%" : "—"}</span>
              {liveRoi == null && <span className="text-yellow-400">needs margin + live quotes</span>}
              {wouldFireNow && <span className="text-red-400 font-semibold">⚠ already ≤ target — fires IMMEDIATELY</span>}
            </>
          ) : (
            <>
              <span className="text-gray-400">exit when underlying</span>
              <select value={spotDir} onChange={e => setSpotDir(e.target.value)} className="input-field text-xs w-24">
                <option value="above">rises ≥</option>
                <option value="below">falls ≤</option>
              </select>
              <input type="number" step="0.05" value={spotTarget} onChange={e => setSpotTarget(e.target.value)}
                className="input-field text-xs w-24" placeholder="e.g. 24500" autoFocus />
              <span className="text-gray-500">· spot now {spot != null ? spot : "—"}</span>
              {spot == null && <span className="text-yellow-400">needs live spot</span>}
              {wouldFireNow && <span className="text-red-400 font-semibold">⚠ spot already past target — fires IMMEDIATELY</span>}
            </>
          )}
          <button onClick={arm} disabled={busy || !canArm}
            className="px-3 py-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded font-medium"
            title="Arms auto-exit — when the trigger is hit it places limit orders at bid/ask automatically, no further confirm">
            {busy ? "…" : "Arm — auto-places orders"}
          </button>
          <button onClick={() => setConfirming(false)} className="text-gray-400 hover:text-gray-200">Cancel</button>
          {error && <span className="text-red-400 w-full">{error}</span>}
        </div>
      )}
    </div>
  );
}

// Roll: exit this strategy and redeploy its released margin into a better-ROI candidate found
// by the scanners. Constraints are captured automatically: candidate real ROI >= this strategy's
// live ROI, real margin <= its margin. Execution is sequential and margin-safe (exit fills first).
function RollPanel({ strategy, onClose, onRolled }) {
  const [scan, setScan] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState(null);
  const [picked, setPicked] = useState(null);
  const [lots, setLots] = useState(1);
  const [broker, setBroker] = useState("shoonya");
  const [job, setJob] = useState(null);
  const pollRef = useRef(null);
  // Setup: the target script to roll INTO (any script, user's choice) + the safe strikes the
  // user is willing to sell there (feeds the safe-strangle and credit-spread scans).
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState([]);
  const [target, setTarget] = useState(null);   // { symbol, symbol_desc }
  const [expiries, setExpiries] = useState([]);  // [{ expiry_ts, date, days }]
  const [expiryTs, setExpiryTs] = useState("");
  const [safeCe, setSafeCe] = useState("");      // CE-side safe PRICE LEVEL (optional; snapped to nearest strike)
  const [safePe, setSafePe] = useState("");      // PE-side safe PRICE LEVEL (optional)
  const [includeItm, setIncludeItm] = useState(false);  // scan ITM strikes for strangles too
  const [overrideRoi, setOverrideRoi] = useState(false); // manually set the target ROI floor
  const [customRoi, setCustomRoi] = useState("");        // the custom floor value
  const [ignoreMargin, setIgnoreMargin] = useState(false); // drop the margin-budget filter

  useEffect(() => {
    if (!query.trim() || target) { setSuggestions([]); return; }
    const t = setTimeout(() => {
      api.searchScrip(query.trim())
        .then(r => setSuggestions((r || []).filter(s => s.segment === "EQUITY" || s.segment === "INDEX").slice(0, 6)))
        .catch(() => {});
    }, 300);
    return () => clearTimeout(t);
  }, [query, target]);

  // Load selectable expiries as soon as a target script is picked.
  useEffect(() => {
    setExpiries([]); setExpiryTs("");
    if (!target) return;
    api.rollExpiries(target.symbol).then(r => setExpiries(r || [])).catch(() => {});
  }, [target]);

  useEffect(() => () => pollRef.current && clearInterval(pollRef.current), []);

  async function runScan() {
    setScanning(true); setError(null); setScan(null); setPicked(null);
    const bothLevels = +safeCe > 0 && +safePe > 0;
    try {
      setScan(await api.rollScan(strategy.id, {
        target: target.symbol, expiry_ts: +expiryTs, include_itm: includeItm,
        safe_ce_level: bothLevels ? +safeCe : null, safe_pe_level: bothLevels ? +safePe : null,
        roi_floor_override: overrideRoi && +customRoi > 0 ? +customRoi : null,
        ignore_margin: ignoreMargin,
      }));
    } catch (err) { setError(err.message); }
    finally { setScanning(false); }
  }
  // Safe levels are optional — with neither, only short strangles are scanned.
  const canScan = target && +expiryTs > 0 && !scanning;

  async function execute() {
    setError(null);
    try {
      const { job_id } = await api.rollExecute(strategy.id, {
        entry_legs: picked.entry_legs, lots: +lots, broker,
        new_name: `${picked.underlying.split(":")[1]?.replace("-INDEX", "") || picked.underlying} ${picked.type} (rolled)`,
      });
      pollRef.current = setInterval(async () => {
        try {
          const j = await api.rollStatus(job_id);
          setJob(j);
          if (["DONE", "FAILED", "STALLED"].includes(j.phase)) {
            clearInterval(pollRef.current); pollRef.current = null;
            onRolled?.();
          }
        } catch { /* poll again */ }
      }, 4000);
      setJob({ phase: "EXITING", detail: "starting…" });
    } catch (err) { setError(err.message); }
  }

  const estMargin = picked ? picked.real_margin * lots : null;
  const overBudget = scan && estMargin != null && estMargin > scan.margin_budget;

  return (
    <div className="mt-2 bg-gray-900/60 border border-gray-700 rounded p-3 text-xs space-y-2">
      <div className="flex items-center gap-3 flex-wrap">
        <span className="font-semibold text-amber-300">⟳ Roll strategy</span>
        <span className="text-gray-400">needs ROI ≥ <span className="text-gray-200">{strategy.roi_pct != null ? strategy.roi_pct + "%" : "—"}</span> within margin ₹<span className="text-gray-200">{strategy.margin ? Math.round(strategy.margin).toLocaleString("en-IN") : "—"}</span></span>
        <button onClick={onClose} className="ml-auto text-gray-400 hover:text-gray-200">Close</button>
      </div>

      {!job && (
        <div className="flex flex-wrap items-end gap-2 border-b border-gray-800 pb-2">
          <div className="relative">
            <label className="block text-[10px] text-gray-500 mb-0.5">Target script</label>
            {target ? (
              <span className="inline-flex items-center gap-1.5 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200">
                {target.symbol}
                <button onClick={() => { setTarget(null); setQuery(""); setScan(null); setPicked(null); }} className="text-gray-500 hover:text-red-400">×</button>
              </span>
            ) : (
              <>
                <input value={query} onChange={e => setQuery(e.target.value)}
                  placeholder="Search script e.g. RELIANCE" className="input-field text-xs w-48" />
                {suggestions.length > 0 && (
                  <div className="absolute z-10 mt-1 w-64 bg-gray-800 border border-gray-700 rounded shadow-lg">
                    {suggestions.map(s => (
                      <button key={s.symbol} onClick={() => { setTarget(s); setSuggestions([]); }}
                        className="block w-full text-left px-2 py-1 hover:bg-gray-700 text-gray-200">
                        {s.symbol} <span className="text-gray-500">{s.symbol_desc}</span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <label className="block text-[10px] text-gray-500">Expiry
            <select value={expiryTs} onChange={e => setExpiryTs(e.target.value)} disabled={!target}
              className="input-field text-xs w-40 block mt-0.5 disabled:opacity-50">
              <option value="">{target ? (expiries.length ? "Select expiry…" : "Loading…") : "Pick a script first"}</option>
              {expiries.map(x => <option key={x.expiry_ts} value={x.expiry_ts}>{x.date} ({x.days}d)</option>)}
            </select></label>
          <label className="block text-[10px] text-gray-500">Safe CE level <span className="text-gray-600">(optional)</span>
            <input type="number" value={safeCe} onChange={e => setSafeCe(e.target.value)} placeholder="e.g. 59844"
              className="input-field text-xs w-28 block mt-0.5" /></label>
          <label className="block text-[10px] text-gray-500">Safe PE level <span className="text-gray-600">(optional)</span>
            <input type="number" value={safePe} onChange={e => setSafePe(e.target.value)} placeholder="e.g. 55768"
              className="input-field text-xs w-28 block mt-0.5" /></label>
          <label className="flex items-center gap-1 text-[11px] text-gray-400 select-none cursor-pointer" title="Also scan in-the-money strikes for strangles (default is OTM/ATM only)">
            <input type="checkbox" checked={includeItm} onChange={e => setIncludeItm(e.target.checked)} /> Include ITM
          </label>
          <label className="flex items-center gap-1 text-[11px] text-gray-400 select-none cursor-pointer" title="Set your own target ROI floor instead of the exiting strategy's live ROI">
            <input type="checkbox" checked={overrideRoi} onChange={e => setOverrideRoi(e.target.checked)} /> Set ROI
          </label>
          {overrideRoi && (
            <input type="number" value={customRoi} onChange={e => setCustomRoi(e.target.value)} placeholder={`${strategy.roi_pct ?? ""}`}
              title="Target ROI % p.a." className="input-field text-xs w-20" />
          )}
          <label className="flex items-center gap-1 text-[11px] text-gray-400 select-none cursor-pointer" title="Scan even candidates whose margin exceeds the released budget (they'll show over-budget)">
            <input type="checkbox" checked={ignoreMargin} onChange={e => setIgnoreMargin(e.target.checked)} /> Ignore margin
          </label>
          <button onClick={runScan} disabled={!canScan}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded font-medium">
            {scanning ? "Scanning…" : "Scan"}
          </button>
          <span className="text-gray-600 text-[10px]">Safe levels enable spreads + a safe strangle; leave both blank to scan short strangles only.</span>
        </div>
      )}

      {scanning && <p className="text-gray-400">Scanning {target?.symbol} at the chosen expiry + pricing real margins… takes about a minute.</p>}
      {error && <p className="text-red-400">{error}</p>}

      {scan && !job && (
        scan.candidates.length === 0 ? (
          <div className="text-gray-500 space-y-1">
            <p>Nothing in {scan.target} {scan.expiry_date}{scan.have_safe && <> (snapped strikes {scan.pe_strike}PE / {scan.ce_strike}CE)</>} qualified.</p>
            {(() => {
              const d = scan.diag || {};
              if (!d.priced) return <p>No candidates could be priced — the scanner found nothing at/above your {scan.roi_floor}% ROI floor to price.</p>;
              const marginBlocked = d.rejected_margin > 0 && d.cheapest_margin > scan.margin_budget * 0.98;
              return <>
                {marginBlocked && (
                  <p className="text-amber-400">
                    ⚠ Margin is the blocker: cheapest candidate needs ₹{d.cheapest_margin.toLocaleString("en-IN")} for one lot, but your released budget is only ₹{Math.round(scan.margin_budget).toLocaleString("en-IN")}. {scan.target} simply costs more margin than this strategy frees up — Include ITM won't help. Roll into a lower-margin script instead.
                  </p>
                )}
                {!marginBlocked && d.best_roi_in_budget != null && (<>
                  <p>Best ROI {scan.ignore_margin ? "found" : "that fit your budget"} was <span className="text-gray-300">{d.best_roi_in_budget}%</span>, under your <span className="text-gray-300">{scan.roi_floor}%</span> floor{scan.roi_floor_overridden ? "" : " (the exiting strategy's live ROI — near expiry that figure is annualization-inflated and hard to beat)"}.</p>
                  {!scan.have_safe && (
                    <p className="text-amber-400">Only short strangles were scanned (no safe levels). Enter Safe CE/PE levels to also try a safe strangle + credit spreads at your strikes — those often clear a high floor when strangles can't.</p>
                  )}
                  {!scan.roi_floor_overridden && (
                    <p className="text-amber-400">Or tick <span className="text-gray-200">Set ROI</span> and enter a realistic target (e.g. below {d.best_roi_in_budget}%) to surface the candidates just under this inflated floor.</p>
                  )}
                </>)}
                <p className="text-gray-600 text-[11px]">Priced {d.priced} · rejected {d.rejected_margin} on margin, {d.rejected_roi} on ROI.</p>
              </>;
            })()}
            <p>Try another script, expiry{!scan.include_itm && <>, or Include ITM</>}. <button onClick={runScan} className="text-blue-300 hover:underline">Rescan</button></p>
          </div>
        ) : (
          <>
            <p className="text-[11px] text-gray-500">
              {scan.target} {scan.expiry_date}
              {scan.have_safe
                ? <> · safe levels {scan.safe_ce_level}CE → strike <span className="text-gray-300">{scan.ce_strike}</span>, {scan.safe_pe_level}PE → strike <span className="text-gray-300">{scan.pe_strike}</span></>
                : <> · short strangles only (no safe levels entered)</>}
              {scan.include_itm && <> · incl. ITM</>} · sorted lowest → highest ROI
            </p>
            <table className="w-full text-[11px]">
              <thead><tr className="text-gray-500">
                <th className="text-left py-1">Pick</th><th className="text-left">Type</th><th className="text-left">Underlying</th>
                <th className="text-right px-1">Expiry</th><th className="text-right px-1">Strikes</th>
                <th className="text-right px-1">Prem/lot</th><th className="text-right px-1">Margin/lot</th><th className="text-right px-1">ROI p.a.</th>
              </tr></thead>
              <tbody>
                {scan.candidates.map((c, i) => (
                  <tr key={i} onClick={() => setPicked(c)}
                    className={`border-t border-gray-800/50 cursor-pointer ${picked === c ? "bg-blue-900/30" : "hover:bg-gray-800/40"}`}>
                    <td className="py-1">{picked === c ? "●" : "○"}</td>
                    <td className={c.type.includes("Spread") ? "text-purple-300" : c.type === "Safe Strangle" ? "text-green-300" : "text-gray-300"}>
                      {c.type}
                      {c.type === "Short Strangle" && c.safe && (
                        <span title="Both legs at or beyond your safe CE/PE levels" className="ml-1 text-[9px] text-green-400 border border-green-800 bg-green-900/20 rounded px-1">SAFE</span>
                      )}
                    </td>
                    <td className="text-gray-200 font-medium">{c.underlying.split(":")[1]?.replace("-INDEX", "")}</td>
                    <td className="text-right px-1 text-gray-400">{c.expiry_date} ({c.days_to_expiry}d)</td>
                    <td className="text-right px-1 text-gray-300">
                      {c.type.includes("Spread")
                        ? <>S {c.ce_strike ?? c.pe_strike}{c.type.startsWith("CE") ? "CE" : "PE"} / B {c.buy_strike} <span className="text-gray-500">(w{c.width})</span></>
                        : <>{c.pe_strike}PE / {c.ce_strike}CE</>}
                    </td>
                    <td className="text-right px-1 text-gray-300">₹{Math.round(c.premium_money).toLocaleString("en-IN")}</td>
                    {(() => {
                      const mult = c.real_margin / scan.margin_budget;
                      const over = mult > 1;
                      return (
                        <td className={`text-right px-1 ${over ? "text-amber-400" : "text-gray-300"}`}
                          title={over ? `${mult.toFixed(1)}× your ₹${Math.round(scan.margin_budget).toLocaleString("en-IN")} budget` : ""}>
                          ₹{Math.round(c.real_margin).toLocaleString("en-IN")}{over && <span className="text-[9px] ml-0.5">{mult.toFixed(1)}×</span>}
                        </td>
                      );
                    })()}
                    <td className="text-right px-1 font-semibold text-green-400">{c.real_roi_pct}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {picked && (
              <div className="flex flex-wrap items-center gap-2 border-t border-gray-800 pt-2">
                <label className="text-gray-400">Lots <input type="number" min={1} value={lots} onChange={e => setLots(e.target.value)} className="input-field text-xs w-16 ml-1" /></label>
                <select value={broker} onChange={e => setBroker(e.target.value)} className="input-field text-xs w-24">
                  {["shoonya", "fyers", "zerodha"].map(b => <option key={b}>{b}</option>)}
                </select>
                <span className={overBudget ? "text-red-400 font-semibold" : "text-gray-400"}>
                  est. margin ₹{Math.round(estMargin).toLocaleString("en-IN")} of ₹{Math.round(scan.margin_budget).toLocaleString("en-IN")}
                  {overBudget && (scan.ignore_margin ? " — OVER BUDGET (margin ignored — entry may be rejected for funds)" : " — OVER BUDGET")}
                </span>
                <button onClick={execute} disabled={overBudget && !scan.ignore_margin}
                  className="px-3 py-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded font-semibold"
                  title="REAL orders: places limit exits on this strategy, waits until flat, then enters the new strategy">
                  Confirm Roll — exit "{strategy.name}" & enter {picked.type}
                </button>
              </div>
            )}
          </>
        )
      )}

      {job && (
        <div className={`rounded p-2 border ${job.phase === "DONE" ? "bg-green-900/20 border-green-800" : job.phase === "FAILED" || job.phase === "STALLED" ? "bg-red-900/20 border-red-800" : "bg-yellow-900/20 border-yellow-800"}`}>
          <p className="font-semibold">
            {job.phase === "EXITING" && "⏳ Exiting — limit orders at bid/ask, waiting for fills…"}
            {job.phase === "ENTERING" && "⏳ Exits flat — placing new strategy…"}
            {job.phase === "DONE" && <>✓ Roll complete — new strategy #{job.new_strategy_id} live. </>}
            {job.phase === "STALLED" && "⚠ STALLED — exits didn't fill in time; NO entry was placed. Manage at the broker."}
            {job.phase === "FAILED" && `✗ Roll failed: ${job.error}`}
          </p>
          <p className="text-gray-400 mt-0.5">{job.detail}</p>
        </div>
      )}
    </div>
  );
}

// Shift a whole leg (all its orders → entry, realized, timestamps, pending) into another strategy.
function MoveLegPanel({ strategy, leg, strategyNames, onDone, onCancel }) {
  const targets = strategyNames.filter(s => s.id !== strategy.id);
  const [toId, setToId] = useState(targets[0]?.id || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const parsed = parseLeg(leg.symbol);
  const label = parsed.kind === "option" ? `${parsed.strike} ${parsed.type === "CE" ? "CALL" : "PUT"}`
    : parsed.kind === "future" ? "Futures" : leg.symbol;

  async function move() {
    if (!toId) return;
    setBusy(true); setError(null);
    try { await api.moveLeg(strategy.id, leg.symbol, +toId); onDone(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="bg-gray-900/70 border border-blue-900/50 rounded p-3 text-xs">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-gray-300 font-medium">Move leg <span className="text-gray-100">{label}</span> to another strategy</span>
        <button onClick={onCancel} className="text-gray-500 hover:text-gray-300">Cancel</button>
      </div>
      <p className="text-[11px] text-gray-500 mb-2">
        Takes everything with it — entry ₹{leg.entry ?? "—"}, realized {leg.realized != null ? `₹${leg.realized.toFixed(0)}` : "—"}, all buys/sells & timestamps, and any pending orders. The destination auto-nets if it already holds {label}.
      </p>
      {targets.length === 0 ? (
        <p className="text-yellow-400">No other open strategy to move into — create one first.</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-gray-400">Into:</span>
          <select value={toId} onChange={e => setToId(e.target.value)} className="input-field text-xs w-56">
            {targets.map(s => <option key={s.id} value={s.id}>{s.name} (#{s.id})</option>)}
          </select>
          <button onClick={move} disabled={busy || !toId}
            className="px-3 py-1 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded font-medium">
            {busy ? "Moving…" : "Move leg"}
          </button>
          {error && <span className="text-red-400 w-full">{error}</span>}
        </div>
      )}
    </div>
  );
}

function StrategyCard({ strategy, strategyNames, onClose, onLegChanged, bulletinMatches, defaultLegsOpen = false, onSendToBuilder, greeks: greeksProp, onSelectUnderlying, underlyingSelected }) {
  const pnl = strategy.total_pl;
  const [exitingLegId, setExitingLegId] = useState(null);
  const [movingLegId, setMovingLegId] = useState(null);
  const [showAddLeg, setShowAddLeg] = useState(false);
  const [showBulletin, setShowBulletin] = useState(false);
  const [showChart, setShowChart] = useState(false);
  const [showRoll, setShowRoll] = useState(false);
  const [showPayoff, setShowPayoff] = useState(false);
  const [showWhatIf, setShowWhatIf] = useState(false);
  const [showLegs, setShowLegs] = useState(defaultLegsOpen);
  const [squareOff, setSquareOff] = useState({ confirming: false, busy: false, result: null, error: null });

  const dte = daysToExpiry(strategy.expiry);
  const stratType = useMemo(() => detectStrategyType(strategy.legs), [strategy.legs]);
  // Prefer the greeks computed once by the parent (shared across cards + aggregate); only compute
  // locally as a fallback (e.g. the closed-strategies list, which passes none).
  const localGreeks = useMemo(() => (greeksProp === undefined ? strategyGreeks(strategy) : null), [strategy, greeksProp]);
  const greeks = greeksProp !== undefined ? greeksProp : localGreeks;
  const timeValue = useMemo(() => strategyTimeValue(strategy), [strategy]);
  const tte = yearsToExpiry(strategy.expiry);
  const returnPct = strategy.margin ? (pnl / strategy.margin) * 100 : null; // MTM vs margin

  // "Earned ROI so far" (annualized): exit-realistic P&L earned (entry premium collected − premium
  // to close now at current bid/ask, i.e. total_pl) ÷ current margin, annualized over the days held
  // from the earliest leg entry to today (today NOT counted). ROI% = pnl/margin × 365/days × 100.
  const earnedRoi = useMemo(() => {
    if (pnl == null || !strategy.margin) return null;
    const dates = strategy.legs.map(l => l.created_at).filter(Boolean).map(d => d.slice(0, 10));
    if (dates.length === 0) return null;
    const entry = new Date(dates.sort()[0] + "T00:00:00");
    const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00");
    const days = Math.round((today - entry) / 86400000); // whole days entry→today, excludes today
    if (days < 1) return null;                            // same-day: no full day elapsed yet
    return { roi: (pnl / strategy.margin) * (365 / days) * 100, days };
  }, [pnl, strategy.margin, strategy.legs]);

  // Legs mapped for the payoff diagram — entry premium (avg_price) drives the curve.
  const payoffLegs = useMemo(() => strategy.legs.filter(l => l.qty > 0).map(l => ({
    symbol: l.symbol, side: l.side, quantity: l.qty, limit_price: l.entry || 0,
  })), [strategy.legs]);
  const hasFuture = strategy.legs.some(l => parseLeg(l.symbol).kind === "future");

  async function doSquareOff() {
    setSquareOff(s => ({ ...s, busy: true, error: null }));
    try {
      const result = await api.squareOffStrategy(strategy.id);
      setSquareOff({ confirming: false, busy: false, result, error: null });
      onLegChanged?.();
    } catch (err) {
      setSquareOff(s => ({ ...s, busy: false, error: err.message }));
    }
  }

  async function cancelPending(id) {
    if (!confirm("Cancel this pending order at the broker?")) return;
    try {
      await api.cancelOrder(id);
      onLegChanged?.();
    } catch (err) {
      alert(err.message);
    }
  }

  const legSummary = strategy.legs.map(l => {
    const p = parseLeg(l.symbol);
    const tag = p.kind === "future" ? "FUT" : `${p.strike}${p.type}`;
    return `${l.side === "BUY" ? "B" : "S"} ${tag}`;
  }).join(" · ");

  return (
    <div className="bg-gray-800/50 border border-gray-800 rounded-xl p-4 min-w-0">
      <div className="flex justify-between items-start gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-indigo-300 bg-indigo-900/40 border border-indigo-800 rounded px-2 py-0.5">{stratType}</span>
            {strategy.underlying && (onSelectUnderlying ? (
              <button onClick={() => onSelectUnderlying(strategy.underlying)}
                title={`Combined breakeven & payoff across all open ${strategy.underlying} strategies`}
                className={`text-lg font-semibold underline decoration-dotted underline-offset-4 ${underlyingSelected ? "text-amber-300 decoration-amber-400" : "text-white decoration-gray-600 hover:text-amber-200"}`}>
                {strategy.underlying}
              </button>
            ) : <span className="text-lg font-semibold text-white">{strategy.underlying}</span>)}
            <span className="text-sm text-gray-400">{strategy.name}</span>
            {bulletinMatches?.length > 0 && (
              <button onClick={() => setShowBulletin(b => !b)}
                className="text-xs font-normal text-yellow-400 bg-yellow-900/30 border border-yellow-800/60 rounded px-2 py-0.5">
                ⚠ {bulletinMatches.length} bulletin {bulletinMatches.length === 1 ? "notice" : "notices"}
              </button>
            )}
          </div>
          <div className="flex items-center gap-x-3 gap-y-1 flex-wrap mt-1.5 text-xs text-gray-500">
            <span>#{strategy.id} · {strategy.status} · {fmtDateTime(strategy.created_at)}</span>
            {strategy.expiry && <span>expiry <span className="text-gray-300">{strategy.expiry}</span></span>}
            {dte != null && strategy.status === "OPEN" && (
              <span className={`px-2 py-0.5 rounded font-semibold ${
                dte <= 1 ? "bg-red-900/40 text-red-400" : dte <= 3 ? "bg-orange-900/40 text-orange-400" : "bg-gray-800 text-gray-400"
              }`}>
                {dte <= 0 ? "expires today" : dte === 1 ? "1d to expiry" : `${dte}d to expiry`}
              </span>
            )}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className={`text-xl font-semibold ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
            {pnl >= 0 ? "+" : ""}₹{pnl.toFixed(2)}
          </div>
          {returnPct != null && (
            <div className="w-28 ml-auto mt-1" title={`Mark-to-market P&L as ${returnPct.toFixed(2)}% of margin`}>
              <div className="h-1 bg-gray-700 rounded overflow-hidden flex">
                <div className="w-1/2 flex justify-end">
                  {returnPct < 0 && <div className="h-full bg-red-500" style={{ width: `${Math.min(Math.abs(returnPct) * 5, 100)}%` }} />}
                </div>
                <div className="w-1/2">
                  {returnPct >= 0 && <div className="h-full bg-green-500" style={{ width: `${Math.min(returnPct * 5, 100)}%` }} />}
                </div>
              </div>
              <p className="text-[11px] text-gray-500 text-right mt-0.5">{returnPct >= 0 ? "+" : ""}{returnPct.toFixed(1)}% of margin</p>
            </div>
          )}
        </div>
      </div>

      {strategy.earnings_event && (() => {
        const e = strategy.earnings_event, d = e.days_away;
        const when = d === 0 ? "TODAY" : d === 1 ? "TOMORROW" : `in ${d} days`;
        const urgent = d <= 1;
        return (
          <div className={`mt-3 flex flex-wrap items-center gap-2 rounded px-3 py-1.5 text-xs border ${
            urgent ? "bg-red-900/25 border-red-800 text-red-200" : "bg-amber-900/20 border-amber-800 text-amber-200"}`}
            title={e.desc || e.purpose}>
            <span className="font-semibold">📅 {e.purpose || "Financial Results"} {when}</span>
            <span className="text-gray-400">{e.company || e.symbol} · {e.date}</span>
            <span className="text-gray-500">— event risk on this underlying; expect a volatility move.</span>
          </div>
        );
      })()}

      <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-2 mt-3">
        {strategy.spot != null && <StatTile label="Spot" value={strategy.spot} />}
        <StatTile label="Margin" value={strategy.margin != null ? fmtLakh(strategy.margin) : "—"} />
        {strategy.realized_total ? <StatTile label="Realized" value={`${strategy.realized_total >= 0 ? "+" : ""}₹${strategy.realized_total.toFixed(0)}`} tone={strategy.realized_total} /> : null}
        {strategy.roi_pct != null && <StatTile label="Live ROI" sub="p.a." value={`${strategy.roi_pct}%`} tone={strategy.roi_pct}
          title="Forward return if held to expiry with all options expiring worthless, priced on CLOSE-OUT marks (short at the ask, long at the bid — the prices you'd actually transact to unwind), annualized." />}
        {strategy.entry_roi_pct != null && <StatTile label="Entry ROI" sub="p.a." value={`${strategy.entry_roi_pct}%`} tone={strategy.entry_roi_pct}
          title="Same decay-to-0 return but locked in at ENTRY prices, annualized." />}
        {greeks && <StatTile label="Net delta" value={GREEK_FMT(greeks.delta, 0)} />}
        {greeks && <StatTile label="Theta / day" value={GREEK_FMT(greeks.theta, 0)} tone={greeks.theta} />}
        {earnedRoi && <StatTile label="Earned ROI" sub="p.a." value={`${earnedRoi.roi >= 0 ? "+" : ""}${earnedRoi.roi.toFixed(1)}%`} tone={earnedRoi.roi}
          title={`Annualized return actually EARNED so far. = P&L earned ÷ current margin, annualized over days held. Numerator = entry premium collected − premium to close now at current bid/ask = ₹${Math.round(pnl).toLocaleString("en-IN")}. Margin ₹${Math.round(strategy.margin).toLocaleString("en-IN")}. Days = ${earnedRoi.days} (earliest entry → today, today not counted). Realized-to-date return, vs Live/Entry ROI which are best-case forward figures.`} />}
        {timeValue != null && <StatTile label="Time value" sub="decay left" value={`${timeValue >= 0 ? "+" : ""}₹${Math.round(timeValue).toLocaleString("en-IN")}`} tone={timeValue}
          title="Net extrinsic (time) value of the open legs — the ceiling on remaining theta profit; the part of premium that decays. Intrinsic value is excluded (it doesn't decay)." />}
        {greeks && strategy.margin ? (() => {
          const carryRoi = greeks.theta / strategy.margin * 365 * 100; // annualized "if nothing moves" carry
          return <StatTile label="θ-ROI" sub="carry p.a." value={`${carryRoi >= 0 ? "+" : ""}${carryRoi.toFixed(0)}%`} tone={carryRoi}
            title={`Theta ÷ margin, annualized — the return from pure time decay if spot & IV freeze (direction-neutral). Compare to Live ROI${strategy.roi_pct != null ? ` (${strategy.roi_pct}%)` : ""}: near it ⇒ earned by waiting (theta harvest); well below ⇒ most of Live ROI is intrinsic, a directional bet. Ignores delta/gamma/vega risk.`} />;
        })() : null}
        {greeks && <StatTile label="Vega" value={GREEK_FMT(greeks.vega, 0)} />}
        <VolatilityTile root={strategy.underlying} />
      </div>

      <div className="flex items-center gap-2 flex-wrap mt-3">
        <div className="flex items-center gap-2 flex-wrap">
            <button onClick={() => setShowPayoff(p => !p)}
              className="text-xs text-blue-300 hover:text-blue-200 border border-gray-700 rounded px-3 py-1">Payoff</button>
            <button onClick={() => setShowChart(c => !c)}
              className="text-xs text-blue-300 hover:text-blue-200 border border-gray-700 rounded px-3 py-1">
              {showChart ? "Hide chart" : "P&L chart"}
            </button>
            {strategy.status === "OPEN" && (
              <>
                <button onClick={() => setShowAddLeg(v => !v)}
                  className="text-xs text-green-300 hover:text-green-200 border border-green-900 bg-green-900/15 rounded px-3 py-1">
                  + Add leg
                </button>
                <button onClick={() => setSquareOff(s => ({ ...s, confirming: !s.confirming, error: null }))}
                  className="text-xs text-red-300 hover:text-red-200 border border-red-900 bg-red-900/20 rounded px-3 py-1">
                  Square off
                </button>
                <button onClick={() => setShowRoll(v => !v)}
                  title="Exit this strategy and redeploy its margin into a better-ROI candidate from the scanners"
                  className="text-xs text-amber-300 hover:text-amber-200 border border-yellow-800 bg-yellow-900/20 rounded px-3 py-1">
                  ⟳ Roll…
                </button>
                <button onClick={() => onClose(strategy.id)}
                  title="Marks the strategy closed in tracking only — does NOT exit broker positions"
                  className="text-xs text-gray-400 hover:text-red-400 border border-gray-700 rounded px-3 py-1">
                  Archive
                </button>
              </>
            )}
        </div>
      </div>

      {strategy.status === "OPEN" && <AutoExitControl strategy={strategy} onChanged={onLegChanged} />}

      {showRoll && strategy.status === "OPEN" && (
        <RollPanel strategy={strategy} onClose={() => setShowRoll(false)} onRolled={onLegChanged} />
      )}

      {showAddLeg && strategy.status === "OPEN" && (
        <div className="mt-2">
          <AddLegPanel strategy={strategy} onDone={() => { setShowAddLeg(false); onLegChanged(); }} onCancel={() => setShowAddLeg(false)} />
        </div>
      )}

      <NotesEditor strategy={strategy} onSaved={onLegChanged} />

      {showPayoff && (
        <div className="mb-2 mt-2">
          <PayoffPanel legs={payoffLegs} realized={strategy.realized_total || 0} />
          {strategy.realized_total ? <p className="text-[10px] text-gray-600 mt-1">Curve includes ₹{Math.round(strategy.realized_total).toLocaleString("en-IN")} realized from closed legs (shifts breakeven & max P&L).</p> : null}
          {hasFuture && <p className="text-[10px] text-gray-600 mt-1">Payoff includes the future leg's linear P&L (at its entry price) alongside the option legs.</p>}
          {strategy.status === "OPEN" && (
            !showWhatIf ? (
              <button onClick={() => setShowWhatIf(true)}
                className="mt-2 text-xs text-indigo-300 hover:text-indigo-200 border border-indigo-900/60 bg-indigo-900/10 rounded px-3 py-1">
                🔬 What-if: add a trial leg
              </button>
            ) : (
              <WhatIfPayoff strategy={strategy} onSendToBuilder={onSendToBuilder} />
            )
          )}
        </div>
      )}
      {squareOff.confirming && (
        <div className="bg-red-900/20 border border-red-800 rounded p-2 mb-2 text-xs">
          <p className="text-red-300 font-medium">
            Square off "{strategy.name}"? This places REAL market orders closing all {strategy.legs.length} leg{strategy.legs.length > 1 ? "s" : ""} immediately.
          </p>
          <div className="flex gap-2 mt-1.5">
            <button onClick={doSquareOff} disabled={squareOff.busy}
              className="px-3 py-1 bg-red-600 hover:bg-red-700 disabled:opacity-50 rounded font-semibold">
              {squareOff.busy ? "Placing orders…" : "Confirm Square Off"}
            </button>
            <button onClick={() => setSquareOff(s => ({ ...s, confirming: false }))} className="text-gray-400 hover:text-gray-200">Cancel</button>
          </div>
          {squareOff.error && <p className="text-red-400 mt-1">{squareOff.error}</p>}
        </div>
      )}
      {squareOff.result && (
        <div className={`border rounded p-2 mb-2 text-xs ${squareOff.result.closed ? "bg-green-900/20 border-green-800" : "bg-red-900/20 border-red-800"}`}>
          <p className={squareOff.result.closed ? "text-green-400 font-medium" : "text-red-400 font-medium"}>
            {squareOff.result.closed ? "All legs squared off — strategy closed." : "Some close orders FAILED — positions may still be live, check the broker!"}
          </p>
          {squareOff.result.legs.map((l, i) => (
            <p key={i} className="text-gray-400">
              {l.symbol}: {l.side} {l.ok ? `✓ order ${l.order_id}` : `✗ ${l.message || "failed"}`}
            </p>
          ))}
        </div>
      )}
      {showChart && <PnlSparkline strategyId={strategy.id} />}
      {showBulletin && bulletinMatches?.length > 0 && (
        <div className="bg-yellow-900/10 border border-yellow-800/40 rounded p-2 mb-2 space-y-1.5">
          {bulletinMatches.map((m, i) => (
            <div key={i} className="text-xs">
              <a href={m.link} target="_blank" rel="noopener noreferrer" className="text-yellow-200 hover:underline font-medium">
                {m.title}
              </a>
              <span className="text-gray-500"> — {m.pubdate ? new Date(m.pubdate).toLocaleDateString() : ""}</span>
            </div>
          ))}
        </div>
      )}
      {strategy.pending_orders?.length > 0 && (
        <div className="mt-2 bg-yellow-900/10 border border-yellow-800/40 rounded p-2">
          <p className="text-[11px] font-semibold text-yellow-300 mb-1">
            ⏳ {strategy.pending_orders.length} pending order{strategy.pending_orders.length !== 1 ? "s" : ""} — merges into the position once filled
          </p>
          {strategy.pending_orders.map(p => {
            const parsed = parseLeg(p.symbol);
            const label = parsed.kind === "future" ? "Futures" : parsed.kind === "option" ? `${parsed.strike} ${parsed.type === "CE" ? "CALL" : "PUT"}` : p.symbol;
            return (
              <PendingOrderRow key={p.id} order={p} label={label}
                onChanged={(action, id) => { if (action === "cancel") cancelPending(id); else onLegChanged(); }} />
            );
          })}
        </div>
      )}

      <button onClick={() => setShowLegs(v => !v)}
        className="w-full text-left text-xs text-gray-400 hover:text-gray-200 flex items-center gap-1.5 py-1.5 mt-1 border-t border-gray-800/60">
        <span className="text-gray-600">{showLegs ? "▾" : "▸"}</span>
        {strategy.legs.length} leg{strategy.legs.length !== 1 ? "s" : ""}
        {!showLegs && <span className="text-gray-600 truncate">· {legSummary}</span>}
      </button>
      {showLegs && (
      <div className="overflow-x-auto">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="text-gray-500">
            {/* On phones only the essentials show (Contract/Side/Qty/LTP/P&L/actions); the rest
                reveal at ≥sm. The table can still scroll sideways if the essentials don't fit. */}
            <th className="hidden sm:table-cell text-left px-2 py-1.5 font-normal">Broker</th>
            <th className="text-left px-2 py-1.5 font-normal">Contract</th>
            <th className="text-left px-2 py-1.5 font-normal">Side</th>
            <th className="text-right px-2 py-1.5 font-normal">Qty</th>
            <th className="text-right px-2 py-1.5 font-normal">LTP</th>
            <th className="hidden sm:table-cell text-right px-2 py-1.5 font-normal">Entry</th>
            <th className="hidden sm:table-cell text-right px-2 py-1.5 font-normal">Bid</th>
            <th className="hidden sm:table-cell text-right px-2 py-1.5 font-normal">Ask</th>
            <th className="hidden sm:table-cell text-right px-2 py-1.5 font-normal" title="Moneyness vs spot">Money</th>
            <th className="hidden sm:table-cell text-right px-2 py-1.5 font-normal" title="Per-leg delta (signed by side/qty)">Δ</th>
            <th className="text-right px-2 py-1.5 font-normal">P&L</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {strategy.legs.map(leg => {
            const quotesStale = !leg.bid && !leg.ask;
            const parsed = parseLeg(leg.symbol);
            const mny = moneyness(parsed, strategy.spot);
            const g = legGreeks(leg, strategy.spot, tte);
            const closed = leg.qty === 0;   // fully offset — realized only, no open position
            return (
            <Fragment key={leg.symbol}>
              <tr className={`border-t border-gray-800/50 ${closed ? "opacity-60" : ""}`}>
                <td className="hidden sm:table-cell py-2 px-2 text-[11px] text-gray-500 uppercase">{leg.broker || "fyers"}</td>
                <td className="py-2 px-2 text-gray-200 whitespace-nowrap" title={leg.symbol}>
                  {parsed.kind === "future" ? (
                    <span className="font-medium text-orange-300">
                      Futures <span className="ml-0.5 text-[9px] text-orange-300 bg-orange-900/40 rounded px-1 align-middle">FUT</span>
                    </span>
                  ) : parsed.kind === "option" ? (
                    <span>
                      <span className="font-semibold text-gray-100">{parsed.strike}</span>
                      <span className={`ml-1 text-[9px] rounded px-1 align-middle ${
                        parsed.type === "CE" ? "bg-green-900/40 text-green-300" : "bg-pink-900/40 text-pink-300"}`}>
                        {parsed.type === "CE" ? "CALL" : "PUT"}
                      </span>
                    </span>
                  ) : (
                    <span className="text-gray-300">{leg.symbol}</span>
                  )}
                </td>
                <td className={`px-2 py-2 font-medium ${closed ? "text-gray-500" : leg.side === "BUY" ? "text-green-400" : "text-red-400"}`}>
                  {closed ? "CLOSED" : leg.side}
                </td>
                <td className="text-right px-2 py-2 text-gray-300" title={`Net position: bought ${leg.buy_qty}, sold ${leg.sell_qty}`}>
                  {closed ? "—" : leg.qty}
                </td>
                <td className="text-right px-2 py-2 text-gray-300">{leg.ltp ?? "-"}</td>
                <td className="hidden sm:table-cell text-right px-2 py-2 text-gray-500" title="Net entry price of the open position (average of the residual side)">
                  {leg.entry != null ? leg.entry : "—"}
                </td>
                {quotesStale ? (
                  <td colSpan={2} className="hidden sm:table-cell text-right px-2 py-2 text-gray-500" title="No live quotes (market closed) — showing last traded price">
                    {leg.ltp != null ? "stale" : "-"}
                  </td>
                ) : (
                  <>
                    <td className="hidden sm:table-cell text-right px-2 py-2 text-gray-300">{leg.bid ?? "-"}</td>
                    <td className="hidden sm:table-cell text-right px-2 py-2 text-gray-300">{leg.ask ?? "-"}</td>
                  </>
                )}
                <td className="hidden sm:table-cell text-right px-2 py-2">
                  {mny ? (
                    <span className={mny.state === "ITM" ? "text-red-400" : mny.state === "ATM" ? "text-yellow-400" : "text-gray-500"}
                      title={`Spot is ${mny.distPct >= 0 ? "+" : ""}${mny.distPct.toFixed(1)}% vs strike`}>
                      {mny.state}
                    </span>
                  ) : <span className="text-gray-600">—</span>}
                </td>
                <td className="hidden sm:table-cell text-right px-2 py-2 text-gray-400">{g ? GREEK_FMT(g.delta, 0) : "—"}</td>
                <td className={`text-right px-2 py-2 font-medium ${(leg.pl || 0) >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {closed ? <span className="text-gray-500">—</span> : <>{leg.pl >= 0 ? "+" : ""}{leg.pl?.toFixed(2)}</>}
                  {leg.realized ? (
                    <span className="block text-[10px] font-normal text-gray-500" title="Realized P&L booked from the offsetting (closed) quantity on this symbol">
                      realized {leg.realized >= 0 ? "+" : ""}{leg.realized.toFixed(2)}
                    </span>
                  ) : null}
                </td>
                <td className="text-right px-2 py-2 whitespace-nowrap">
                  <button onClick={() => setMovingLegId(movingLegId === leg.symbol ? null : leg.symbol)}
                    title="Shift this whole leg (with its entry, realized P&L, timestamps & any pending orders) into another strategy — for merging"
                    className="text-[11px] px-2 py-1 mr-1 bg-blue-900/30 hover:bg-blue-800/40 text-blue-300 border border-blue-900 rounded">
                    {movingLegId === leg.symbol ? "Close" : "Move →"}
                  </button>
                  {strategy.status === "OPEN" && leg.qty > 0 && (
                    <button onClick={() => setExitingLegId(exitingLegId === leg.symbol ? null : leg.symbol)}
                      className="text-[11px] px-2 py-1 bg-red-900/40 hover:bg-red-800/50 text-red-300 border border-red-800 rounded">
                      {exitingLegId === leg.symbol ? "Close" : "Exit"}
                    </button>
                  )}
                </td>
              </tr>
              {movingLegId === leg.symbol && (
                <tr><td colSpan={12} className="pb-2">
                  <MoveLegPanel strategy={strategy} leg={leg} strategyNames={strategyNames}
                    onDone={() => { setMovingLegId(null); onLegChanged(); }} onCancel={() => setMovingLegId(null)} />
                </td></tr>
              )}
              {exitingLegId === leg.symbol && (
                <tr><td colSpan={12} className="pb-2">
                  <ExitLegPanel strategy={strategy} leg={leg} onDone={() => { setExitingLegId(null); onLegChanged(); }} onCancel={() => setExitingLegId(null)} />
                </td></tr>
              )}
            </Fragment>
            );
          })}
        </tbody>
      </table>
      </div>
      )}
    </div>
  );
}

const ORDER_STATUS = { 1: "Cancelled", 2: "Filled", 3: "-", 4: "Transit", 5: "Rejected", 6: "Pending" };
const ORDER_STATUS_COLOR = { 1: "text-gray-400", 2: "text-green-400", 4: "text-blue-400", 5: "text-red-400", 6: "text-yellow-400" };

function ModifyOrderForm({ order, onDone, onCancel }) {
  const [limitPrice, setLimitPrice] = useState(order.limitPrice || 0);
  const [qty, setQty] = useState(order.qty);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setLoading(true); setError(null);
    try {
      await api.modifyOrder(order.id, { limit_price: +limitPrice, quantity: +qty });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-gray-800 rounded p-3 mt-1 flex gap-2 items-end">
      <label className="text-xs text-gray-400 flex flex-col gap-1">
        Price
        <input type="number" step="0.05" value={limitPrice} onChange={e => setLimitPrice(e.target.value)} className="input-field text-xs w-24" />
      </label>
      <label className="text-xs text-gray-400 flex flex-col gap-1">
        Qty
        <input type="number" min={1} value={qty} onChange={e => setQty(e.target.value)} className="input-field text-xs w-20" />
      </label>
      <button onClick={submit} disabled={loading} className="px-3 py-1.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded text-xs font-medium">
        {loading ? "…" : "Save"}
      </button>
      <button onClick={onCancel} className="px-3 py-1.5 text-gray-400 hover:text-gray-200 text-xs">Cancel</button>
      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}

function ConvertPositionForm({ position, onDone, onCancel }) {
  const [convertTo, setConvertTo] = useState(position.productType === "INTRADAY" ? "MARGIN" : "INTRADAY");
  const [qty, setQty] = useState(Math.abs(position.netQty));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    setLoading(true); setError(null);
    try {
      await api.convertPosition({
        symbol: position.symbol,
        position_side: position.netQty >= 0 ? 1 : -1,
        convert_qty: +qty,
        convert_from: position.productType,
        convert_to: convertTo,
      });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-gray-800 rounded p-3 mt-1 flex gap-2 items-end">
      <label className="text-xs text-gray-400 flex flex-col gap-1">
        Convert To
        <select value={convertTo} onChange={e => setConvertTo(e.target.value)} className="input-field text-xs">
          {["INTRADAY", "MARGIN", "CNC"].filter(p => p !== position.productType).map(p => <option key={p} value={p}>{p}</option>)}
        </select>
      </label>
      <label className="text-xs text-gray-400 flex flex-col gap-1">
        Qty
        <input type="number" min={1} max={Math.abs(position.netQty)} value={qty} onChange={e => setQty(e.target.value)} className="input-field text-xs w-20" />
      </label>
      <button onClick={submit} disabled={loading} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-xs font-medium">
        {loading ? "…" : "Convert"}
      </button>
      <button onClick={onCancel} className="px-3 py-1.5 text-gray-400 hover:text-gray-200 text-xs">Cancel</button>
      {error && <p className="text-red-400 text-xs">{error}</p>}
    </div>
  );
}

function EditBuyDateForm({ symbol, currentDate, onDone, onCancel }) {
  const [date, setDate] = useState(currentDate || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  async function submit() {
    if (!date) return;
    setSaving(true); setError(null);
    try {
      await api.setTbillPurchaseDate(symbol, date);
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-1">
      <input type="date" value={date} onChange={e => setDate(e.target.value)}
        className="input-field text-xs py-0.5 px-1 w-32" />
      <button onClick={submit} disabled={saving || !date}
        className="text-[10px] px-1.5 py-0.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded">
        {saving ? "…" : "Save"}
      </button>
      <button onClick={onCancel} className="text-[10px] px-1.5 py-0.5 text-gray-400 hover:text-gray-200">Cancel</button>
      {error && <span className="text-red-400 text-[10px]">{error}</span>}
    </span>
  );
}

function HoldingsView() {
  const [holdings, setHoldings] = useState([]);
  const [purchases, setPurchases] = useState({});
  const [lots, setLots] = useState({});
  const [targets, setTargets] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingSymbol, setEditingSymbol] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [zh, fh, sh, p, lt, tg] = await Promise.all([
        api.zerodhaGetHoldings().catch(() => []),
        api.getHoldings().catch(() => []),
        api.shoonyaGetHoldings().catch(() => []),
        api.getTbillPurchases().catch(() => ({})),
        api.getHoldingLots().catch(() => ({})),
        api.getHoldingTargets().catch(() => []),
      ]);
      const zerodha = (Array.isArray(zh) ? zh : []).filter(h => h.quantity !== 0).map(h => ({
        broker: "zerodha", tradingsymbol: h.tradingsymbol, quantity: h.quantity,
        average_price: h.average_price, last_price: h.last_price, pnl: h.pnl, isin: h.isin,
      }));
      const fyers = (Array.isArray(fh) ? fh : []).filter(h => h.quantity !== 0).map(h => ({
        broker: "fyers", tradingsymbol: h.symbol, quantity: h.quantity,
        average_price: h.costPrice, last_price: h.ltp, pnl: h.pl, isin: h.isin,
      }));
      const shoonya = (Array.isArray(sh) ? sh : []).filter(h => h.quantity !== 0).map(h => ({
        broker: "shoonya", tradingsymbol: h.tradingsymbol, quantity: h.quantity,
        average_price: h.average_price, last_price: h.last_price, pnl: h.pnl, isin: h.isin,
      }));
      setHoldings([...zerodha, ...fyers, ...shoonya]);
      setPurchases(p || {});
      setLots(lt || {});
      const tmap = {};
      for (const t of (Array.isArray(tg) ? tg : [])) tmap[`${t.broker}:${t.symbol}`] = t;
      setTargets(tmap);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div className="text-gray-400 text-sm">Loading…</div>;
  if (error) return <p className="text-red-400 text-sm">{error}</p>;
  if (holdings.length === 0) return <p className="text-gray-500 text-sm">No holdings</p>;

  const tbills = [], equity = [], others = [];
  for (const h of holdings) {
    const tb = parseTbillSymbol(h.tradingsymbol);
    // Purchase dates are stored keyed by the bare symbol (no "NSE:" prefix) since that's
    // the common format between Fyers and Zerodha — normalize here so the lookup matches
    // regardless of which broker's holding this came from.
    if (tb) tbills.push({ ...h, ...tb, bareSymbol: h.tradingsymbol.includes(":") ? h.tradingsymbol.split(":")[1] : h.tradingsymbol });
    else if (h.isin || /-EQ$/i.test(h.tradingsymbol)) equity.push(h);
    else others.push(h);
  }
  tbills.sort((a, b) => a.maturityDate.localeCompare(b.maturityDate));

  // Maturity ladder: T-Bills redeem at ₹100 face value, so qty × 100 is the cash landing
  // on each maturity date — the numbers you'd plan reinvestment around.
  const now = new Date();
  const inDays = d => Math.ceil((new Date(d + "T00:00:00") - now) / 86400000);
  const faceValue = list => list.reduce((sum, t) => sum + t.quantity * 100, 0);
  const week = tbills.filter(t => inDays(t.maturityDate) <= 7);
  const month = tbills.filter(t => inDays(t.maturityDate) <= 30);

  return (
    <div className="space-y-6">
      {tbills.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-gray-300 mb-2">T-Bills</h3>
          <div className="flex flex-wrap gap-4 bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 mb-2 text-xs">
            <span className="text-gray-400">
              Maturing ≤7 days: <span className={week.length ? "text-yellow-300 font-semibold" : "text-gray-300"}>₹{faceValue(week).toLocaleString()}</span>
              {week.length > 0 && <span className="text-gray-500"> ({week.length} bill{week.length > 1 ? "s" : ""})</span>}
            </span>
            <span className="text-gray-400">
              Maturing ≤30 days: <span className="text-gray-200 font-semibold">₹{faceValue(month).toLocaleString()}</span>
            </span>
            <span className="text-gray-400">
              Total face value: <span className="text-gray-200 font-semibold">₹{faceValue(tbills).toLocaleString()}</span>
            </span>
            {week.length > 0 && (
              <span className="text-yellow-400">→ cash landing soon — plan reinvestment via the T-Bills tab</span>
            )}
          </div>
          <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="text-left py-2 px-2">Broker</th>
                  <th className="text-left px-2">Symbol</th>
                  <th className="text-right px-2">Qty</th>
                  <th className="text-right px-2">Buying Date</th>
                  <th className="text-right px-2">Maturity Date</th>
                  <th className="text-right px-2">ROI % p.a.</th>
                </tr>
              </thead>
              <tbody>
                {tbills.map((t, i) => {
                  const buyDate = purchases[t.bareSymbol];
                  const avgPrice = +t.average_price;
                  // Annualized yield using the ACTUAL holding period (buying date -> maturity),
                  // not the bill's original designed tenor — a bill bought late in its life
                  // (e.g. via the near-maturity Auto-Buy Watch) has a much shorter real holding
                  // period than its 91/182/364D tenor, so annualizing over the full tenor would
                  // badly understate its true return. Requires a known buying date.
                  let roiPct = null;
                  if (avgPrice > 0 && buyDate) {
                    const daysHeld = Math.max(1, Math.round((new Date(t.maturityDate) - new Date(buyDate)) / 86400000));
                    roiPct = ((100 - avgPrice) / avgPrice) * (365 / daysHeld) * 100;
                  }
                  return (
                    <tr key={i} className="border-b border-gray-800/50">
                      <td className="py-1.5 px-2 text-[10px] text-gray-500 uppercase">{t.broker}</td>
                      <td className="py-1.5 px-2 text-gray-200 font-medium">{t.tradingsymbol}</td>
                      <td className="text-right px-2 text-gray-300">{t.quantity}</td>
                      <td className="text-right px-2 text-gray-400">
                        {editingSymbol === t.tradingsymbol ? (
                          <EditBuyDateForm symbol={t.tradingsymbol} currentDate={buyDate}
                            onDone={() => { setEditingSymbol(null); load(); }}
                            onCancel={() => setEditingSymbol(null)} />
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            {buyDate || "—"}
                            <button onClick={() => setEditingSymbol(t.tradingsymbol)}
                              className="text-[9px] px-1 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 border border-gray-700 rounded">
                              Edit
                            </button>
                          </span>
                        )}
                      </td>
                      <td className="text-right px-2 text-gray-400">{t.maturityDate}</td>
                      <td className={`text-right px-2 font-semibold ${roiPct == null ? "text-gray-500" : roiPct >= 0 ? "text-green-400" : "text-red-400"}`}>
                        {roiPct != null ? `${roiPct.toFixed(2)}%` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-[10px] text-gray-600 p-2">
              Buying date is only recorded for T-Bills bought through this app going forward (or entered manually via "Edit") — Kite's API doesn't expose a holding's original purchase date. ROI needs a known buying date to annualize correctly over the actual holding period, so it shows "—" until then.
            </p>
          </div>
        </div>
      )}

      {equity.length > 0 && (
        <HoldingsTable title="Equity" rows={equity} purchases={purchases} lots={lots} targets={targets}
          editingSymbol={editingSymbol} setEditingSymbol={setEditingSymbol} onEdited={() => { setEditingSymbol(null); load(); }} />
      )}
      {others.length > 0 && (
        <HoldingsTable title="Others" rows={others} purchases={purchases} lots={lots} targets={targets}
          editingSymbol={editingSymbol} setEditingSymbol={setEditingSymbol} onEdited={() => { setEditingSymbol(null); load(); }} />
      )}
    </div>
  );
}

const daysSince = (d) => Math.max(1, Math.round((Date.now() - new Date(d + "T00:00:00")) / 86400000));

// Add a purchase lot (tranche) to a holding.
function AddLotForm({ broker, bare, onDone }) {
  const [date, setDate] = useState("");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  async function submit() {
    if (!date || +qty <= 0 || price === "") return;
    setSaving(true); setError(null);
    try { await api.addHoldingLot(broker, bare, date, +qty, +price); onDone(); }
    catch (err) { setError(err.message); } finally { setSaving(false); }
  }
  return (
    <div className="flex flex-wrap items-center gap-2 mt-1 text-[11px]">
      <input type="date" value={date} onChange={e => setDate(e.target.value)} className="input-field text-[11px] py-0.5 px-1 w-32" />
      <input type="number" min={1} placeholder="qty" value={qty} onChange={e => setQty(e.target.value)} className="input-field text-[11px] py-0.5 px-1 w-20" />
      <input type="number" min={0} step="0.05" placeholder="buy price" value={price} onChange={e => setPrice(e.target.value)} className="input-field text-[11px] py-0.5 px-1 w-24" />
      <button onClick={submit} disabled={saving || !date || +qty <= 0 || price === ""}
        className="text-[10px] px-2 py-0.5 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded">{saving ? "…" : "Add lot"}</button>
      {error && <span className="text-red-400">{error}</span>}
    </div>
  );
}

// Holdings target/SL auto-exit: arm ANY holding (equity or other — not just cash-segment scalps)
// with an optional target and/or stop-loss price; neither is mandatory. The backend watcher sells
// the FULL current qty the instant either is touched, as a marketable limit at the live bid — same
// convention as the Scalps and Strategies auto-exit. Real money — arming is the explicit consent.
function HoldingTargetControl({ broker, symbol, armed, onChanged }) {
  const [confirming, setConfirming] = useState(false);
  const [target, setTarget] = useState(armed?.target_price ?? "");
  const [sl, setSl] = useState(armed?.sl_price ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const canArm = target !== "" || sl !== "";

  async function arm() {
    setBusy(true); setError(null);
    try { await api.armHoldingTarget(broker, symbol, target, sl); setConfirming(false); onChanged?.(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function disarm() {
    setBusy(true); setError(null);
    try { await api.disarmHoldingTarget(broker, symbol); onChanged?.(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function toggleAuto() {
    setBusy(true); setError(null);
    try { await api.setHoldingTargetAuto(broker, symbol, !armed.auto_enabled); onChanged?.(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (armed?.status === "FIRED") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs bg-green-900/20 border border-green-800/60 rounded px-3 py-1.5">
        <span className="text-green-300 font-semibold">⚡ Auto-exit FIRED — {armed.exit_reason === "TARGET" ? "target hit" : "stop-loss hit"}</span>
        <span className="text-gray-500">sold at broker (order {armed.exit_order_id})</span>
        <button onClick={disarm} disabled={busy} className="ml-auto text-[11px] px-2 py-0.5 text-gray-400 hover:text-gray-200 border border-gray-700 rounded">Clear</button>
        {error && <span className="text-red-400 w-full">{error}</span>}
      </div>
    );
  }
  if (armed?.status === "ARMED" && !confirming) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs bg-yellow-900/20 border border-yellow-800/60 rounded px-3 py-1.5">
        <span className="text-amber-300 font-semibold">
          {armed.auto_enabled ? "⚡ AUTO ARMED" : "⏸ Armed (auto off)"}
          {armed.target_price != null && ` · Target ₹${armed.target_price}`}
          {armed.sl_price != null && ` · SL ₹${armed.sl_price}`}
        </span>
        <span className="text-gray-600">sells the full holding at bid the instant either is touched</span>
        <button onClick={toggleAuto} disabled={busy}
          className={`text-[11px] px-2 py-0.5 border rounded ${armed.auto_enabled ? "text-purple-300 border-purple-800 hover:text-purple-200" : "text-green-300 border-green-800 hover:text-green-200"}`}>
          {armed.auto_enabled ? "⏸ Pause" : "▶ Resume"}
        </button>
        <button onClick={() => setConfirming(true)} className="text-[11px] px-2 py-0.5 text-blue-300 hover:text-blue-200 border border-gray-700 rounded">Edit</button>
        <button onClick={disarm} disabled={busy} className="text-[11px] px-2 py-0.5 text-gray-400 hover:text-red-400 border border-gray-700 rounded">Disarm</button>
        {error && <span className="text-red-400 w-full">{error}</span>}
      </div>
    );
  }
  return (
    <div className="mt-2">
      {!confirming ? (
        <button onClick={() => setConfirming(true)}
          className="text-xs text-amber-300 hover:text-amber-200 border border-yellow-900/60 bg-yellow-900/10 rounded px-3 py-1">
          🎯 Set target / stop-loss…
        </button>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs bg-gray-900/60 border border-gray-800 rounded p-2">
          <label className="text-gray-500">Target <input type="number" step="0.05" value={target} onChange={e => setTarget(e.target.value)} placeholder="optional" className="input-field text-xs w-24 ml-1" autoFocus /></label>
          <label className="text-gray-500">Stop-loss <input type="number" step="0.05" value={sl} onChange={e => setSl(e.target.value)} placeholder="optional" className="input-field text-xs w-24 ml-1" /></label>
          <span className="text-gray-600">— either or both; sells the full qty at bid the instant it's touched</span>
          <button onClick={arm} disabled={busy || !canArm}
            className="px-3 py-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded font-medium"
            title="Arms auto-exit — no further confirm when the price is touched">
            {busy ? "…" : "Arm — auto-sells"}
          </button>
          <button onClick={() => setConfirming(false)} className="text-gray-400 hover:text-gray-200">Cancel</button>
          {error && <span className="text-red-400 w-full">{error}</span>}
        </div>
      )}
    </div>
  );
}

function HoldingRow({ h, bare, symLots, purchases, target, editingSymbol, setEditingSymbol, onChanged, onEdited }) {
  const [expanded, setExpanded] = useState(false);
  const ltp = h.last_price != null ? +h.last_price : null;
  const hasLots = symLots.length > 0;

  // Combined ROI: from lots (money + time weighted) when present, else the single entry-date method.
  let roi = null;
  if (hasLots && ltp != null) {
    let invested = 0, pnl = 0, wdays = 0;
    for (const l of symLots) { const inv = l.qty * l.price; invested += inv; pnl += (ltp - l.price) * l.qty; wdays += inv * daysSince(l.date); }
    if (invested > 0) roi = (pnl / invested) * (365 / (wdays / invested)) * 100;
  } else {
    const buyDate = purchases[bare]; const invested = (+h.average_price) * h.quantity;
    if (buyDate && invested > 0 && h.pnl != null) roi = (h.pnl / invested) * (365 / daysSince(buyDate)) * 100;
  }
  const lotQty = symLots.reduce((s, l) => s + l.qty, 0);

  return (
    <>
      <tr className="border-b border-gray-800/50">
        <td className="py-1.5 px-2 text-[10px] text-gray-500 uppercase">{h.broker}</td>
        <td className="py-1.5 px-2 text-gray-200 font-medium">
          <button onClick={() => setExpanded(v => !v)} className="inline-flex items-center gap-1 hover:text-white">
            <span className="text-gray-600">{expanded ? "▾" : "▸"}</span>{h.tradingsymbol}
            {hasLots && <span className="text-[9px] text-indigo-300 bg-indigo-900/40 border border-indigo-800 rounded px-1">{symLots.length} lot{symLots.length > 1 ? "s" : ""}</span>}
            {target?.status === "ARMED" && (
              <span className={`text-[9px] border rounded px-1 ${target.auto_enabled ? "text-amber-300 bg-amber-900/30 border-amber-800" : "text-gray-400 bg-gray-800 border-gray-700"}`}>
                🎯 {target.auto_enabled ? "armed" : "paused"}
              </span>
            )}
            {target?.status === "FIRED" && (
              <span className="text-[9px] text-green-300 bg-green-900/30 border border-green-800 rounded px-1">⚡ exited</span>
            )}
          </button>
        </td>
        <td className="text-right px-2 text-gray-300">{h.quantity}</td>
        <td className="text-right px-2 text-gray-300">₹{(+h.average_price).toFixed(2)}</td>
        <td className="text-right px-2 text-gray-300">{ltp != null ? `₹${ltp.toFixed(2)}` : "—"}</td>
        <td className={`text-right px-2 font-medium ${h.pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
          {h.pnl != null ? `${h.pnl >= 0 ? "+" : ""}₹${(+h.pnl).toFixed(2)}` : "—"}
        </td>
        <td className="text-right px-2 text-gray-400">
          {hasLots ? (
            <button onClick={() => setExpanded(true)} className="text-indigo-300 hover:underline">{symLots.length} lots ▸</button>
          ) : editingSymbol === bare ? (
            <EditBuyDateForm symbol={bare} currentDate={purchases[bare]} onDone={onEdited} onCancel={() => setEditingSymbol(null)} />
          ) : (
            <span className="inline-flex items-center gap-1.5">
              {purchases[bare] || "—"}
              <button onClick={() => setEditingSymbol(bare)}
                className="text-[9px] px-1 py-0.5 bg-gray-800 hover:bg-gray-700 text-gray-400 border border-gray-700 rounded">Edit</button>
            </span>
          )}
        </td>
        <td className={`text-right px-2 font-semibold ${roi == null ? "text-gray-500" : roi >= 0 ? "text-green-400" : "text-red-400"}`}
          title={hasLots ? "Combined ROI across all lots (money + time weighted)" : "ROI from the single entry date"}>
          {roi != null ? `${roi.toFixed(2)}%${hasLots ? " ᶜ" : ""}` : "—"}
        </td>
      </tr>
      {expanded && (
        <tr className="bg-gray-900/40">
          <td colSpan={8} className="px-4 py-2">
            <HoldingTargetControl broker={h.broker} symbol={h.tradingsymbol} armed={target} onChanged={onChanged} />
            <div className="text-[11px] text-gray-400 font-medium mb-1 mt-3">Purchase lots — per-tranche ROI</div>
            {hasLots ? (
              <table className="w-full text-[11px] mb-2">
                <thead><tr className="text-gray-600">
                  <th className="text-left py-1">Date</th><th className="text-right px-2">Qty</th><th className="text-right px-2">Buy price</th>
                  <th className="text-right px-2">Invested</th><th className="text-right px-2">P&L</th><th className="text-right px-2">ROI % p.a.</th><th></th>
                </tr></thead>
                <tbody>
                  {symLots.map(l => {
                    const inv = l.qty * l.price;
                    const pnl = ltp != null ? (ltp - l.price) * l.qty : null;
                    const lroi = ltp != null && l.price > 0 ? ((ltp - l.price) / l.price) * (365 / daysSince(l.date)) * 100 : null;
                    return (
                      <tr key={l.id} className="border-t border-gray-800/40">
                        <td className="py-1 text-gray-300">{l.date}</td>
                        <td className="text-right px-2 text-gray-300">{l.qty}</td>
                        <td className="text-right px-2 text-gray-300">₹{l.price.toFixed(2)}</td>
                        <td className="text-right px-2 text-gray-400">₹{inv.toFixed(0)}</td>
                        <td className={`text-right px-2 ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}>{pnl != null ? `${pnl >= 0 ? "+" : ""}₹${pnl.toFixed(0)}` : "—"}</td>
                        <td className={`text-right px-2 font-medium ${lroi == null ? "text-gray-500" : lroi >= 0 ? "text-green-400" : "text-red-400"}`}>{lroi != null ? `${lroi.toFixed(2)}%` : "—"}</td>
                        <td className="text-right">
                          <button onClick={async () => { await api.deleteHoldingLot(l.id, h.broker, bare); onChanged(); }}
                            className="text-[9px] text-gray-500 hover:text-red-400 px-1">✕</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="text-[11px] text-gray-600 mb-1">No lots recorded. Add each purchase (date, qty, price) to see per-tranche and combined ROI.</p>
            )}
            {lotQty > 0 && lotQty !== h.quantity && (
              <p className="text-[10px] text-yellow-500 mb-1">Recorded lots total {lotQty} qty but the holding is {h.quantity} — add/adjust lots to match.</p>
            )}
            <AddLotForm broker={h.broker} bare={bare} onDone={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

// Equity / Others holdings table. Each row expands to per-purchase (lot) ROI; the row-level ROI
// is the combined money+time-weighted figure. Falls back to a single editable entry date + its
// ROI when no lots are recorded. Annualized: (P&L ÷ invested) × 365 ÷ days held.
function HoldingsTable({ title, rows, purchases, lots, targets, editingSymbol, setEditingSymbol, onEdited }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-300 mb-2">{title}</h3>
      <div className="bg-gray-900 rounded-lg border border-gray-800 overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-gray-500 border-b border-gray-800">
              <th className="text-left py-2 px-2">Broker</th>
              <th className="text-left px-2">Symbol</th>
              <th className="text-right px-2">Qty</th>
              <th className="text-right px-2">Avg Price</th>
              <th className="text-right px-2">LTP</th>
              <th className="text-right px-2">P&L</th>
              <th className="text-right px-2">Entry / Lots</th>
              <th className="text-right px-2">ROI % p.a.</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((h, i) => {
              const bare = h.tradingsymbol.includes(":") ? h.tradingsymbol.split(":")[1] : h.tradingsymbol;
              return (
                <HoldingRow key={i} h={h} bare={bare} symLots={lots[`${h.broker}:${bare}`] || []} purchases={purchases}
                  target={targets[`${h.broker}:${h.tradingsymbol}`]}
                  editingSymbol={editingSymbol} setEditingSymbol={setEditingSymbol}
                  onChanged={onEdited} onEdited={onEdited} />
              );
            })}
          </tbody>
        </table>
        <p className="text-[10px] text-gray-600 p-2">
          ROI is annualized: (P&L ÷ invested) × 365 ÷ days held. Click a symbol to record individual purchase lots (bought on different days/prices) — each lot gets its own ROI and the row shows the combined <span className="text-gray-400">ᶜ</span> figure. With no lots, set a single entry date via <span className="text-gray-400">Edit</span>.
        </p>
      </div>
    </div>
  );
}

const REFRESH_OPTIONS = [1000, 2000, 5000, 10000];

function LiveToggle({ live, setLive }) {
  return (
    <button onClick={() => setLive(l => !l)}
      className={`text-xs px-3 py-1 rounded flex items-center gap-1.5 font-medium ${
        live ? "bg-green-900/40 text-green-400 border border-green-700" : "bg-gray-800 text-gray-400 border border-gray-700"
      }`}>
      <span className={`w-1.5 h-1.5 rounded-full ${live ? "bg-green-400 animate-pulse" : "bg-gray-500"}`} />
      {live ? "Live" : "Paused"}
    </button>
  );
}

function RefreshSelect({ refreshMs, setRefreshMs }) {
  return (
    <select value={refreshMs} onChange={e => setRefreshMs(+e.target.value)}
      className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-300 text-xs">
      {REFRESH_OPTIONS.map(ms => <option key={ms} value={ms}>{ms / 1000}s</option>)}
    </select>
  );
}

// Combined view for one underlying: every OPEN strategy's legs pooled into a single expiry payoff,
// so the breakevens are those of the whole book on that scrip (not any one strategy). Opened by
// clicking the underlying's name on a strategy card; rendered below the strategy list.
function CombinedUnderlyingPanel({ root, strategies, greeksById, onClose }) {
  const [analysis, setAnalysis] = useState(null);
  const legs = useMemo(() => strategies.flatMap(s => s.legs.filter(l => l.qty > 0).map(l => ({
    symbol: l.symbol, side: l.side, quantity: l.qty, limit_price: l.entry || 0,
  }))), [strategies]);
  const realized = strategies.reduce((a, s) => a + (s.realized_total || 0), 0);
  const pl = strategies.reduce((a, s) => a + (s.total_pl || 0), 0);
  const margin = strategies.reduce((a, s) => a + (s.margin || 0), 0);
  const greeks = strategies.reduce((a, s) => {
    const g = greeksById[s.id];
    if (g) { a.delta += g.delta; a.theta += g.theta; }
    return a;
  }, { delta: 0, theta: 0 });
  const spot = strategies.find(s => s.spot != null)?.spot ?? null;
  const expiries = [...new Set(strategies.map(s => s.expiry).filter(Boolean))].sort();

  // Nearest breakeven on each side of spot, with the cushion as % of spot.
  const bes = analysis?.breakevens || [];
  const below = spot != null ? bes.filter(b => b <= spot).pop() : undefined;
  const above = spot != null ? bes.find(b => b > spot) : undefined;
  const cushion = b => `${b >= spot ? "+" : ""}${((b - spot) / spot * 100).toFixed(2)}% from spot`;
  const fmt = v => v.toLocaleString("en-IN", { maximumFractionDigits: 0 });

  return (
    <div className="bg-gray-900 border border-amber-800/60 rounded-xl p-4">
      <div className="flex justify-between items-start gap-4 flex-wrap mb-3">
        <div>
          <h3 className="text-sm font-semibold text-amber-300">{root} · combined across {strategies.length} open {strategies.length === 1 ? "strategy" : "strategies"}</h3>
          <p className="text-[11px] text-gray-500 mt-0.5">#{strategies.map(s => s.id).join(", #")} · {legs.length} legs · expiry {expiries.join(", ") || "—"}</p>
        </div>
        <button onClick={onClose} className="text-xs text-gray-400 hover:text-white border border-gray-700 rounded px-3 py-1">Close</button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-3">
        {spot != null && <StatTile label="Spot" value={fmt(spot)} />}
        <StatTile label="Lower BE" value={below != null ? fmt(below) : "—"} sub={below != null ? cushion(below) : null}
          title="Nearest combined breakeven below spot — at expiry the pooled position is in loss under this level." />
        <StatTile label="Upper BE" value={above != null ? fmt(above) : "—"} sub={above != null ? cushion(above) : null}
          title="Nearest combined breakeven above spot — at expiry the pooled position is in loss over this level." />
        <StatTile label="Total P&L" value={`${pl >= 0 ? "+" : ""}₹${pl.toFixed(0)}`} tone={pl} />
        <StatTile label="Margin" value={fmtLakh(margin)} />
        <StatTile label="Net Δ / θ" value={`${GREEK_FMT(greeks.delta, 0)} / ${GREEK_FMT(greeks.theta, 0)}`} tone={greeks.theta}
          title="Net delta (underlying-share equivalents) / net theta (₹ per day) across these strategies" />
      </div>
      {bes.length > 2 && (
        <p className="text-[11px] text-gray-400 mb-2">All breakevens: {bes.map(fmt).join(" · ")}</p>
      )}

      <PayoffPanel legs={legs} realized={realized} spot={spot} onAnalysis={setAnalysis} />
      {expiries.length > 1 && (
        <p className="text-[10px] text-amber-500/80 mt-1">
          Mixed expiries ({expiries.join(", ")}): the curve values every leg at intrinsic, i.e. P&L if spot sits at that level
          when each leg expires. The far-dated legs' remaining time value is ignored, so before the last expiry the real breakevens are tighter.
        </p>
      )}
      {realized ? <p className="text-[10px] text-gray-600 mt-1">Includes ₹{Math.round(realized).toLocaleString("en-IN")} realized from closed legs.</p> : null}
    </div>
  );
}

function ByStrategyView({ onSendToBuilder }) {
  const [strategies, setStrategies] = useState([]);
  const [unassigned, setUnassigned] = useState([]);
  const [strategyNames, setStrategyNames] = useState([]);
  const [bulletinByStrategy, setBulletinByStrategy] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [assigningKey, setAssigningKey] = useState(null);
  const [showManual, setShowManual] = useState(false);
  const [live, setLive] = useState(true);
  const [refreshMs, setRefreshMs] = useState(5000);
  const [sortBy, setSortBy] = useState("dte");
  const [filterUnderlying, setFilterUnderlying] = useState("");
  const [filterMode, setFilterMode] = useState("all"); // all | time | direction (θ-ROI vs Live ROI)
  const [volByRoot, setVolByRoot] = useState({});       // underlying root -> volatility payload, for sorting
  const [combinedRoot, setCombinedRoot] = useState(null); // underlying whose combined breakeven panel is open
  const combinedRef = useRef(null);
  const inFlight = useRef(false); // guard so a slow /strategy/list poll never overlaps itself

  const load = useCallback(async (silent = false) => {
    // /strategy/list can take several seconds (broker position fetches + margin). Never fire a
    // new poll while one is in flight — overlapping polls used to pile up and exhaust the
    // backend's worker threads, hanging every other request (login, news, etc.).
    if (silent && inFlight.current) return;
    inFlight.current = true;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [s, u, names] = await Promise.all([
        api.listStrategies(), api.getUnassignedOrders(), api.listStrategyNames(),
      ]);
      setStrategies(Array.isArray(s) ? s : []);
      setUnassigned(Array.isArray(u) ? u : []);
      setStrategyNames(Array.isArray(names) ? names.filter(n => n.status === "OPEN") : []);
    } catch (err) {
      if (!silent) setError(err.message);
    } finally {
      inFlight.current = false;
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Bulletin cross-reference is a slow-moving feed (polled every 30 min server-side) — fetch
  // once on mount rather than on the fast live-price refresh interval.
  useEffect(() => {
    api.getRssForStrategies()
      .then(data => {
        const byStrategy = {};
        for (const m of (Array.isArray(data) ? data : [])) {
          (byStrategy[m.strategy_id] ??= []).push(...m.matches);
        }
        setBulletinByStrategy(byStrategy);
      })
      .catch(() => {});
  }, []);

  // Self-scheduling poll: schedule the next refresh only AFTER the current one finishes, so a
  // slow response can never cause overlapping in-flight requests to accumulate.
  useEffect(() => {
    if (!live) return;
    let cancelled = false;
    let timer;
    const tick = async () => {
      await load(true);
      if (!cancelled) timer = setTimeout(tick, refreshMs);
    };
    timer = setTimeout(tick, refreshMs);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [live, refreshMs, load]);

  // Volatility ratio per distinct underlying, for the "Vol" sort (the per-card VolatilityTile
  // fetches its own copy; this list-level map just powers ordering). Refreshed with the list.
  const roots = [...new Set(strategies.filter(s => s.status === "OPEN").map(s => s.underlying).filter(Boolean))].join(",");
  useEffect(() => {
    const list = roots ? roots.split(",") : [];
    if (list.length === 0) return;
    let alive = true;
    Promise.all(list.map(r => api.getVolatilityForRoot(r).then(v => [r, v]).catch(() => [r, null])))
      .then(pairs => { if (alive) setVolByRoot(Object.fromEntries(pairs)); });
    return () => { alive = false; };
  }, [roots]);

  async function handleClose(id) {
    await api.closeStrategy(id);
    load();
  }

  // Greeks (Black-Scholes + IV per leg) are the heaviest per-poll compute. Do it ONCE per strategy
  // per poll and share the result with the aggregate, the filter, and each card — instead of every
  // card + the aggregate + the filter each recomputing it (2-3× the work, the main cause of the UI
  // stutter when a refresh lands). Keyed on `strategies`, so it only recomputes on an actual refresh.
  // Must sit ABOVE the early returns below (Rules of Hooks — always call it).
  const greeksById = useMemo(
    () => Object.fromEntries(strategies.filter(s => s.status === "OPEN").map(s => [s.id, strategyGreeks(s)])),
    [strategies]);

  // Bring the combined panel into view when an underlying is picked (it renders below the list).
  useEffect(() => {
    if (combinedRoot) combinedRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [combinedRoot]);

  if (loading) return <div className="text-gray-400 text-sm">Loading…</div>;
  if (error) return <p className="text-red-400 text-sm">{error}</p>;

  const openStrategies = strategies.filter(s => s.status === "OPEN");
  const closedStrategies = strategies.filter(s => s.status === "CLOSED");

  // Aggregate summary across all open strategies (item 1).
  const agg = openStrategies.reduce((a, s) => {
    a.pl += s.total_pl || 0;
    a.margin += s.margin || 0;
    const g = greeksById[s.id];
    if (g) { a.delta += g.delta; a.theta += g.theta; }
    return a;
  }, { pl: 0, margin: 0, delta: 0, theta: 0 });
  const aggRoi = agg.margin ? (agg.pl / agg.margin) * 100 : null;

  const underlyings = [...new Set(openStrategies.map(s => s.underlying).filter(Boolean))].sort();
  const volRatio = s => volByRoot[s.underlying]?.volatility_ratio;
  // θ-ROI (carry) vs Live ROI: carry ≥ Live ⇒ mostly earned by waiting ("time-based"); carry < Live
  // ⇒ the edge leans on a favourable move ("direction-based"). Null when greeks/margin unavailable.
  const carryVsLive = s => {
    const g = greeksById[s.id];
    if (!g || !s.margin || s.roi_pct == null) return null;
    return (g.theta / s.margin * 365 * 100) >= s.roi_pct ? "time" : "direction";
  };
  const visible = openStrategies
    .filter(s => !filterUnderlying || s.underlying === filterUnderlying)
    .filter(s => filterMode === "all" || carryVsLive(s) === filterMode)
    .sort((a, b) => {
      if (sortBy === "pl") return (b.total_pl || 0) - (a.total_pl || 0);
      if (sortBy === "roi") return (b.roi_pct ?? -1e9) - (a.roi_pct ?? -1e9);
      if (sortBy === "margin") return (b.margin || 0) - (a.margin || 0);
      if (sortBy === "vol") return (volRatio(b) ?? -1e9) - (volRatio(a) ?? -1e9);
      // dte (default): soonest expiry first
      return (daysToExpiry(a.expiry) ?? 1e9) - (daysToExpiry(b.expiry) ?? 1e9);
    });

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="text-sm font-semibold text-gray-300">Strategies</h3>
        <div className="flex gap-2 items-center">
          <RefreshSelect refreshMs={refreshMs} setRefreshMs={setRefreshMs} />
          <LiveToggle live={live} setLive={setLive} />
          <button onClick={() => load(false)} className="text-xs text-gray-400 hover:text-white border border-gray-700 rounded px-3 py-1">Refresh</button>
        </div>
      </div>

      {openStrategies.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1 bg-gray-900 border border-gray-800 rounded-lg px-4 py-2 text-xs">
          <span className="text-gray-400">Open: <span className="text-gray-200 font-semibold">{openStrategies.length}</span></span>
          <span className="text-gray-400">Total P&L: <span className={`font-semibold ${agg.pl >= 0 ? "text-green-400" : "text-red-400"}`}>{agg.pl >= 0 ? "+" : ""}₹{agg.pl.toFixed(2)}</span></span>
          <span className="text-gray-400">Margin: <span className="text-gray-200 font-semibold">{fmtInr(agg.margin)}</span></span>
          {aggRoi != null && <span className="text-gray-400">Return: <span className={`font-semibold ${aggRoi >= 0 ? "text-green-400" : "text-red-400"}`}>{aggRoi.toFixed(2)}%</span></span>}
          <span className="text-gray-400" title="Net delta across all strategies (underlying-share equivalents)">Net Δ: <span className="text-gray-200 font-semibold">{GREEK_FMT(agg.delta, 0)}</span></span>
          <span className="text-gray-400" title="Net theta — ₹/day from time decay across all strategies">Net θ: <span className={`font-semibold ${agg.theta >= 0 ? "text-green-400" : "text-red-400"}`}>{GREEK_FMT(agg.theta, 0)}/day</span></span>
        </div>
      )}

      {openStrategies.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-500">Sort:</span>
          {[["dte", "Expiry"], ["pl", "P&L"], ["roi", "ROI"], ["margin", "Margin"], ["vol", "Vol ratio"]].map(([id, label]) => (
            <button key={id} onClick={() => setSortBy(id)}
              className={`px-2 py-0.5 rounded ${sortBy === id ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>{label}</button>
          ))}
          <span className="text-gray-500 ml-2">Show:</span>
          {[["all", "All"], ["time", "Time-based"], ["direction", "Direction-based"]].map(([id, label]) => (
            <button key={id} onClick={() => setFilterMode(id)}
              title={id === "time" ? "θ-ROI (carry) ≥ Live ROI — edge earned mostly by waiting (decay)"
                : id === "direction" ? "θ-ROI (carry) < Live ROI — edge leans on a favourable move (intrinsic)" : "All open strategies"}
              className={`px-2 py-0.5 rounded ${filterMode === id ? "bg-emerald-700 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>{label}</button>
          ))}
          {underlyings.length > 1 && (
            <>
              <span className="text-gray-500 ml-2">Underlying:</span>
              <select value={filterUnderlying} onChange={e => setFilterUnderlying(e.target.value)}
                className="bg-gray-800 border border-gray-700 rounded px-2 py-0.5 text-gray-300">
                <option value="">All</option>
                {underlyings.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </>
          )}
        </div>
      )}

      {openStrategies.length === 0 && (
        <p className="text-gray-500 text-sm">No strategies yet. Build one in Strategy Builder and execute it.</p>
      )}

      <div className="grid grid-cols-1 gap-3">
        {visible.map(s => (
          <StrategyCard key={s.id} strategy={s} strategyNames={strategyNames} onClose={handleClose} onLegChanged={load}
            bulletinMatches={bulletinByStrategy[s.id]} onSendToBuilder={onSendToBuilder} greeks={greeksById[s.id]}
            onSelectUnderlying={u => setCombinedRoot(r => (r === u ? null : u))} underlyingSelected={combinedRoot === s.underlying} />
        ))}
      </div>

      {combinedRoot && (() => {
        const group = openStrategies.filter(s => s.underlying === combinedRoot);
        if (group.length === 0) return null;
        return (
          <div ref={combinedRef} className="scroll-mt-4">
            <CombinedUnderlyingPanel root={combinedRoot} strategies={group} greeksById={greeksById} onClose={() => setCombinedRoot(null)} />
          </div>
        );
      })()}

      {unassigned.length > 0 && (
        <div className="bg-yellow-900/10 border border-yellow-800/50 rounded-lg p-3">
          <h3 className="text-sm font-semibold text-yellow-400 mb-2">📥 {unassigned.length} Unassigned Order{unassigned.length !== 1 ? "s" : ""}</h3>
          <p className="text-[11px] text-gray-500 mb-3">
            Filled F&O orders at your brokers that aren't filed to a strategy yet — whether placed here or directly at the broker. Assign each to a strategy to fold it into the position.
          </p>
          <div className="space-y-2">
            {unassigned.map(o => {
              const key = o.broker + o.order_id;
              const p = parseLeg(o.symbol);
              const contract = p.kind === "future" ? "Futures" : p.kind === "option" ? `${p.strike} ${p.type === "CE" ? "CALL" : "PUT"}` : o.symbol;
              const label = o.root ? `${o.root} ${contract}` : contract;
              return (
                <div key={key} className="bg-gray-800/50 rounded p-3">
                  <div className="flex justify-between items-center text-sm">
                    <div>
                      <span className="text-[10px] text-gray-500 uppercase mr-2">{o.broker}</span>
                      <span className="text-white font-medium">{label}</span>
                      <span className={`ml-2 text-xs ${o.side === "BUY" ? "text-green-400" : "text-red-400"}`}>{o.side} {o.qty} @ ₹{o.price}</span>
                      <span className="ml-2 text-[10px] text-gray-600">order {o.order_id}</span>
                    </div>
                    <button onClick={() => setAssigningKey(assigningKey === key ? null : key)}
                      className="text-xs px-3 py-1 bg-blue-600 hover:bg-blue-700 rounded font-medium">
                      {assigningKey === key ? "Cancel" : "Assign"}
                    </button>
                  </div>
                  {assigningKey === key && (
                    <AssignOrderForm order={o} strategyNames={strategyNames}
                      onDone={() => { setAssigningKey(null); load(); }} onCancel={() => setAssigningKey(null)} />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div>
        <button onClick={() => setShowManual(v => !v)}
          className="text-xs text-gray-400 hover:text-gray-200 border border-gray-700 rounded px-3 py-1">
          {showManual ? "Cancel" : "＋ Add a past / broker order manually"}
        </button>
        {showManual && (
          <ManualOrderForm strategyNames={strategyNames}
            onDone={() => { setShowManual(false); load(); }} onCancel={() => setShowManual(false)} />
        )}
      </div>

      {closedStrategies.length > 0 && (
        <details className="text-sm">
          <summary className="text-gray-400 cursor-pointer">Closed strategies ({closedStrategies.length})</summary>
          <div className="grid gap-3 mt-3">
            {closedStrategies.map(s => <StrategyCard key={s.id} strategy={s} onClose={handleClose} />)}
          </div>
        </details>
      )}
    </div>
  );
}

export default function Positions({ onSendToBuilder }) {
  const [positions, setPositions] = useState([]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState("strategy");
  const [live, setLive] = useState(true);
  const [refreshMs, setRefreshMs] = useState(5000);
  const [convertingSymbol, setConvertingSymbol] = useState(null);
  const [modifyingOrderId, setModifyingOrderId] = useState(null);
  const [actionError, setActionError] = useState(null);
  const inFlight = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (silent && inFlight.current) return; // never overlap polls (see ByStrategyView note)
    inFlight.current = true;
    if (!silent) setLoading(true);
    setError(null);
    try {
      // Zerodha calls may fail if that broker isn't logged in — don't fail the whole load for that.
      // Zerodha's settled delivery holdings (equity/T-Bills/etc.) are shown separately in the
      // Holdings tab, not mixed into day/carry positions here.
      const [pos, book, zPos] = await Promise.all([
        api.getPositions(),
        api.getOrderBook(),
        api.zerodhaGetPositions().catch(() => []),
      ]);
      const fyersPositions = (Array.isArray(pos) ? pos : []).map(p => ({ ...p, broker: "fyers" }));
      const normalizeZerodha = (p) => ({
        broker: "zerodha",
        symbol: p.tradingsymbol,
        netQty: p.quantity,
        netAvg: p.average_price,
        ltp: p.last_price,
        pl: p.pnl,
        productType: p.product,
        id: null, // no Fyers-style exit/convert actions for Zerodha rows
      });
      const zerodhaPositions = (Array.isArray(zPos) ? zPos : []).filter(p => p.quantity !== 0).map(p => normalizeZerodha(p));
      setPositions([...fyersPositions, ...zerodhaPositions]);
      setOrders(Array.isArray(book) ? book : []);
    } catch (err) {
      if (!silent) setError(err.message);
    } finally {
      inFlight.current = false;
      if (!silent) setLoading(false);
    }
  }, []);

  async function handleExit(positionId) {
    setActionError(null);
    try {
      await api.exitPositions(positionId);
      load(false);
    } catch (err) {
      setActionError(err.message);
    }
  }

  async function handleCancelOrder(orderId) {
    setActionError(null);
    try {
      await api.cancelOrder(orderId);
      load(false);
    } catch (err) {
      setActionError(err.message);
    }
  }

  useEffect(() => { if (tab === "positions" || tab === "orders") load(); }, [tab, load]);

  useEffect(() => {
    if (!live || tab === "strategy" || tab === "holdings") return;
    let cancelled = false;
    let timer;
    const tick = async () => {
      await load(true);
      if (!cancelled) timer = setTimeout(tick, refreshMs);
    };
    timer = setTimeout(tick, refreshMs);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [live, refreshMs, tab, load]);

  return (
    <div>
      <div className="flex gap-2 mb-4 items-center">
        {[["strategy","By Strategy"],["positions","Raw Positions"],["holdings","Holdings"],["orders","Order Book"]].map(([id, label]) => (
          <button key={id} onClick={() => setTab(id)}
            className={`px-4 py-1.5 rounded text-sm ${tab === id ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"}`}>
            {label}
          </button>
        ))}
        {tab !== "strategy" && tab !== "holdings" && (
          <div className="ml-auto flex gap-2 items-center">
            <RefreshSelect refreshMs={refreshMs} setRefreshMs={setRefreshMs} />
            <LiveToggle live={live} setLive={setLive} />
            <button onClick={() => load(false)} className="text-xs text-gray-400 hover:text-white border border-gray-700 rounded px-3 py-1">Refresh</button>
          </div>
        )}
      </div>

      {actionError && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-2 mb-3">{actionError}</p>}

      {tab === "strategy" && <ByStrategyView onSendToBuilder={onSendToBuilder} />}

      {tab === "positions" && (
        loading ? <div className="text-gray-400 text-sm">Loading…</div> :
        error ? <p className="text-red-400 text-sm">{error}</p> :
        positions.length === 0
          ? <p className="text-gray-500 text-sm">No open positions</p>
          : <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-xs border-b border-gray-800">
                    <th className="text-left py-2 pr-4">Broker</th>
                    <th className="text-left pr-4">Symbol</th>
                    <th className="text-right pr-4">Qty</th>
                    <th className="text-right pr-4">Avg Price</th>
                    <th className="text-right pr-4">LTP</th>
                    <th className="text-right pr-4">P&L</th>
                    <th className="text-right pr-4">Product</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map((p, i) => {
                    const pnl = parseFloat(p.pl || 0);
                    return (
                      <Fragment key={i}>
                        <tr className="border-b border-gray-800/50">
                          <td className="py-2 pr-4 text-[10px] text-gray-500 uppercase">{p.broker}</td>
                          <td className="py-2 pr-4 font-medium text-white">{p.symbol}</td>
                          <td className="text-right pr-4 text-gray-300">{p.netQty}</td>
                          <td className="text-right pr-4 text-gray-300">₹{parseFloat(p.netAvg || 0).toFixed(2)}</td>
                          <td className="text-right pr-4 text-gray-300">₹{parseFloat(p.ltp || 0).toFixed(2)}</td>
                          <td className={`text-right pr-4 font-medium ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}>
                            {pnl >= 0 ? "+" : ""}₹{pnl.toFixed(2)}
                          </td>
                          <td className="text-right pr-4 text-gray-400 text-xs">{p.productType}</td>
                          <td className="text-right whitespace-nowrap">
                            {p.broker === "fyers" && p.netQty !== 0 && (
                              <>
                                <button onClick={() => handleExit(p.id)}
                                  className="text-[10px] px-2 py-1 bg-red-900/40 hover:bg-red-900/60 text-red-400 border border-red-800 rounded mr-1">
                                  Exit
                                </button>
                                <button onClick={() => setConvertingSymbol(convertingSymbol === p.symbol ? null : p.symbol)}
                                  className="text-[10px] px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 rounded">
                                  Convert
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                        {convertingSymbol === p.symbol && (
                          <tr>
                            <td colSpan={8}>
                              <ConvertPositionForm position={p}
                                onDone={() => { setConvertingSymbol(null); load(false); }}
                                onCancel={() => setConvertingSymbol(null)} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
      )}

      {tab === "holdings" && <HoldingsView />}

      {tab === "orders" && (
        loading ? <div className="text-gray-400 text-sm">Loading…</div> :
        error ? <p className="text-red-400 text-sm">{error}</p> :
        orders.length === 0
          ? <p className="text-gray-500 text-sm">No orders today</p>
          : <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 text-xs border-b border-gray-800">
                    <th className="text-left py-2 pr-4">Symbol</th>
                    <th className="text-left pr-4">Side</th>
                    <th className="text-right pr-4">Qty</th>
                    <th className="text-right pr-4">Price</th>
                    <th className="text-left pr-4">Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o, i) => {
                    const isPending = o.status === 6;
                    return (
                      <Fragment key={i}>
                        <tr className="border-b border-gray-800/50">
                          <td className="py-2 pr-4 font-medium text-white">{o.symbol}</td>
                          <td className={`pr-4 font-medium ${o.side === 1 ? "text-green-400" : "text-red-400"}`}>
                            {o.side === 1 ? "BUY" : "SELL"}
                          </td>
                          <td className="text-right pr-4 text-gray-300">{o.qty}</td>
                          <td className="text-right pr-4 text-gray-300">
                            {o.type === 2 ? "MKT" : `₹${parseFloat(o.limitPrice || 0).toFixed(2)}`}
                          </td>
                          <td className={`text-xs font-medium pr-4 ${ORDER_STATUS_COLOR[o.status] || "text-gray-300"}`}>
                            {ORDER_STATUS[o.status] || o.status}
                          </td>
                          <td className="text-right whitespace-nowrap">
                            {isPending && (
                              <>
                                <button onClick={() => setModifyingOrderId(modifyingOrderId === o.id ? null : o.id)}
                                  className="text-[10px] px-2 py-1 bg-gray-800 hover:bg-gray-700 text-gray-300 border border-gray-700 rounded mr-1">
                                  Modify
                                </button>
                                <button onClick={() => handleCancelOrder(o.id)}
                                  className="text-[10px] px-2 py-1 bg-red-900/40 hover:bg-red-900/60 text-red-400 border border-red-800 rounded">
                                  Cancel
                                </button>
                              </>
                            )}
                          </td>
                        </tr>
                        {modifyingOrderId === o.id && (
                          <tr>
                            <td colSpan={6}>
                              <ModifyOrderForm order={o}
                                onDone={() => { setModifyingOrderId(null); load(false); }}
                                onCancel={() => setModifyingOrderId(null)} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
      )}
    </div>
  );
}
