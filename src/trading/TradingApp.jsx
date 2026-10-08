import { useState, useEffect } from "react";
import { useAuthStatus, LoginPrompt } from "./components/LoginGate";
import SymbolSearch from "./components/SymbolSearch";
import AnalysisPanel from "./components/AnalysisPanel";
import OrderPanel from "./components/OrderPanel";
import Positions from "./components/Positions";
import OptionChain from "./components/OptionChain";
import StrategyBuilder from "./components/StrategyBuilder";
import RoiScanner from "./components/RoiScanner";
import SpreadScanner from "./components/SpreadScanner";
import TBills from "./components/TBills";
import Scalps from "./components/Scalps";
import VolatilityScanner from "./components/VolatilityScanner";
import BrokerFunds from "./components/BrokerFunds";
import GttOrders from "./components/GttOrders";
import Alerts from "./components/Alerts";
import Reports from "./components/Reports";
import NewsAlert from "./components/NewsAlert";
import HolidayAlert from "./components/HolidayAlert";
import EventNotifications from "./components/EventNotifications";
import Calendar from "./components/Calendar";
import AssistantChat from "./components/AssistantChat";
import { api } from "./api";

const SYMBOL_TABS = [
  { id: "analysis", label: "Analysis" },
  { id: "options", label: "Option Chain" },
  { id: "order", label: "Place Order" },
  { id: "roi", label: "ROI Scanner" },
  { id: "spread", label: "Spread Scanner" },
  { id: "gtt", label: "GTT Orders" },
  { id: "alerts", label: "Alerts" },
];
const GLOBAL_TABS = [
  { id: "strategy", label: "Strategy Builder" },
  { id: "positions", label: "Positions" },
  { id: "scalps", label: "Cash / Scalps" },
  { id: "reports", label: "Reports" },
  { id: "tbills", label: "T-Bills" },
  { id: "calendar", label: "Calendar" },
  { id: "volatility", label: "Volatility Scanner" },
];

function MarketStatusBanner() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    api.getMarketStatus().then(setStatus).catch(() => {});
  }, []);

  if (!status) return null;
  const nse = status.find(s => s.exchange === 10 && s.market_type === "NORMAL");
  if (!nse || nse.status === "OPEN") return null;

  return (
    <span className="tt-status-pill" title="NSE is not open — live prices may be stale">
      NSE {nse.status} — PRICES STALE
    </span>
  );
}

// Function-key strip → maps to real tabs (symbol-scoped ones stay gated by `symbol`).
const FN_KEYS = [
  { k: "F1", label: "ANALYSIS", tab: "analysis" },
  { k: "F2", label: "OPT CHAIN", tab: "options" },
  { k: "F3", label: "ORDER", tab: "order" },
  { k: "F4", label: "ROI SCAN", tab: "roi" },
  { k: "F5", label: "STRATEGY", tab: "strategy" },
  { k: "F6", label: "POSITIONS", tab: "positions" },
  { k: "F7", label: "REPORTS", tab: "reports" },
  { k: "F8", label: "T-BILLS", tab: "tbills" },
  { k: "F9", label: "CALENDAR", tab: "calendar" },
  { k: "F10", label: "VOLATILITY", tab: "volatility" },
];

function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="tt-clock">{now.toLocaleTimeString("en-IN", { hour12: false })} IST</span>;
}

export default function TradingApp() {
  const [symbol, setSymbol] = useState(null); // { symbol: "NSE:RELIANCE-EQ", name }
  const [tab, setTab] = useState("analysis");
  // Builder handoff: scanners replace the whole leg set, the option chain appends one leg at a
  // time. A single incrementing token drives the StrategyBuilder effect for both modes.
  const [builderPrefill, setBuilderPrefill] = useState({ legs: null, mode: "replace", token: 0 });

  const allTabs = [...SYMBOL_TABS, ...GLOBAL_TABS];

  // Tabs that don't need a broker session — usable without Fyers login.
  const FYERS_FREE_TABS = new Set(["calendar"]);
  const { status, error, startLogin } = useAuthStatus();
  const loggedIn = status === "loggedIn";

  function sendToBuilder(legs, mode = "replace", broker = undefined) {
    setBuilderPrefill(p => ({ legs, mode, broker, token: p.token + 1 }));
    setTab("strategy");
  }

  return (
    <div className="trading-terminal min-h-screen bg-gray-950 text-gray-100">
      {/* Function-key strip — full width across the very top (matches the design). */}
      <div className="tt-fkeys tt-fkeys-top">
        {FN_KEYS.map(f => (
          <button key={f.k} onClick={() => setTab(f.tab)} className="tt-fkey"
            title={SYMBOL_TABS.some(s => s.id === f.tab) && !symbol ? "Select a symbol first" : undefined}>
            <span className="tt-fkey-k">{f.k}</span> {f.label}
          </button>
        ))}
      </div>

      <div className="px-4 pb-4">
        {/* Header — full width above both columns. */}
        <div className="tt-header">
          <span className="tt-brand">Trading Terminal</span>
          <span className="tt-sub">FYERS · ZERODHA · SHOONYA — LIVE ANALYSIS &amp; ORDER PLACEMENT</span>
          <Clock />
          <MarketStatusBanner />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px] gap-4 items-start">
          <div className="w-full min-w-0">
            {/* Not-connected banner — News/Calendar/Live TV still work; trading tools prompt to log in. */}
            {!loggedIn && status !== "checking" && (
              <div className="flex flex-wrap items-center gap-3 bg-yellow-900/20 border border-yellow-800 rounded-lg px-3 py-2 mb-3">
                <span className="text-xs text-yellow-300">
                  Fyers not connected — News, Calendar and Live TV work without it. Log in to use trading tools.
                </span>
                <button onClick={startLogin}
                  className="ml-auto text-xs bg-blue-600 hover:bg-blue-700 rounded px-3 py-1.5 font-semibold">
                  Login with Fyers
                </button>
              </div>
            )}

            {/* Broker/symbol-dependent header widgets only make sense when connected. */}
            {loggedIn && <>
              <HolidayAlert />
              <BrokerFunds />
              <SymbolSearch onSelect={setSymbol} selected={symbol} />
              <NewsAlert symbol={symbol} />
            </>}

            <div className="tt-nav">
              {allTabs.map(t => {
                const locked = loggedIn && SYMBOL_TABS.some(s => s.id === t.id) && !symbol;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    title={locked ? "Select a symbol first" : undefined}
                    className={`tt-tab ${tab === t.id ? "tt-tab-active" : ""} ${locked ? "tt-tab-locked" : ""}`}
                  >
                    {t.label}
                  </button>
                );
              })}
            </div>

            {/* Fyers-free tabs — always available, no login required. */}
            {tab === "calendar" && <Calendar />}

            {/* Everything else needs a broker session. */}
            {!FYERS_FREE_TABS.has(tab) && (
              status === "checking"
                ? <p className="tt-gate">Checking session…</p>
                : !loggedIn
                  ? <LoginPrompt error={error} onLogin={startLogin} />
                  : <>
                      {SYMBOL_TABS.some(t => t.id === tab) && !symbol && (
                        <p className="tt-gate">▸ SELECT A SYMBOL ABOVE TO ACCESS THIS TOOL.</p>
                      )}
                      {tab === "analysis" && symbol && <AnalysisPanel symbol={symbol} />}
                      {tab === "options" && symbol && <OptionChain symbol={symbol} onAddLegs={legs => sendToBuilder(legs, "append")} />}
                      {tab === "order" && symbol && <OrderPanel symbol={symbol} />}
                      {tab === "roi" && symbol && <RoiScanner symbol={symbol} onUseCombo={legs => sendToBuilder(legs, "replace")} />}
                      {tab === "spread" && symbol && <SpreadScanner symbol={symbol} onUseCombo={legs => sendToBuilder(legs, "replace")} />}
                      {tab === "gtt" && symbol && <GttOrders symbol={symbol} />}
                      {tab === "alerts" && symbol && <Alerts symbol={symbol} />}
                      {tab === "strategy" && <StrategyBuilder prefill={builderPrefill} />}
                      {tab === "positions" && <Positions onSendToBuilder={sendToBuilder} />}
                      {tab === "scalps" && <Scalps />}
                      {tab === "reports" && <Reports />}
                      {tab === "tbills" && <TBills />}
                      {tab === "volatility" && <VolatilityScanner onSelect={sym => { setSymbol(sym); setTab("options"); }} />}
                    </>
            )}
          </div>

          {/* Right sidebar: Live Alerts panel. News, Read Later and Live TV moved to the
              standalone "News Coverage" app on uditmathur.uk (news.html). */}
          <div className="tt-rightcol">
            <EventNotifications />
          </div>
        </div>
      </div>

      <AssistantChat />
    </div>
  );
}
