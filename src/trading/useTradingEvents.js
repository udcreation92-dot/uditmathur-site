import { useState, useEffect, useRef, useCallback } from "react";
import { api } from "./api";

const POLL_MS = 30 * 1000;

// Shared trading-event feed: polls the backend for unseen events and fires a browser
// notification once per new event. Used by both the docked Live Alerts panel and the
// fullscreen video-wall overlay, so polling/dedupe lives in one place.
export function useTradingEvents() {
  const [events, setEvents] = useState([]);
  const notifiedIds = useRef(new Set());

  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }

    async function poll() {
      try {
        const data = await api.getUnseenEvents();
        if (!Array.isArray(data)) return;
        const fresh = data.filter(e => !notifiedIds.current.has(e.id));
        for (const e of fresh) {
          notifiedIds.current.add(e.id);
          if ("Notification" in window && Notification.permission === "granted") {
            try {
              new Notification(e.title, { body: e.body || "", tag: `trading-event-${e.id}` });
            } catch { /* some browsers restrict constructor — panel/overlay still shows */ }
          }
        }
        setEvents(data);
      } catch { /* backend down — retry next poll */ }
    }

    poll();
    const interval = setInterval(poll, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  const dismiss = useCallback(async (ids) => {
    try {
      await api.markEventsSeen(ids);
      setEvents(t => t.filter(e => !ids.includes(e.id)));
    } catch { /* ignore */ }
  }, []);

  return { events, dismiss };
}

export const EVENT_TYPE_LABELS = {
  auto_buy: "🛒 Auto-Buy",
  news_match: "📰 News",
  expiry_soon: "⏳ Expiry",
  earnings_soon: "📊 Earnings",
  macro_suggestion: "📅 Macro event?",
  corporate_action: "💰 Ex-date",
  auto_exit: "⚡ Auto-exit",
};
