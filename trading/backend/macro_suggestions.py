"""AI-detected macro-event suggestions awaiting the user's approval.

When the news-enrichment LLM (see news_intel.enrich_items) reads a headline and decides it
announces a scheduled MACRO event with a concrete future date (RBI MPC, CPI/WPI inflation
print, Fed FOMC, Union Budget, GDP release, US jobs, etc.), it files a *pending suggestion*
here — it is NEVER added straight to the macro calendar. The user approves or rejects each one
in the Calendar tab; approval promotes it into event_calendar's manual macro list.

JSON-backed (same durable-file pattern as event_calendar's .macro_events.json). Dedup is by
(name-lowercased, date) across every status, and against already-existing macro events, so the
same real-world event never re-queues on later poll cycles."""
import json
import threading
from datetime import date
from pathlib import Path

import event_calendar
import state_paths

SUGGESTIONS_FILE = state_paths.state_path(".macro_suggestions.json")
_lock = threading.Lock()

MAX_HORIZON_DAYS = 400  # ignore dates absurdly far out (likely a mis-parse)


def _load() -> list[dict]:
    if not SUGGESTIONS_FILE.exists():
        return []
    try:
        return json.loads(SUGGESTIONS_FILE.read_text())
    except Exception:
        return []


def _save(items: list[dict]):
    try:
        SUGGESTIONS_FILE.write_text(json.dumps(items, indent=2))
    except Exception:
        pass


def _valid_future_date(event_date: str) -> bool:
    try:
        away = (date.fromisoformat(event_date) - date.today()).days
    except (ValueError, TypeError):
        return False
    return 0 <= away <= MAX_HORIZON_DAYS


def _dupe(items: list[dict], name: str, event_date: str) -> bool:
    key = (name.strip().lower(), event_date)
    if any((s["name"].strip().lower(), s["date"]) == key for s in items):
        return True
    # Already on the real macro calendar? Then there's nothing to approve.
    for e in event_calendar.get_macro_events():
        if (e["name"].strip().lower(), e["date"]) == key:
            return True
    return False


def add_suggestion(name: str, event_date: str, category: str = "Macro",
                   source_title: str = "", source_link: str = "") -> bool:
    """Queue a pending suggestion. Returns True if newly added, False if invalid or a duplicate."""
    name = (name or "").strip()
    if not name or not _valid_future_date(event_date):
        return False
    with _lock:
        items = _load()
        if _dupe(items, name, event_date):
            return False
        next_id = (max((s.get("id", 0) for s in items), default=0)) + 1
        items.append({
            "id": next_id,
            "name": name,
            "date": event_date,
            "category": (category or "Macro").strip() or "Macro",
            "source_title": source_title[:300],
            "source_link": source_link,
            "detected_at": date.today().isoformat(),
            "status": "pending",
        })
        _save(items)
    return True


def list_suggestions(status: str = "pending") -> list[dict]:
    items = [s for s in _load() if status is None or s.get("status") == status]
    items.sort(key=lambda s: s["date"])
    return items


def _set_status(suggestion_id: int, status: str) -> dict | None:
    with _lock:
        items = _load()
        found = None
        for s in items:
            if s.get("id") == suggestion_id:
                s["status"] = status
                found = dict(s)
                break
        if found:
            _save(items)
        return found


def approve(suggestion_id: int) -> dict | None:
    """Promote a pending suggestion into the real macro calendar and mark it approved.
    Returns the promoted suggestion, or None if the id wasn't found."""
    s = _set_status(suggestion_id, "approved")
    if s:
        event_calendar.add_macro_event(s["name"], s["date"], s.get("category", "Macro"))
    return s


def reject(suggestion_id: int) -> dict | None:
    return _set_status(suggestion_id, "rejected")
