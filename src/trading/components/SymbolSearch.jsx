import { useState, useRef, useEffect } from "react";
import { api } from "../api";
import { fyersToZerodha } from "../zerodhaSymbol";
import LivePrice from "./LivePrice";

const SEGMENT_FILTERS = [
  { id: null, label: "All" },
  { id: "EQUITY", label: "Stocks" },
  { id: "INDEX", label: "Indices" },
  { id: "FUTURE", label: "Futures" },
  { id: "OPTION", label: "Options" },
];

const SEGMENT_BADGE = {
  EQUITY: "bg-blue-900/50 text-blue-300",
  INDEX: "bg-purple-900/50 text-purple-300",
  FUTURE: "bg-orange-900/50 text-orange-300",
  OPTION: "bg-pink-900/50 text-pink-300",
  OTHER: "bg-gray-700 text-gray-300",
};

// Opens the symbol's chart on Kite via its deep-link route:
//   kite.zerodha.com/markets/ext/chart/web/tvc/{EXCHANGE}/{TRADINGSYMBOL}/{INSTRUMENT_TOKEN}
// Exchange + tradingsymbol come from the Fyers symbol; the instrument token is resolved by the
// backend (kite.ltp). The tab is opened synchronously on click (so popup-blockers allow it),
// then pointed at the chart URL once the token comes back. Requires being logged into Kite.
function openKiteChart(selected, onError) {
  const { exchange, tradingsymbol } = fyersToZerodha(selected.symbol);
  const win = window.open("about:blank", "kiteChartTab");
  api.zerodhaInstrumentToken(`${exchange}:${tradingsymbol}`)
    .then(({ instrument_token }) => {
      const url = `https://kite.zerodha.com/markets/ext/chart/web/tvc/${exchange}/${encodeURIComponent(tradingsymbol)}/${instrument_token}`;
      if (win) win.location = url; else window.open(url, "kiteChartTab");
    })
    .catch(err => {
      if (win) win.close();
      onError?.(`Couldn't open Kite chart: ${err.message}`);
    });
}

function highlight(text, query) {
  if (!query) return text;
  const idx = text.toUpperCase().indexOf(query.toUpperCase());
  if (idx === -1) return text;
  return (
    <>
      {text.slice(0, idx)}
      <span className="text-blue-400 font-semibold">{text.slice(idx, idx + query.length)}</span>
      {text.slice(idx + query.length)}
    </>
  );
}

export default function SymbolSearch({ onSelect, selected }) {
  const [query, setQuery] = useState("");
  const [segment, setSegment] = useState(null);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [chartError, setChartError] = useState(null);
  const debounceRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    function onClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function runSearch(val, seg) {
    clearTimeout(debounceRef.current);
    if (val.length < 1) { setResults([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true); setError(null);
      try {
        const data = await api.searchScrip(val, seg);
        setResults(Array.isArray(data) ? data : []);
        setOpen(true);
        setActiveIndex(-1);
      } catch (err) {
        setError(err.message);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
  }

  function handleInput(e) {
    const val = e.target.value;
    setQuery(val);
    runSearch(val, segment);
  }

  function handleSegment(seg) {
    setSegment(seg);
    if (query) runSearch(query, seg);
  }

  function select(item) {
    onSelect({ symbol: item.symbol, name: item.symbol_desc || item.symbol });
    setQuery("");
    setResults([]);
    setOpen(false);
  }

  function clear() {
    setQuery(""); setResults([]); setOpen(false);
    onSelect(null);
  }

  function handleKeyDown(e) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(i => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && activeIndex >= 0) {
      e.preventDefault();
      select(results[activeIndex]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div className="relative" ref={containerRef}>
      <div className="relative">
        <input
          value={query}
          onChange={handleInput}
          onFocus={() => query && results.length > 0 && setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="Search symbol (e.g. RELIANCE, NIFTY, SBIN)…"
          className="w-full bg-gray-800 border border-gray-700 rounded px-4 py-2 pr-9 text-sm text-gray-100 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
        {loading && (
          <div className="absolute right-3 top-2.5 w-4 h-4 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
        )}
        {!loading && query && (
          <button
            onClick={clear}
            className="absolute right-2.5 top-1.5 w-6 h-6 flex items-center justify-center text-gray-500 hover:text-gray-200 rounded"
            aria-label="Clear"
          >
            ✕
          </button>
        )}
      </div>

      <div className="flex gap-1.5 mt-2">
        {SEGMENT_FILTERS.map(f => (
          <button
            key={f.label}
            onClick={() => handleSegment(f.id)}
            className={`px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
              segment === f.id
                ? "bg-blue-600 text-white"
                : "bg-gray-800 text-gray-400 hover:bg-gray-700"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {selected && (
        <div className="mt-2 flex items-center gap-3 flex-wrap text-sm">
          <span className="text-gray-400">Selected:</span>
          <span className="text-white font-medium">{selected.symbol}</span>
          {selected.name && <span className="text-gray-500 text-xs">— {selected.name}</span>}
          <LivePrice symbol={selected.symbol} />
          <button
            onClick={() => { setChartError(null); openKiteChart(selected, setChartError); }}
            title="Open this script's chart on kite.zerodha.com (requires being logged into Kite)"
            className="text-xs px-2 py-1 bg-gray-800 hover:bg-gray-700 rounded text-blue-300 whitespace-nowrap"
          >
            Open in Kite ↗
          </button>
          {chartError && <span className="text-red-400 text-xs">{chartError}</span>}
        </div>
      )}

      {error && <p className="text-red-400 text-xs mt-1">{error}</p>}

      {open && (
        <div className="absolute z-10 mt-1 w-full bg-gray-800 border border-gray-700 rounded shadow-xl max-h-72 overflow-y-auto">
          {results.length === 0 ? (
            <div className="px-4 py-3 text-sm text-gray-500">No matches for "{query}"</div>
          ) : (
            results.map((item, i) => (
              <button
                key={item.symbol}
                onClick={() => select(item)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`w-full text-left px-4 py-2.5 flex justify-between items-center gap-3 ${
                  i === activeIndex ? "bg-gray-700" : "hover:bg-gray-700"
                }`}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-medium text-gray-100 text-sm truncate">
                    {highlight(item.symbol, query)}
                  </span>
                  {item.segment && (
                    <span className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold ${SEGMENT_BADGE[item.segment] || SEGMENT_BADGE.OTHER}`}>
                      {item.segment}
                    </span>
                  )}
                </div>
                <span className="text-gray-400 text-xs truncate shrink-0 max-w-[45%]">{item.symbol_desc}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
