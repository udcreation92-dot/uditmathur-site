import { useTradingEvents, EVENT_TYPE_LABELS } from "../useTradingEvents";

// Docked "LIVE ALERTS" panel. Polling/notification logic lives in useTradingEvents so the
// fullscreen video wall can surface the same alerts as an overlay.
export default function EventNotifications() {
  const { events, dismiss } = useTradingEvents();

  if (events.length === 0) return null;

  return (
    <div className="tt-alerts">
      <div className="tt-alerts-head">
        <span className="tt-alerts-title">Live Alerts ({events.length})</span>
        {events.length > 1 && (
          <button onClick={() => dismiss(events.map(t => t.id))} className="tt-alerts-dismiss">
            Dismiss all
          </button>
        )}
      </div>
      {events.slice(0, 8).map(e => (
        <div key={e.id} className="tt-alert-row">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-blue-300">{EVENT_TYPE_LABELS[e.type] || e.type}</p>
            <p className="text-xs text-gray-200 mt-0.5">{e.title}</p>
            {e.body && <p className="text-[10px] text-gray-400 mt-0.5">{e.body}</p>}
            <p className="text-[10px] text-gray-600 mt-0.5">{new Date(e.ts + "Z").toLocaleString()}</p>
          </div>
          <button onClick={() => dismiss([e.id])} className="tt-alert-x" title="Dismiss">×</button>
        </div>
      ))}
    </div>
  );
}
