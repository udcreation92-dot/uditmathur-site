import json
import threading
import time
import requests
from pathlib import Path
from datetime import date, datetime

import symbol_master
import state_paths

# NSE's own corporate event calendar — board meetings for financial results, dividends,
# buybacks, fund-raising. Works with just a browser User-Agent (no session cookie needed).
NSE_URL = "https://www.nseindia.com/api/event-calendar"
REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": "application/json",
    "Referer": "https://www.nseindia.com/companies-listing/corporate-filings-event-calendar",
}
POLL_INTERVAL = 6 * 3600  # 6h — corporate dates barely change intraday

# Macro/scheduled events with no clean feed (RBI policy, CPI/inflation, Fed, budget) are
# maintained manually here, same editable-store pattern as the RSS feed list.
MACRO_FILE = state_paths.state_path(".macro_events.json")

_stop_event = threading.Event()
_wake_event = threading.Event()
_thread: threading.Thread | None = None
_lock = threading.Lock()
_macro_lock = threading.Lock()

_state = {
    "corporate": [],      # [{symbol, company, date (YYYY-MM-DD), purpose, desc, is_fo}]
    "last_checked": None,
    "error": None,
}


def _parse_nse_date(s: str) -> str | None:
    try:
        return datetime.strptime(s.strip(), "%d-%b-%Y").date().isoformat()
    except Exception:
        return None


def _fo_roots() -> set[str]:
    try:
        return {u["root"].upper() for u in symbol_master.list_fo_underlyings()}
    except Exception:
        return set()


def _fetch_corporate() -> list[dict]:
    resp = requests.get(NSE_URL, headers=REQUEST_HEADERS, timeout=15)
    resp.raise_for_status()
    rows = resp.json()
    fo = _fo_roots()
    out = []
    for r in rows:
        d = _parse_nse_date(r.get("date", ""))
        if not d:
            continue
        symbol = (r.get("symbol") or "").upper()
        out.append({
            "symbol": symbol,
            "company": r.get("company", ""),
            "date": d,
            "purpose": r.get("purpose", ""),
            "desc": (r.get("bm_desc") or "")[:300],
            "is_fo": symbol in fo,
        })
    out.sort(key=lambda x: x["date"])
    return out


def _run_cycle():
    try:
        corporate = _fetch_corporate()
        with _lock:
            _state["corporate"] = corporate
            _state["last_checked"] = time.time()
            _state["error"] = None
    except Exception as e:
        with _lock:
            _state["last_checked"] = time.time()
            _state["error"] = str(e)


def _loop():
    while not _stop_event.is_set():
        _run_cycle()
        _wake_event.wait(POLL_INTERVAL)
        _wake_event.clear()


def ensure_started():
    global _thread
    if _thread is None or not _thread.is_alive():
        _stop_event.clear()
        _thread = threading.Thread(target=_loop, daemon=True)
        _thread.start()


def check_now():
    _run_cycle()
    return get_status()


def get_status() -> dict:
    with _lock:
        return {
            "last_checked": _state["last_checked"],
            "corporate_count": len(_state["corporate"]),
            "macro_count": len(get_macro_events()),
            "error": _state["error"],
        }


# ---- Manual macro events ----
def get_macro_events() -> list[dict]:
    with _macro_lock:
        if not MACRO_FILE.exists():
            return []
        try:
            return json.loads(MACRO_FILE.read_text())
        except Exception:
            return []


def add_macro_event(name: str, event_date: str, category: str = "Macro"):
    date.fromisoformat(event_date)  # validate; raises ValueError on bad input
    events = get_macro_events()
    events.append({"name": name, "date": event_date, "category": category})
    events.sort(key=lambda e: e["date"])
    with _macro_lock:
        MACRO_FILE.write_text(json.dumps(events, indent=2))


def delete_macro_event(name: str, event_date: str):
    events = [e for e in get_macro_events() if not (e["name"] == name and e["date"] == event_date)]
    with _macro_lock:
        MACRO_FILE.write_text(json.dumps(events, indent=2))


def get_upcoming(days: int = 14, fo_only: bool = True) -> dict:
    """Corporate events (optionally F&O-only) plus manual macro events, within the next
    `days`, grouped so the UI can render sections."""
    today = date.today()
    with _lock:
        corporate = list(_state["corporate"])

    def within(d: str) -> int | None:
        try:
            away = (date.fromisoformat(d) - today).days
        except ValueError:
            return None
        return away if 0 <= away <= days else None

    earnings, actions = [], []
    for e in corporate:
        away = within(e["date"])
        if away is None:
            continue
        if fo_only and not e["is_fo"]:
            continue
        item = {**e, "days_away": away}
        if "Financial Results" in e["purpose"]:
            earnings.append(item)
        else:
            actions.append(item)

    macro = []
    for e in get_macro_events():
        away = within(e["date"])
        if away is not None:
            macro.append({**e, "days_away": away})

    return {"earnings": earnings, "corporate_actions": actions, "macro": macro}


def earnings_within(symbol_root: str, days: int = 3) -> dict | None:
    """Next Financial-Results event for a given underlying within `days`, or None — used to
    warn about positions on stocks reporting soon."""
    today = date.today()
    root = symbol_root.upper()
    with _lock:
        corporate = list(_state["corporate"])
    for e in corporate:
        if e["symbol"] != root or "Financial Results" not in e["purpose"]:
            continue
        try:
            away = (date.fromisoformat(e["date"]) - today).days
        except ValueError:
            continue
        if 0 <= away <= days:
            return {**e, "days_away": away}
    return None
