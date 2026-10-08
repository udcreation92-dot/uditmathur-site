import { useState, useEffect, useRef } from "react";
import { api } from "../api";
import { toZerodhaOrder } from "../zerodhaSymbol";
import PayoffPanel from "./PayoffPanel";
import { detectStrategyType, parseLeg, daysToNearestExpiry } from "../strategyAnalytics";

// Strategy legs default to MARGIN (Fyers) / NRML (Zerodha, via PRODUCT_TO_ZERODHA) / M
// (Shoonya) rather than intraday — these are multi-day option/futures strategies meant to be
// held overnight, not squared off same-day.
function emptyLeg() {
  return { symbol: "", name: "", side: "BUY", quantity: 1, lot_size: 1, order_type: "LMT", limit_price: 0, product_type: "MARGIN" };
}

const SEGMENT_BADGE = {
  EQUITY: "bg-blue-900/50 text-blue-300",
  INDEX: "bg-purple-900/50 text-purple-300",
  FUTURE: "bg-orange-900/50 text-orange-300",
  OPTION: "bg-pink-900/50 text-pink-300",
  OTHER: "bg-gray-700 text-gray-300",
};

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

// Same search UX as the top-level SymbolSearch (badges, highlight, keyboard nav, expiry
// descriptions) in a compact form that fits a leg row. Selecting carries lot_size through.
function LegSymbolSearch({ value, onChange }) {
  const [query, setQuery] = useState(value.symbol || "");
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const debounceRef = useRef(null);
  const containerRef = useRef(null);

  useEffect(() => {
    setQuery(value.symbol || "");
  }, [value.symbol]);

  useEffect(() => {
    function onClickOutside(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function handleInput(e) {
    const val = e.target.value;
    setQuery(val);
    clearTimeout(debounceRef.current);
    if (val.length < 1) { setResults([]); setOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api.searchScrip(val);
        setResults(Array.isArray(data) ? data : []);
        setOpen(true);
        setActiveIndex(-1);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
  }

  function select(item) {
    onChange({ symbol: item.symbol, name: item.symbol_desc, lot_size: item.lot_size || 1 });
    setQuery(item.symbol);
    setOpen(false);
  }

  function handleKeyDown(e) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" && activeIndex >= 0) { e.preventDefault(); select(results[activeIndex]); }
    else if (e.key === "Escape") setOpen(false);
  }

  return (
    <div className="relative" ref={containerRef}>
      <input
        value={query}
        onChange={handleInput}
        onFocus={() => results.length > 0 && setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder="Search symbol…"
        className="input-field"
      />
      {loading && <div className="absolute right-2 top-2 w-3 h-3 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />}
      {open && results.length > 0 && (
        <div className="absolute z-20 mt-1 w-[26rem] max-w-[80vw] bg-gray-800 border border-gray-700 rounded shadow-xl max-h-64 overflow-y-auto">
          {results.map((r, i) => (
            <button key={r.symbol} onClick={() => select(r)} onMouseEnter={() => setActiveIndex(i)}
              className={`w-full text-left px-3 py-2 flex justify-between items-center gap-2 ${i === activeIndex ? "bg-gray-700" : "hover:bg-gray-700"}`}>
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="text-gray-100 text-xs font-medium truncate">{highlight(r.symbol, query.split(/\s+/)[0])}</span>
                {r.segment && (
                  <span className={`shrink-0 px-1 py-0.5 rounded text-[9px] font-semibold ${SEGMENT_BADGE[r.segment] || SEGMENT_BADGE.OTHER}`}>
                    {r.segment}
                  </span>
                )}
                {r.lot_size > 1 && <span className="shrink-0 text-[9px] text-gray-500">lot {r.lot_size}</span>}
              </span>
              <span className="text-gray-400 text-[11px] truncate shrink-0 max-w-[45%]">{r.symbol_desc}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Compact 5-level order book for a selected leg, Kite/Sensibull order-window style.
// Clicking a price copies it into the leg's limit price.
function MarketDepth({ depth, onPickPrice }) {
  if (!depth) return null;
  const bids = depth.bids || [];
  const asks = depth.ask || depth.asks || [];
  const rows = Math.max(bids.length, asks.length);
  if (rows === 0) return null;
  return (
    <div className="mt-2 grid grid-cols-2 gap-px bg-gray-800 rounded overflow-hidden text-[10px]">
      <div className="bg-gray-900/80 px-2 py-1 flex justify-between text-gray-500 font-semibold">
        <span>BID QTY</span><span className="text-green-500">BID</span>
      </div>
      <div className="bg-gray-900/80 px-2 py-1 flex justify-between text-gray-500 font-semibold">
        <span className="text-red-500">ASK</span><span>ASK QTY</span>
      </div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="contents">
          <button onClick={() => bids[i] && onPickPrice(bids[i].price)} disabled={!bids[i]}
            className="bg-gray-900/40 px-2 py-0.5 flex justify-between hover:bg-gray-800 disabled:cursor-default">
            <span className="text-gray-400">{bids[i]?.volume?.toLocaleString() ?? ""}</span>
            <span className="text-green-400 font-medium">{bids[i]?.price ?? ""}</span>
          </button>
          <button onClick={() => asks[i] && onPickPrice(asks[i].price)} disabled={!asks[i]}
            className="bg-gray-900/40 px-2 py-0.5 flex justify-between hover:bg-gray-800 disabled:cursor-default">
            <span className="text-red-400 font-medium">{asks[i]?.price ?? ""}</span>
            <span className="text-gray-400">{asks[i]?.volume?.toLocaleString() ?? ""}</span>
          </button>
        </div>
      ))}
      <div className="bg-gray-900/80 px-2 py-1 flex justify-between text-gray-500 col-span-2">
        <span>Total bid {depth.totalbuyqty?.toLocaleString()}</span>
        <span>LTP <span className="text-gray-300">{depth.ltp}</span></span>
        <span>Total ask {depth.totalsellqty?.toLocaleString()}</span>
      </div>
    </div>
  );
}

const DEPTH_REFRESH_MS = 10000;

function LegRow({ leg, onChange, onRemove, searchKey }) {
  const [depth, setDepth] = useState(null);
  const depthRef = useRef(null);
  depthRef.current = depth;

  const isLot = leg.lot_size > 1;
  const lots = isLot ? Math.max(1, Math.round(leg.quantity / leg.lot_size)) : leg.quantity;

  // Marketable default: a buyer lifts the ask, a seller hits the bid — prefill the leg's
  // price with the touch on that side (same default Kite's order window uses).
  function defaultPrice(d, side) {
    const best = side === "BUY" ? (d?.ask || d?.asks || [])[0] : (d?.bids || [])[0];
    return best?.price ?? d?.ltp ?? 0;
  }

  // Fetch depth when a symbol is picked, then keep it gently fresh while the leg exists.
  useEffect(() => {
    if (!leg.symbol) { setDepth(null); return; }
    let cancelled = false;
    async function load(applyDefault) {
      try {
        const d = await api.getDepth(leg.symbol);
        if (cancelled) return;
        setDepth(d);
        if (applyDefault) onChange({ limit_price: defaultPrice(d, leg.side) });
      } catch {
        if (!cancelled) setDepth(null);
      }
    }
    load(true);
    const id = setInterval(() => load(false), DEPTH_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leg.symbol]);

  function setSide(side) {
    const patch = { side };
    const d = depthRef.current;
    if (d) patch.limit_price = defaultPrice(d, side);
    onChange(patch);
  }

  function stepLots(delta) {
    const next = Math.max(1, lots + delta);
    onChange({ quantity: isLot ? next * leg.lot_size : next });
  }

  return (
    <div className="bg-gray-800/50 rounded p-3">
      <div className="grid grid-cols-12 gap-2 items-end">
        <div className="col-span-4">
          <label className="block text-[10px] text-gray-500 mb-1">Symbol</label>
          <LegSymbolSearch key={searchKey} value={leg} onChange={patch => {
            const p = { ...patch };
            if (patch.lot_size > 1) p.quantity = patch.lot_size; // 1 lot by default for F&O
            onChange(p);
          }} />
        </div>

        <div className="col-span-2">
          <label className="block text-[10px] text-gray-500 mb-1">Side</label>
          <div className="flex gap-1">
            {["BUY", "SELL"].map(s => (
              <button key={s} onClick={() => setSide(s)}
                className={`flex-1 py-1.5 rounded text-xs font-semibold ${
                  leg.side === s
                    ? s === "BUY" ? "bg-green-600 text-white" : "bg-red-600 text-white"
                    : "bg-gray-700 text-gray-400"
                }`}>
                {s === "BUY" ? "B" : "S"}
              </button>
            ))}
          </div>
        </div>

        <div className="col-span-2">
          <label className="block text-[10px] text-gray-500 mb-1">
            {isLot ? `Lots (×${leg.lot_size})` : "Qty"}
          </label>
          {isLot ? (
            <div className="flex items-stretch gap-1">
              <button onClick={() => stepLots(-1)} disabled={lots <= 1}
                className="w-7 bg-gray-700 hover:bg-gray-600 disabled:opacity-40 rounded text-sm font-bold">−</button>
              <input type="number" min={1} value={lots}
                onChange={e => onChange({ quantity: Math.max(1, +e.target.value || 1) * leg.lot_size })}
                className="input-field text-center w-full" />
              <button onClick={() => stepLots(1)}
                className="w-7 bg-gray-700 hover:bg-gray-600 rounded text-sm font-bold">+</button>
            </div>
          ) : (
            <input type="number" min={1} value={leg.quantity}
              onChange={e => onChange({ quantity: +e.target.value })}
              className="input-field" />
          )}
        </div>

        <div className="col-span-2">
          <label className="block text-[10px] text-gray-500 mb-1">Type</label>
          <select value={leg.order_type} onChange={e => onChange({ order_type: e.target.value })}
            className="input-field">
            <option value="MKT">Market</option>
            <option value="LMT">Limit</option>
          </select>
        </div>

        <div className="col-span-1">
          <label className="block text-[10px] text-gray-500 mb-1">Price</label>
          <input type="number" step="0.05" disabled={leg.order_type === "MKT"} value={leg.limit_price}
            onChange={e => onChange({ limit_price: +e.target.value })}
            className="input-field disabled:opacity-40" />
        </div>

        <div className="col-span-1 flex justify-end">
          <button onClick={onRemove} title="Remove leg"
            className="w-7 h-7 flex items-center justify-center text-gray-500 hover:text-red-400 hover:bg-red-900/20 rounded">
            ✕
          </button>
        </div>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 max-w-md">
          <MarketDepth depth={depth} onPickPrice={price => onChange({ limit_price: price, order_type: "LMT" })} />
        </div>
        {isLot && (
          <p className="text-[10px] text-gray-500 mt-2 shrink-0">{lots} lot{lots > 1 ? "s" : ""} = {leg.quantity} qty</p>
        )}
      </div>
    </div>
  );
}

export default function StrategyBuilder({ prefill }) {
  const [broker, setBroker] = useState("shoonya");
  const [legs, setLegs] = useState([emptyLeg(), emptyLeg()]);
  const [strategyName, setStrategyName] = useState("");
  const [notes, setNotes] = useState("");
  const [margin, setMargin] = useState(null);
  const [payoff, setPayoff] = useState(null); // {maxProfit, maxLoss, profitUnbounded,…} from PayoffPanel
  const [loadingMargin, setLoadingMargin] = useState(false);
  const [error, setError] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [execResult, setExecResult] = useState(null);
  const [lotFactor, setLotFactor] = useState(2);
  // Guards the prefill effect against React StrictMode double-invoking it (which would append
  // the same incoming legs twice) — each prefill token is applied exactly once.
  const lastPrefillToken = useRef(0);

  useEffect(() => {
    const incoming = prefill?.legs;
    const token = prefill?.token;
    if (!incoming || incoming.length === 0 || !token || token === lastPrefillToken.current) return;
    lastPrefillToken.current = token;
    if (prefill.mode === "append") {
      // Append a leg (from the option chain) after any legs the user has already filled in,
      // dropping only the untouched blank rows so it doesn't land behind empty ones.
      setLegs(prev => {
        const filled = prev.filter(l => l.symbol);
        return [...filled, ...incoming];
      });
    } else {
      setLegs(incoming);
      setStrategyName("");
    }
    // Broker handoff: when the caller (e.g. a strategy's what-if) specifies a broker, adopt it so
    // the new legs go to the same broker as that strategy.
    if (prefill.broker) setBroker(prefill.broker);
    setMargin(null);
    setExecResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill?.token]);

  function updateLeg(i, patch) {
    setLegs(prev => prev.map((leg, idx) => idx === i ? { ...leg, ...patch } : leg));
    setMargin(null);
  }

  function addLeg() {
    setLegs(prev => [...prev, emptyLeg()]);
  }

  function removeLeg(i) {
    setLegs(prev => prev.filter((_, idx) => idx !== i));
    setMargin(null);
  }

  // Scale the lots of EVERY leg by a whole-number factor at once — multiplying (not setting)
  // preserves any intentional ratio between legs (e.g. a 1:2 ratio spread stays 1:2). For an
  // F&O leg, quantity = lots × lot_size; for a plain leg (lot_size 1) it just scales quantity.
  function scaleAllLots(factor) {
    if (!(factor >= 1)) return;
    setLegs(prev => prev.map(leg => {
      const lot = leg.lot_size > 1 ? leg.lot_size : 1;
      const currentLots = Math.max(1, Math.round(leg.quantity / lot));
      return { ...leg, quantity: currentLots * factor * lot };
    }));
    setMargin(null);
  }

  const validLegs = legs.filter(l => l.symbol && l.quantity > 0);

  async function calcMargin({ silent = false } = {}) {
    if (validLegs.length === 0) return;
    setLoadingMargin(true);
    // Manual click shows the loading/cleared state and surfaces errors; the auto-recalc runs quietly
    // in the background (no banner flicker, transient failures ignored) so ROI just stays fresh.
    if (!silent) { setError(null); setMargin(null); }
    try {
      if (broker === "zerodha") {
        const result = await api.zerodhaCalculateMargin(validLegs.map(toZerodhaOrder));
        // Basket response: { final: { total } } (SDK already unwraps the outer "data" envelope)
        // — normalize to match the Fyers shape used for display.
        setMargin({ margin_total: result?.final?.total ?? 0 });
      } else {
        const result = await api.calculateMargin(validLegs);
        setMargin(result);
      }
    } catch (err) {
      if (!silent) setError(err.message);
    } finally {
      setLoadingMargin(false);
    }
  }

  // Auto-recalculate margin (→ ROI) whenever the legs settle — so loading a strategy, or editing a
  // leg, refreshes ROI without clicking "Calculate Margin". Debounced so rapid edits (and the depth
  // price prefill that lands just after a symbol is picked) coalesce into one broker call.
  const legsSig = JSON.stringify(validLegs.map(l => [l.symbol, l.side, l.quantity, l.order_type, l.limit_price, l.product_type])) + "|" + broker;
  useEffect(() => {
    if (validLegs.length === 0) return;
    const t = setTimeout(() => calcMargin({ silent: true }), 700);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [legsSig]);

  // Auto-names the strategy from its legs (e.g. "NIFTY Short Strangle") when the user doesn't
  // type one — the name field is no longer required, but strategies row still needs a name.
  function autoName() {
    const type = detectStrategyType(validLegs.map(l => ({ symbol: l.symbol, side: l.side, qty: l.quantity })));
    const root = parseLeg(validLegs[0]?.symbol || "").root;
    return [root, type].filter(Boolean).join(" ") || `Strategy ${new Date().toLocaleString()}`;
  }

  async function requestExecute(useMultileg) {
    setConfirm(useMultileg ? "multileg" : "basket");
  }

  async function confirmExecute() {
    const useMultileg = confirm === "multileg";
    const name = strategyName.trim() || autoName();
    setExecuting(true); setError(null); setExecResult(null); setConfirm(false);
    try {
      if (broker === "zerodha") {
        // Backend places each leg (converting MARKET option legs to protective LIMIT orders,
        // which Kite requires via API) AND records the strategy with broker='zerodha' legs,
        // so it shows up in the same Positions/P&L tracking as Fyers strategies.
        const result = await api.executeZerodhaStrategy(validLegs, name, notes.trim() || undefined);
        setExecResult({ perLeg: true, brokerName: "Zerodha", strategyName: name, ...result });
      } else if (broker === "shoonya") {
        // Backend converts each Fyers leg to its Shoonya contract, places it, and tracks the
        // strategy (allocations stored in Fyers format) so it lands in the same P&L view.
        const result = await api.executeShoonyaStrategy(validLegs, name, notes.trim() || undefined);
        setExecResult({ perLeg: true, brokerName: "Shoonya", strategyName: name, ...result });
      } else {
        const result = useMultileg
          ? await api.executeMultileg(validLegs, name, notes.trim() || undefined)
          : await api.executeStrategy(validLegs, name, notes.trim() || undefined);
        setExecResult({ strategyName: name, ...result });
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setExecuting(false);
    }
  }

  const canMultileg = validLegs.length === 2 || validLegs.length === 3;

  const netPremium = validLegs.reduce((sum, l) => {
    const sign = l.side === "BUY" ? -1 : 1;
    return sum + sign * (l.limit_price || 0) * l.quantity;
  }, 0);

  // Return on margin: the strategy's best-case expiry profit (from the payoff curve, which uses
  // live/limit premiums) over the broker margin blocked. Annualized to p.a. via the nearest leg's
  // days-to-expiry so it lines up with how ROI reads elsewhere (Positions, T-Bills). Only meaningful
  // when max profit is bounded (a net-long/debit structure has unlimited upside → no ROI-on-margin)
  // and after the user has calculated margin.
  const roi = (() => {
    const mp = payoff?.maxProfit, mt = margin?.margin_total;
    if (!(mt > 0) || mp == null || payoff?.profitUnbounded) return null;
    const ror = (mp / mt) * 100;
    const dte = daysToNearestExpiry(validLegs);
    return { ror, pa: dte && dte > 0 ? ror * (365 / dte) : null, dte };
  })();

  return (
    <div className="space-y-4">
      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <div className="flex justify-between items-center mb-3">
          <h2 className="text-sm font-semibold text-gray-300">Strategy Legs</h2>
          <div className="flex items-center gap-3">
            <span className="text-xs text-gray-400">Execute via:</span>
            <div className="flex gap-2">
              {["fyers", "zerodha", "shoonya"].map(b => (
                <button key={b} onClick={() => { setBroker(b); setExecResult(null); setMargin(null); }}
                  className={`px-3 py-1 rounded text-xs font-semibold capitalize ${
                    broker === b ? "bg-blue-600 text-white" : "bg-gray-800 text-gray-400 hover:bg-gray-700"
                  }`}>
                  {b}
                </button>
              ))}
            </div>
            <button onClick={addLeg} className="text-xs px-3 py-1.5 bg-blue-600 hover:bg-blue-700 rounded font-medium">
              + Add Leg
            </button>
          </div>
        </div>

        {validLegs.length > 0 && (
          <div className="flex items-center gap-2 mb-3 text-xs text-gray-400">
            <span>Scale all legs:</span>
            {[2, 3, 5].map(f => (
              <button key={f} onClick={() => scaleAllLots(f)}
                className="px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-200 font-medium">
                ×{f}
              </button>
            ))}
            <span className="mx-1 text-gray-600">or</span>
            <input type="number" min={1} step={1} value={lotFactor}
              onChange={e => setLotFactor(Math.max(1, Math.floor(+e.target.value) || 1))}
              className="input-field w-16 text-center" />
            <button onClick={() => scaleAllLots(lotFactor)}
              className="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white font-medium">
              × Apply
            </button>
            <span className="text-[10px] text-gray-500">multiplies every leg's lots, keeping their ratio</span>
          </div>
        )}

        <div className="space-y-3">
          {legs.map((leg, i) => (
            <LegRow key={i} leg={leg} searchKey={`${i}-${prefill?.token ?? 0}`}
              onChange={patch => updateLeg(i, patch)} onRemove={() => removeLeg(i)} />
          ))}
        </div>

        {legs.length === 0 && (
          <p className="text-gray-500 text-sm py-4 text-center">No legs added. Click "+ Add Leg" to start.</p>
        )}
      </div>

      <PayoffPanel legs={validLegs} onAnalysis={setPayoff} />

      <div className="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <div className="mb-3">
          <label className="block text-[10px] text-gray-500 mb-1">Strategy Name (optional — auto-generated if left blank)</label>
          <input value={strategyName} onChange={e => setStrategyName(e.target.value)}
            placeholder="e.g. NIFTY 24000 Short Straddle"
            className="input-field max-w-sm" />
        </div>
        <div className="mb-3">
          <label className="block text-[10px] text-gray-500 mb-1">Journal Notes (why entering, plan, exit rule)</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
            placeholder="e.g. IV high pre-event, selling strangle; exit at 60% premium or SL 2x credit"
            className="input-field w-full max-w-xl" />
        </div>

        <div className="flex flex-wrap gap-3 items-center justify-between">
          <div className="flex gap-6 text-sm">
            <span className="text-gray-400">
              Net Premium: <span className={`font-semibold ${netPremium >= 0 ? "text-green-400" : "text-red-400"}`}>
                {netPremium >= 0 ? "+" : ""}₹{netPremium.toFixed(2)}
              </span>
            </span>
            {margin && (
              <span className="text-gray-400">
                Margin Required: <span className="font-semibold text-yellow-400">₹{margin.margin_total?.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
              </span>
            )}
            {roi && (
              <span className="text-gray-400" title="Best-case expiry profit ÷ margin blocked. Annualized (p.a.) via nearest-leg days to expiry.">
                ROI: <span className={`font-semibold ${roi.ror >= 0 ? "text-green-400" : "text-red-400"}`}>{roi.ror.toFixed(1)}%</span>
                {roi.pa != null && <span className="text-gray-500"> ({roi.pa.toFixed(0)}% p.a.{roi.dte ? `, ${Math.round(roi.dte)}d` : ""})</span>}
              </span>
            )}
          </div>
          <button onClick={calcMargin} disabled={loadingMargin || validLegs.length === 0}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-sm font-medium">
            {loadingMargin ? "Calculating…" : "Calculate Margin"}
          </button>
        </div>

        {error && <p className="text-red-400 text-sm bg-red-900/20 border border-red-800 rounded p-2 mt-3">{error}</p>}

        {execResult && (
          <div className={`border rounded p-3 text-sm mt-3 ${
            execResult.perLeg && !execResult.all_ok
              ? "bg-yellow-900/30 border-yellow-700" : "bg-green-900/30 border-green-700"
          }`}>
            {execResult.perLeg ? (
              <div className="space-y-1">
                <p className={`font-medium ${execResult.all_ok ? "text-green-400" : "text-yellow-300"}`}>
                  {execResult.all_ok
                    ? <>{execResult.brokerName} strategy "{execResult.strategyName}" placed and tracked (#{execResult.strategy_id}) — check the Positions tab.</>
                    : execResult.strategy_id
                      ? <>Some {execResult.brokerName} legs failed — the filled legs are tracked as "{execResult.strategyName}" (#{execResult.strategy_id}). Review and retry the failed legs:</>
                      : <>All {execResult.brokerName} legs failed — nothing was placed or tracked:</>}
                </p>
                {execResult.legs.map((r, i) => (
                  <p key={i} className={r.ok ? "text-gray-300" : "text-red-400"}>
                    {r.symbol} {r.side} {r.qty}: {r.ok
                      ? <>Order {r.order_id}{r.protected_limit && <span className="text-gray-500"> · market → protective limit @ ₹{r.price}</span>}</>
                      : r.message}
                  </p>
                ))}
              </div>
            ) : (
              <p className="text-green-400 font-medium">
                Strategy "{execResult.strategyName}" submitted (#{execResult.strategy_id})! Legs are now tracked — check the Positions tab.
              </p>
            )}
          </div>
        )}

        {confirm && (
          <div className="bg-yellow-900/30 border border-yellow-700 rounded p-3 text-sm mt-3">
            <p className="text-yellow-300 font-medium">
              Confirm: place {validLegs.length} order{validLegs.length !== 1 ? "s" : ""} for this strategy
              {confirm === "multileg" ? " as a single multileg order (IOC, atomic)?" : " as independent basket orders?"}
            </p>
          </div>
        )}

        <div className="flex gap-2 mt-3">
          {confirm ? (
            <>
              <button onClick={confirmExecute} disabled={executing}
                className="flex-1 py-2.5 rounded text-sm font-semibold disabled:opacity-50 bg-yellow-600 hover:bg-yellow-700 text-white">
                {executing ? "Executing…" : "Confirm & Execute"}
              </button>
              <button onClick={() => setConfirm(false)} className="px-4 text-xs text-gray-400 hover:text-gray-200">
                Cancel
              </button>
            </>
          ) : (
            <>
              <button onClick={() => requestExecute(false)} disabled={executing || validLegs.length === 0}
                className="flex-1 py-2.5 rounded text-sm font-semibold disabled:opacity-50 bg-green-600 hover:bg-green-700 text-white">
                Execute Strategy
              </button>
              <button onClick={() => requestExecute(true)} disabled={executing || !canMultileg || broker !== "fyers"}
                title={broker !== "fyers" ? "No atomic multileg order type on this broker — switch to Fyers to use it"
                  : canMultileg ? "Places all legs as one atomic multileg order" : "Multileg requires exactly 2 or 3 legs"}
                className="flex-1 py-2.5 rounded text-sm font-semibold disabled:opacity-50 bg-blue-600 hover:bg-blue-700 text-white">
                Execute as Multileg
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
