import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

function daysBadge(daysAway) {
  const label = daysAway === 0 ? "today" : daysAway === 1 ? "tomorrow" : `in ${daysAway}d`;
  const cls = daysAway <= 1 ? "bg-red-900/40 text-red-400"
    : daysAway <= 3 ? "bg-orange-900/40 text-orange-400"
    : "bg-gray-800 text-gray-400";
  return <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${cls}`}>{label}</span>;
}

function EventRow({ left, title, sub, daysAway, date }) {
  return (
    <div className="flex items-center gap-3 py-1.5 border-b border-gray-800/50 text-xs">
      <span className="text-gray-500 w-24 flex-shrink-0">{date}</span>
      <span className="flex-shrink-0">{daysBadge(daysAway)}</span>
      <div className="flex-1 min-w-0">
        <span className="text-gray-200 font-medium">{left && <span className="text-blue-300 mr-1">{left}</span>}{title}</span>
        {sub && <span className="text-gray-500 ml-1">· {sub}</span>}
      </div>
    </div>
  );
}

function MacroManager({ onChanged }) {
  const [macro, setMacro] = useState([]);
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [category, setCategory] = useState("Macro");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const loadMacro = useCallback(() => {
    api.getMacroEvents().then(m => setMacro(Array.isArray(m) ? m : [])).catch(() => {});
  }, []);
  useEffect(() => { loadMacro(); }, [loadMacro]);

  async function add() {
    if (!name.trim() || !date) return;
    setBusy(true); setError(null);
    try {
      await api.addMacroEvent(name.trim(), date, category.trim() || "Macro");
      setName(""); setDate("");
      loadMacro(); onChanged();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function remove(ev) {
    try { await api.deleteMacroEvent(ev.name, ev.date); loadMacro(); onChanged(); } catch (err) { setError(err.message); }
  }

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-1">Macro & scheduled events</h3>
      <p className="text-[11px] text-gray-500 mb-3">
        RBI policy, CPI/inflation, budget, Fed — no clean public feed exists, so add the ones you care about here (dates are published well in advance).
      </p>
      {macro.length > 0 && (
        <div className="mb-3 space-y-1">
          {macro.map((e, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="text-gray-500 w-24">{e.date}</span>
              <span className="text-[10px] text-purple-300 bg-purple-900/20 rounded px-1.5">{e.category}</span>
              <span className="text-gray-200 flex-1">{e.name}</span>
              <button onClick={() => remove(e)} className="text-[10px] text-gray-500 hover:text-red-400">Remove</button>
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2 items-end">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Event name (e.g. RBI MPC decision)" className="input-field text-xs flex-1 min-w-[180px]" />
        <input type="date" value={date} onChange={e => setDate(e.target.value)} className="input-field text-xs w-40" />
        <select value={category} onChange={e => setCategory(e.target.value)} className="input-field text-xs w-32">
          {["Macro", "RBI", "Inflation", "Global", "Budget", "Other"].map(c => <option key={c}>{c}</option>)}
        </select>
        <button onClick={add} disabled={busy || !name.trim() || !date}
          className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-xs font-medium">
          {busy ? "…" : "Add"}
        </button>
      </div>
      {error && <p className="text-red-400 text-[10px] mt-1">{error}</p>}
    </div>
  );
}

const CA_STYLE = {
  Dividend: "text-green-300 bg-green-900/20",
  Split: "text-blue-300 bg-blue-900/20",
  Bonus: "text-purple-300 bg-purple-900/20",
  Buyback: "text-amber-300 bg-yellow-900/20",
  Rights: "text-orange-300 bg-orange-900/20",
  Other: "text-gray-400 bg-gray-800",
};

// Actual declared corporate actions (dividends/splits/bonuses/buybacks) from NSE, by EX-DATE —
// the date the share price adjusts.
function CorporateActions({ days, foOnly }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    let alive = true;
    api.getCorporateActions(days, foOnly).then(r => alive && setRows(Array.isArray(r) ? r : []))
      .catch(() => alive && setRows([]));
    return () => { alive = false; };
  }, [days, foOnly]);

  if (!rows || rows.length === 0) return null;
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-2">
        Dividends & Corporate Actions {foOnly ? "(F&O stocks)" : ""} — {rows.length}
      </h3>
      <p className="text-[11px] text-gray-500 mb-2">By ex-date — the day the price adjusts (drops ~by the dividend, or splits/bonus-adjusts).</p>
      {rows.map((a, i) => (
        <div key={i} className="flex items-center gap-3 py-1.5 border-b border-gray-800/50 text-xs">
          <span className="text-gray-500 w-24 flex-shrink-0">{a.ex_date}</span>
          <span className="flex-shrink-0">{daysBadge(a.days_away)}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${CA_STYLE[a.type] || CA_STYLE.Other}`}>{a.type}</span>
          <div className="flex-1 min-w-0">
            <span className="text-blue-300 mr-1 font-medium">{a.symbol}</span>
            <span className="text-gray-400">{a.subject}</span>
            {a.is_fo && <span className="ml-1.5 text-[9px] text-amber-300 bg-yellow-900/20 rounded px-1">F&O</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// AI-detected macro events awaiting approval. Nothing here is on the calendar yet — the user
// approves each one (which promotes it to the real macro list) or rejects it.
function MacroSuggestions({ onChanged }) {
  const [pending, setPending] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    api.getMacroSuggestions().then(s => setPending(Array.isArray(s) ? s : [])).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    const id = setInterval(load, 60000); // pick up newly-detected suggestions
    return () => clearInterval(id);
  }, [load]);

  async function act(id, kind) {
    setBusyId(id); setError(null);
    try {
      if (kind === "approve") await api.approveMacroSuggestion(id);
      else await api.rejectMacroSuggestion(id);
      load(); onChanged();
    } catch (err) { setError(err.message); } finally { setBusyId(null); }
  }

  if (pending.length === 0) return null;

  return (
    <div className="bg-yellow-900/10 border border-yellow-800/50 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-yellow-300 mb-1">
        🤖 AI-detected macro events — {pending.length} awaiting your approval
      </h3>
      <p className="text-[11px] text-gray-500 mb-3">
        Found in the news feed. Approve to add to your macro calendar, or reject to dismiss. Nothing is added automatically.
      </p>
      <div className="space-y-2">
        {pending.map(s => (
          <div key={s.id} className="flex flex-wrap items-center gap-2 text-xs border-b border-gray-800/50 pb-2">
            <span className="text-gray-500 w-24 flex-shrink-0">{s.date}</span>
            <span className="text-[10px] text-purple-300 bg-purple-900/20 rounded px-1.5">{s.category}</span>
            <span className="text-gray-200 font-medium flex-1 min-w-[160px]">{s.name}</span>
            {s.source_link ? (
              <a href={s.source_link} target="_blank" rel="noopener noreferrer"
                className="text-[10px] text-gray-500 hover:text-gray-300 truncate max-w-[280px]" title={s.source_title}>
                {s.source_title || "source"} ↗
              </a>
            ) : s.source_title && (
              <span className="text-[10px] text-gray-500 truncate max-w-[280px]" title={s.source_title}>{s.source_title}</span>
            )}
            <div className="flex gap-1.5 flex-shrink-0">
              <button onClick={() => act(s.id, "approve")} disabled={busyId === s.id}
                className="text-[11px] px-2.5 py-1 bg-green-600 hover:bg-green-700 disabled:opacity-50 rounded font-medium">
                {busyId === s.id ? "…" : "Approve"}
              </button>
              <button onClick={() => act(s.id, "reject")} disabled={busyId === s.id}
                className="text-[11px] px-2.5 py-1 text-gray-400 hover:text-red-400 border border-gray-700 rounded">
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && <p className="text-red-400 text-[10px] mt-2">{error}</p>}
    </div>
  );
}

export default function Calendar() {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(14);
  const [foOnly, setFoOnly] = useState(true);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      setData(await api.getUpcomingEvents(days, foOnly));
    } catch (err) { setError(err.message); } finally { setLoading(false); }
  }, [days, foOnly]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-1">
          <div>
            <h2 className="text-sm font-semibold text-gray-300">Economic & Earnings Calendar</h2>
            <p className="text-[11px] text-gray-500">Upcoming F&O stock earnings, corporate actions, and scheduled macro events — from NSE's event calendar.</p>
          </div>
          <div className="flex gap-2 items-center">
            <label className="flex items-center gap-1 text-xs text-gray-400">
              <input type="checkbox" checked={foOnly} onChange={e => setFoOnly(e.target.checked)} /> F&O only
            </label>
            <select value={days} onChange={e => setDays(+e.target.value)} className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300">
              {[7, 14, 30, 60].map(d => <option key={d} value={d}>Next {d}d</option>)}
            </select>
            <button onClick={load} className="text-xs text-gray-400 hover:text-white border border-gray-700 rounded px-3 py-1">Refresh</button>
          </div>
        </div>
      </div>

      <MacroSuggestions onChanged={load} />

      {loading ? <p className="text-gray-400 text-sm">Loading…</p> :
       error ? <p className="text-red-400 text-sm">{error}</p> :
       data && (
        <>
          {data.macro.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-purple-300 mb-2">Macro Events</h3>
              {data.macro.map((e, i) => <EventRow key={i} left={e.category} title={e.name} daysAway={e.days_away} date={e.date} />)}
            </div>
          )}

          <CorporateActions days={days} foOnly={foOnly} />

          <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
            <h3 className="text-sm font-semibold text-gray-300 mb-2">Earnings {foOnly ? "(F&O stocks)" : ""} — {data.earnings.length}</h3>
            {data.earnings.length === 0 ? <p className="text-gray-500 text-xs">None in this window.</p> :
              data.earnings.map((e, i) => <EventRow key={i} left={e.symbol} title={e.company} sub={e.purpose} daysAway={e.days_away} date={e.date} />)}
          </div>

          {data.corporate_actions.length > 0 && (
            <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
              <h3 className="text-sm font-semibold text-gray-300 mb-2">Corporate Actions — {data.corporate_actions.length}</h3>
              {data.corporate_actions.map((e, i) => <EventRow key={i} left={e.symbol} title={e.company} sub={e.purpose} daysAway={e.days_away} date={e.date} />)}
            </div>
          )}

          <MacroManager onChanged={load} />
        </>
      )}
    </div>
  );
}
