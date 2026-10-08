import { useState, useEffect } from "react";
import { api } from "../api";

export default function NewsAlert({ symbol }) {
  const [alerts, setAlerts] = useState([]);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!symbol) { setAlerts([]); return; }
    let cancelled = false;
    api.getRssAlerts(symbol.symbol)
      .then(data => { if (!cancelled) setAlerts(Array.isArray(data) ? data : []); })
      .catch(() => { if (!cancelled) setAlerts([]); });
    return () => { cancelled = true; };
  }, [symbol]);

  if (!symbol || alerts.length === 0) return null;

  return (
    <div className="bg-yellow-900/20 border border-yellow-800/60 rounded-lg px-4 py-2 mb-4 text-sm">
      <button onClick={() => setExpanded(e => !e)} className="w-full flex items-center justify-between text-left">
        <span className="text-yellow-300 font-medium">
          ⚠ {alerts.length} news {alerts.length === 1 ? "item mentions" : "items mention"} this scrip — review before trading
        </span>
        <span className="text-yellow-500 text-xs">{expanded ? "Hide" : "Show"}</span>
      </button>
      {expanded && (
        <div className="mt-2 space-y-2">
          {alerts.map((a, i) => (
            <div key={i} className="border-t border-yellow-800/40 pt-2">
              <a href={a.link} target="_blank" rel="noopener noreferrer"
                className="text-yellow-200 hover:underline font-medium text-xs">
                {a.title}
              </a>
              <p className="text-[10px] text-gray-500">
                {a.sources.join(" + ")} · {a.pubdate ? new Date(a.pubdate).toLocaleString() : ""}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">{a.summary}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
