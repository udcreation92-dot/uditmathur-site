import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api";

const money = (v) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}₹${Math.abs(Math.round(v)).toLocaleString("en-IN")}`);
const STATUS_STYLE = {
  WAITING: "bg-yellow-900/30 text-yellow-300 border-yellow-800",
  ENTERING: "bg-blue-900/30 text-blue-300 border-blue-800",
  OPEN: "bg-green-900/30 text-green-300 border-green-800",
  EXITING: "bg-orange-900/30 text-orange-300 border-orange-800",
  CLOSED: "bg-gray-800 text-gray-400 border-gray-700",
  CANCELLED: "bg-gray-800 text-gray-500 border-gray-700",
};

// ---- Add-scalp form ----------------------------------------------------------------------------
function AddScalp({ onAdded }) {
  const [query, setQuery] = useState("");
  const [sugg, setSugg] = useState([]);
  const [pick, setPick] = useState(null); // { symbol, symbol_desc }
  const [side, setSide] = useState("BUY");
  const [entry, setEntry] = useState("");
  const [sl, setSl] = useState("");
  const [target, setTarget] = useState("");
  const [maxLoss, setMaxLoss] = useState(100);
  const [tradeType, setTradeType] = useState("MIS");
  const [broker, setBroker] = useState("fyers");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!query.trim() || pick) { setSugg([]); return; }
    const t = setTimeout(() => api.searchScrip(query.trim(), "EQUITY")
      .then(r => setSugg((r || []).filter(s => s.segment === "EQUITY").slice(0, 7))).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [query, pick]);

  const qty = (+maxLoss > 0 && +entry > 0 && +sl > 0 && Math.abs(+sl - +entry) > 0)
    ? Math.floor(+maxLoss / Math.abs(+sl - +entry)) : 0;

  async function add() {
    setBusy(true); setError(null);
    try {
      await api.createScalp({
        symbol: pick.symbol, name: pick.symbol_desc, side, entry_price: +entry, sl_price: +sl,
        target_price: +target, max_loss: +maxLoss, trade_type: tradeType, broker,
      });
      setPick(null); setQuery(""); setEntry(""); setSl(""); setTarget("");
      onAdded();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const canAdd = pick && +entry > 0 && +sl > 0 && +target > 0 && qty >= 1 && !busy;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-3">+ New scalp opportunity</h3>
      <div className="flex flex-wrap items-end gap-2">
        <div className="relative">
          <label className="block text-[10px] text-gray-500 mb-0.5">Equity script</label>
          {pick ? (
            <span className="inline-flex items-center gap-1.5 bg-gray-800 border border-gray-700 rounded px-2 py-1.5 text-gray-200">
              {pick.symbol.replace("NSE:", "").replace("-EQ", "")}
              <button onClick={() => { setPick(null); setQuery(""); }} className="text-gray-500 hover:text-red-400">×</button>
            </span>
          ) : (
            <>
              <input value={query} onChange={e => setQuery(e.target.value)} placeholder="e.g. RELIANCE" className="input-field text-xs w-44" />
              {sugg.length > 0 && (
                <div className="absolute z-10 mt-1 w-64 bg-gray-800 border border-gray-700 rounded shadow-lg max-h-52 overflow-y-auto">
                  {sugg.map(s => (
                    <button key={s.symbol} onClick={() => { setPick(s); setSugg([]); }}
                      className="block w-full text-left px-2 py-1 hover:bg-gray-700 text-gray-200 text-xs">
                      {s.symbol.replace("NSE:", "").replace("-EQ", "")} <span className="text-gray-500">{s.symbol_desc}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Side</label>
          <div className="flex gap-1">
            {["BUY", "SELL"].map(sd => (
              <button key={sd} onClick={() => setSide(sd)} className={`px-2 py-1 rounded text-xs ${side === sd ? (sd === "BUY" ? "bg-green-600 text-white" : "bg-red-600 text-white") : "bg-gray-800 text-gray-400"}`}>{sd}</button>
            ))}
          </div>
        </div>
        {[["Entry", entry, setEntry], ["Stoploss", sl, setSl], ["Target", target, setTarget], ["Max loss ₹", maxLoss, setMaxLoss]].map(([lbl, val, set]) => (
          <label key={lbl} className="block text-[10px] text-gray-500">{lbl}
            <input type="number" step="0.05" value={val} onChange={e => set(e.target.value)} className="input-field text-xs w-24 block mt-0.5" /></label>
        ))}
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Type</label>
          <select value={tradeType} onChange={e => setTradeType(e.target.value)} className="input-field text-xs w-20"><option>MIS</option><option>CNC</option></select>
        </div>
        <div>
          <label className="block text-[10px] text-gray-500 mb-0.5">Broker</label>
          <select value={broker} onChange={e => setBroker(e.target.value)} className="input-field text-xs w-24">{["fyers", "zerodha", "shoonya"].map(b => <option key={b}>{b}</option>)}</select>
        </div>
        <div className="px-3 py-1.5 bg-gray-800 rounded border border-gray-700">
          <div className="text-[10px] text-gray-500">Tradable qty</div>
          <div className={`text-sm font-semibold ${qty >= 1 ? "text-indigo-300" : "text-red-400"}`}>{qty}</div>
        </div>
        <button onClick={add} disabled={!canAdd} className="px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 rounded text-sm font-medium">
          {busy ? "Adding…" : "Arm scalp"}
        </button>
      </div>
      <p className="text-[10px] text-gray-600 mt-2">Qty = Max Loss ÷ |Stoploss − Entry|. Entry fires as a LIMIT when the {side === "BUY" ? "ask reaches your entry" : "bid reaches your entry"}; exits fire on target/SL (bid for a long, ask for a short).</p>
      {error && <p className="text-red-400 text-xs mt-1">{error}</p>}
    </div>
  );
}

// ---- One scalp row -----------------------------------------------------------------------------
function ScalpRow({ s, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [t, setT] = useState(s.target_price);
  const [sl, setSl] = useState(s.sl_price);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const live = s.status === "OPEN" || s.status === "EXITING";
  const pnl = live ? s.unrealized_pnl : (s.status === "CLOSED" ? s.realized_pnl : null);

  const act = (fn) => async () => { setBusy(true); setMsg(null); try { const r = await fn(); if (r?.warning) setMsg(r.warning); onChanged(); } catch (e) { setMsg(e.message); } finally { setBusy(false); } };
  const lbl = s.symbol.replace("NSE:", "").replace("-EQ", "");

  const ev = s.earnings_event;
  const news = s.news || [];
  const hasRisk = ev || news.length > 0;

  return (
    <div className={`bg-gray-900/60 border rounded-lg p-3 text-xs ${hasRisk ? "border-amber-800/70" : "border-gray-800"}`}>
      {hasRisk && (s.status === "WAITING" || s.status === "OPEN" || s.status === "ENTERING" || s.status === "EXITING") && (
        <div className="flex flex-wrap items-center gap-2 mb-2 bg-amber-900/20 border border-amber-800 rounded px-2 py-1">
          {ev && <span className="text-amber-300 font-semibold">📅 {ev.purpose || "Results"} {ev.days_away === 0 ? "TODAY" : ev.days_away === 1 ? "TOMORROW" : `in ${ev.days_away}d`} ({ev.date})</span>}
          {news.length > 0 && <span className="text-amber-200" title={news.map(n => n.title || n.headline).join("\n")}>📰 {news.length} news item{news.length !== 1 ? "s" : ""}: <span className="text-gray-400">{(news[0].title || news[0].headline || "").slice(0, 60)}…</span></span>}
          {!s.paused && (s.status === "WAITING" || s.status === "OPEN") && <span className="text-gray-500">— consider pausing.</span>}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className={`px-2 py-0.5 rounded border text-[10px] font-semibold ${STATUS_STYLE[s.status]}`}>{s.status}</span>
        {s.paused ? <span className="px-2 py-0.5 rounded border text-[10px] font-semibold bg-purple-900/30 text-purple-300 border-purple-800">⏸ PAUSED</span> : null}
        {s.status === "WAITING" && s.arm_state === "INACTIVE" ? (
          <span className="px-2 py-0.5 rounded border text-[10px] font-semibold bg-gray-800 text-gray-400 border-gray-700"
            title={`Inactive — opened on the wrong side of the entry (${s.entry_price}). The entry won't fire until price first reaches the target (${s.target_price}). Protects against an open/switch-on gap firing instantly.`}>
            💤 INACTIVE · awaiting target {s.target_price}
          </span>
        ) : null}
        {s.status === "WAITING" && s.arm_state === "ARMED" ? (
          <span className="px-2 py-0.5 rounded border text-[10px] font-semibold bg-blue-900/30 text-blue-300 border-blue-800"
            title={`Armed — on the waiting side of the entry; now waiting for the entry price (${s.entry_price}) to trigger.`}>
            ⚡ ARMED
          </span>
        ) : null}
        {s.status === "WAITING" && s.arm_state === "PENDING" ? (
          <span className="px-2 py-0.5 rounded border text-[10px] font-semibold bg-gray-800 text-gray-500 border-gray-700"
            title="Arm/inactive is decided on the first live tick at market open (or when auto-trade is switched on), based on price vs the entry.">
            ⏳ arms at open
          </span>
        ) : null}
        <span className="text-gray-100 font-semibold">{lbl}</span>
        <span className={s.side === "BUY" ? "text-green-400" : "text-red-400"}>{s.side}</span>
        <span className="text-gray-400">{s.qty} qty · {s.trade_type} · {s.broker}</span>
        <span className="text-gray-500">Entry {s.entry_fill_price ?? s.entry_price} · SL {s.sl_price} · Tgt {s.target_price}</span>
        {s.ltp != null && <span className="text-gray-400">LTP <span className="text-gray-200">{s.ltp}</span>{s.bid != null && <span className="text-gray-600"> ({s.bid}/{s.ask})</span>}</span>}
        {pnl != null && <span className={`font-semibold ml-auto ${pnl >= 0 ? "text-green-400" : "text-red-400"}`}>{money(pnl)}{s.status === "CLOSED" && s.exit_reason ? ` · ${s.exit_reason}` : ""}</span>}
      </div>

      {(s.status === "WAITING" || s.status === "OPEN") && (
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {!editing ? (
            <>
              <button onClick={() => setEditing(true)} className="text-[11px] text-blue-300 hover:text-blue-200 border border-gray-700 rounded px-2 py-0.5">Edit SL/Target</button>
              <button onClick={act(() => api.pauseScalp(s.id, !s.paused))} disabled={busy}
                title={s.paused ? "Resume auto entry/exit for this scalp" : "Pause auto entry/exit for this scalp (e.g. around an event) — it still shows and can be exited manually"}
                className={`text-[11px] border rounded px-2 py-0.5 ${s.paused ? "text-green-300 border-green-800 hover:text-green-200" : "text-purple-300 border-purple-800 hover:text-purple-200"}`}>
                {s.paused ? "▶ Resume" : "⏸ Pause"}
              </button>
              {s.status === "OPEN" && <button onClick={act(() => api.exitScalp(s.id))} disabled={busy} className="text-[11px] text-red-300 hover:text-red-200 border border-red-800 bg-red-900/20 rounded px-2 py-0.5">Exit now</button>}
              {s.status === "OPEN" && <button onClick={act(() => api.scalpTradeType(s.id, s.trade_type === "MIS" ? "CNC" : "MIS"))} disabled={busy} className="text-[11px] text-amber-300 hover:text-amber-200 border border-yellow-800 rounded px-2 py-0.5">→ {s.trade_type === "MIS" ? "CNC" : "MIS"}</button>}
              {s.status === "WAITING" && <button onClick={act(() => api.cancelScalp(s.id))} disabled={busy} className="text-[11px] text-gray-400 hover:text-red-400 border border-gray-700 rounded px-2 py-0.5">Cancel</button>}
            </>
          ) : (
            <>
              <label className="text-gray-500">Target <input type="number" step="0.05" value={t} onChange={e => setT(e.target.value)} className="input-field text-xs w-20 ml-1" /></label>
              <label className="text-gray-500">SL <input type="number" step="0.05" value={sl} onChange={e => setSl(e.target.value)} className="input-field text-xs w-20 ml-1" /></label>
              <button onClick={act(async () => { await api.editScalp(s.id, { target_price: +t, sl_price: +sl }); setEditing(false); })} disabled={busy} className="text-[11px] px-2 py-0.5 bg-blue-600 hover:bg-blue-700 rounded">Save</button>
              <button onClick={() => setEditing(false)} className="text-gray-400 hover:text-gray-200">Cancel</button>
            </>
          )}
          {msg && <span className="text-amber-400 w-full">{msg}</span>}
        </div>
      )}
      {(s.status === "CLOSED" || s.status === "CANCELLED") && (
        <button onClick={act(() => api.deleteScalp(s.id))} disabled={busy} className="text-[10px] text-gray-500 hover:text-red-400 mt-1">remove</button>
      )}
    </div>
  );
}

// ---- Page --------------------------------------------------------------------------------------
export default function Scalps() {
  const [data, setData] = useState({ scalps: [], auto_enabled: false });
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try { const [d, r] = await Promise.all([api.listScalps(), api.scalpReport()]); setData(d); setReport(r); }
    catch (e) { setError(e.message); } finally { busyRef.current = false; }
  }, []);

  useEffect(() => { load(); const id = setInterval(load, 3000); return () => clearInterval(id); }, [load]);

  async function toggleAuto() {
    try { await api.setScalpAuto(!data.auto_enabled); load(); } catch (e) { setError(e.message); }
  }

  const scalps = data.scalps;
  const waiting = scalps.filter(s => ["WAITING", "ENTERING"].includes(s.status));
  const open = scalps.filter(s => ["OPEN", "EXITING"].includes(s.status));
  const done = scalps.filter(s => ["CLOSED", "CANCELLED"].includes(s.status));

  return (
    <div className="space-y-4">
      {/* Auto-trade master switch */}
      <div className="flex flex-wrap items-center justify-between gap-3 bg-gray-900 border border-gray-800 rounded-lg px-4 py-2.5">
        <div>
          <h2 className="text-sm font-semibold text-gray-200">Cash-Segment Scalping</h2>
          <p className="text-[11px] text-gray-500">Auto-enter on the entry price (bid/ask, not LTP) and auto-manage target/SL. Off = paused, but open scalps still show and can be exited manually.</p>
        </div>
        <button onClick={toggleAuto}
          className={`px-4 py-2 rounded font-semibold text-sm border ${data.auto_enabled ? "bg-green-700 border-green-600 text-white" : "bg-gray-800 border-gray-700 text-gray-300"}`}>
          {data.auto_enabled ? "⚡ AUTO-TRADE: ON" : "AUTO-TRADE: OFF"}
        </button>
      </div>

      {report && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2">
          {[["Total P&L", money(report.total_pnl), report.total_pnl], ["Realized", money(report.realized_pnl), report.realized_pnl],
            ["Open P&L", money(report.unrealized_pnl), report.unrealized_pnl], ["Win rate", report.win_rate != null ? report.win_rate + "%" : "—"],
            ["Closed", `${report.closed_count} (${report.wins}W/${report.losses}L)`], ["Open", report.open_count], ["Waiting", report.waiting_count]].map(([l, v, tone]) => (
            <div key={l} className="bg-gray-900/60 rounded-lg px-3 py-2">
              <div className="text-[11px] text-gray-500">{l}</div>
              <div className={`text-[15px] font-semibold mt-0.5 ${tone == null ? "text-gray-200" : tone >= 0 ? "text-green-400" : "text-red-400"}`}>{v}</div>
            </div>
          ))}
        </div>
      )}

      <AddScalp onAdded={load} />
      {error && <p className="text-red-400 text-sm">{error}</p>}

      {open.length > 0 && <div><h3 className="text-xs font-semibold text-green-300 mb-2">Open scalps</h3><div className="space-y-2">{open.map(s => <ScalpRow key={s.id} s={s} onChanged={load} />)}</div></div>}
      {waiting.length > 0 && <div><h3 className="text-xs font-semibold text-yellow-300 mb-2">Waiting for entry</h3><div className="space-y-2">{waiting.map(s => <ScalpRow key={s.id} s={s} onChanged={load} />)}</div></div>}
      {done.length > 0 && <div><h3 className="text-xs font-semibold text-gray-400 mb-2">Completed</h3><div className="space-y-2">{done.map(s => <ScalpRow key={s.id} s={s} onChanged={load} />)}</div></div>}
      {scalps.length === 0 && <p className="text-gray-500 text-sm">No scalps yet — arm one above.</p>}
    </div>
  );
}
