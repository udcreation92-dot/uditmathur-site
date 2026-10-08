import { useState, useEffect, useCallback } from "react";
import { api } from "../api";

const REFRESH_MS = 60 * 1000;

// Compact "3h ago" / "2d ago" plus an absolute date-time on hover/second line.
function relTime(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  const secs = Math.max(0, (Date.now() - d.getTime()) / 1000);
  const mins = secs / 60, hrs = mins / 60, days = hrs / 24;
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.floor(mins)}m ago`;
  if (hrs < 24) return `${Math.floor(hrs)}h ago`;
  if (days < 7) return `${Math.floor(days)}d ago`;
  return d.toLocaleDateString();
}

function absTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString([], {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

export default function ReadLater() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState("all"); // all | unread | read
  const [busy, setBusy] = useState({});         // id -> true while a row action is in flight

  const load = useCallback(async () => {
    try {
      setErr("");
      const data = await api.readLaterList();
      setItems(Array.isArray(data) ? data : []);
    } catch (e) {
      setErr(e.message || "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const setRead = async (id, read) => {
    setBusy((b) => ({ ...b, [id]: true }));
    setItems((xs) => xs.map((i) => (i.id === id ? { ...i, read } : i))); // optimistic
    try { await api.readLaterSetRead(id, read); } catch { load(); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  const remove = async (id) => {
    setBusy((b) => ({ ...b, [id]: true }));
    setItems((xs) => xs.filter((i) => i.id !== id)); // optimistic
    try { await api.readLaterDelete(id); } catch { load(); }
    finally { setBusy((b) => ({ ...b, [id]: false })); }
  };

  const clearRead = async () => {
    if (!confirm("Remove all items marked read?")) return;
    setItems((xs) => xs.filter((i) => !i.read)); // optimistic
    try { await api.readLaterClearRead(); } catch { load(); }
  };

  const unreadCount = items.filter((i) => !i.read).length;
  const shown = items.filter((i) =>
    filter === "all" ? true : filter === "unread" ? !i.read : i.read);

  return (
    <div className="max-w-3xl mx-auto w-full p-3 sm:p-4">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <h2 className="text-base sm:text-lg font-semibold text-gray-100 mr-auto">
          🔖 Read Later
          <span className="ml-2 text-xs font-normal text-gray-400">
            {items.length} saved · {unreadCount} unread
          </span>
        </h2>
        <button onClick={load}
          className="text-[11px] px-2 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300">
          ↻ Refresh
        </button>
      </div>

      {/* Filter chips */}
      <div className="flex items-center gap-1.5 mb-3">
        {["all", "unread", "read"].map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`text-[11px] px-2.5 py-1 rounded-full border ${
              filter === f
                ? "bg-blue-600 border-blue-600 text-white"
                : "bg-transparent border-gray-700 text-gray-400 hover:text-gray-200"
            }`}>
            {f === "all" ? "All" : f === "unread" ? "Unread" : "Read"}
          </button>
        ))}
        {items.some((i) => i.read) && (
          <button onClick={clearRead}
            className="ml-auto text-[11px] px-2 py-1 rounded text-gray-500 hover:text-red-400">
            🗑 Clear read
          </button>
        )}
      </div>

      {loading && <div className="text-sm text-gray-500 py-8 text-center">Loading…</div>}
      {err && <div className="text-sm text-red-400 py-2">{err}</div>}
      {!loading && !err && shown.length === 0 && (
        <div className="text-sm text-gray-500 py-10 text-center">
          Nothing here yet. Tap <span className="text-gray-300">🔖 Read later</span> on any headline
          in the Telegram news bot to save it.
        </div>
      )}

      {/* List */}
      <ul className="space-y-2">
        {shown.map((i) => (
          <li key={i.id}
            className={`rounded-lg border p-3 transition-colors ${
              i.read ? "border-gray-800 bg-gray-900/40 opacity-70" : "border-gray-700 bg-gray-900"
            }`}>
            <div className="flex items-start gap-3">
              {/* unread dot */}
              <span className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${
                i.read ? "bg-transparent border border-gray-600" : "bg-blue-500"
              }`} />
              <div className="min-w-0 flex-1">
                <a href={i.link || undefined} target="_blank" rel="noopener noreferrer"
                  className={`block text-sm leading-snug ${
                    i.read ? "text-gray-400" : "text-gray-100"
                  } hover:text-blue-400`}>
                  {i.title || "(untitled)"}
                </a>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-gray-500">
                  {i.source && <span className="text-gray-400">{i.source}</span>}
                  {i.source && <span>·</span>}
                  <span title={absTime(i.ts)}>{relTime(i.ts)}</span>
                </div>
              </div>
            </div>
            {/* Actions — big enough to tap on mobile */}
            <div className="mt-2 flex items-center gap-2 pl-5">
              <button disabled={busy[i.id]} onClick={() => setRead(i.id, !i.read)}
                className="text-[11px] px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300 disabled:opacity-50">
                {i.read ? "Mark unread" : "Mark read"}
              </button>
              {i.link && (
                <a href={i.link} target="_blank" rel="noopener noreferrer"
                  className="text-[11px] px-2.5 py-1 rounded bg-gray-800 hover:bg-gray-700 text-gray-300">
                  Open ↗
                </a>
              )}
              <button disabled={busy[i.id]} onClick={() => remove(i.id)}
                className="ml-auto text-[11px] px-2 py-1 rounded text-gray-500 hover:text-red-400 disabled:opacity-50">
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
