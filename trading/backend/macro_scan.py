"""Cursor + headline reader for the local Claude macro-event routine.

Macro/geopolitical event detection was moved OFF the always-on DeepSeek pipeline. Instead a local
scheduled Claude Code run periodically calls GET /calendar/macro-scan (headlines since the cursor),
detects scheduled events, and POSTs them to /calendar/macro-ingest — which writes via the existing
macro_suggestions.add_suggestion path (unchanged Calendar UI) and advances the cursor.

The cursor lives here, on the backend, so the routine stays stateless and can't miss or double-scan.
It advances ONLY on a successful ingest, so a skipped/failed run just catches up next time."""
import json
import threading
from datetime import datetime, timezone, timedelta
from pathlib import Path

import rss_watcher
import state_paths

_CURSOR_FILE = state_paths.state_path(".macro_scan_cursor.json")
_lock = threading.Lock()

# On the very first run (no cursor yet) look back this far, so we seed from recent headlines
# without dragging in the whole 24h backlog.
_FIRST_RUN_LOOKBACK = timedelta(hours=6)


def get_cursor() -> str:
    with _lock:
        try:
            return json.loads(_CURSOR_FILE.read_text())["cursor"]
        except Exception:
            return (datetime.now(timezone.utc) - _FIRST_RUN_LOOKBACK).isoformat()


def set_cursor(cursor_iso: str):
    with _lock:
        try:
            _CURSOR_FILE.write_text(json.dumps({"cursor": cursor_iso}))
        except Exception:
            pass


def _as_dt(iso: str):
    try:
        dt = datetime.fromisoformat(iso)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def headlines_since_cursor(limit: int = 120) -> dict:
    """Relevant headlines published after the cursor, newest first. Returns the list plus a
    `scanned_through` timestamp (the newest pubdate seen, else now) for the routine to echo back
    on ingest so the cursor advances exactly to what it processed."""
    cursor = get_cursor()
    cutoff = _as_dt(cursor)
    # Pull a generous window from the feed; get_feed is already newest-first and 24h-bounded.
    feed = rss_watcher.get_feed(limit=500, max_age_hours=24)

    out, newest = [], cutoff
    for it in feed:
        dt = _as_dt(it.get("pubdate", ""))
        if not dt or (cutoff and dt <= cutoff):
            continue
        out.append({
            "title": it.get("title"),
            "link": it.get("link"),
            "summary": it.get("summary", ""),
            "pubdate": it.get("pubdate"),
            "sources": it.get("sources", []),
        })
        if newest is None or (dt and dt > newest):
            newest = dt
        if len(out) >= limit:
            break

    scanned_through = (newest or datetime.now(timezone.utc)).isoformat()
    return {"cursor": cursor, "scanned_through": scanned_through, "count": len(out), "headlines": out}
