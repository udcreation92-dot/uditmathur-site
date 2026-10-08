import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

export default function LivePrice({ symbol }) {
  const [quote, setQuote] = useState(null);

  const load = useCallback(async () => {
    try {
      const result = await api.getQuote(symbol);
      const v = result?.d?.[0]?.v;
      if (v) setQuote(v);
    } catch {
      // silent — don't disrupt the header on a transient failure
    }
  }, [symbol]);

  useEffect(() => {
    setQuote(null);
    load();
    const interval = setInterval(load, 1500);
    return () => clearInterval(interval);
  }, [load]);

  if (!quote) return null;

  const chg = quote.ch ?? 0;
  const chgPct = quote.chp ?? 0;
  const up = chg >= 0;

  return (
    <span className="flex items-center gap-2">
      <span className="text-white font-semibold text-base">₹{quote.lp?.toFixed(2)}</span>
      <span className={`text-xs font-medium ${up ? "text-green-400" : "text-red-400"}`}>
        {up ? "▲" : "▼"} {chg >= 0 ? "+" : ""}{chg?.toFixed(2)} ({chgPct >= 0 ? "+" : ""}{chgPct?.toFixed(2)}%)
      </span>
    </span>
  );
}
