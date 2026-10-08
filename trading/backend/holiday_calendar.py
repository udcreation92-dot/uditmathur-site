import threading
import time
import requests
import xml.etree.ElementTree as ET
from datetime import date, datetime
from email.utils import parsedate_to_datetime

FEED_URL = "https://zerodha.com/marketintel/holiday-calendar/?format=xml"
POLL_INTERVAL = 30 * 24 * 3600  # once a month — the calendar for a year barely changes
REQUEST_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; TradingDashboardBot/1.0)"}

_stop_event = threading.Event()
_wake_event = threading.Event()
_thread: threading.Thread | None = None
_lock = threading.Lock()

_state = {
    "holidays": [],       # [{name, date (YYYY-MM-DD)}], sorted ascending
    "last_checked": None,
    "error": None,
}


def _fetch_holidays() -> list[dict]:
    resp = requests.get(FEED_URL, timeout=15, headers=REQUEST_HEADERS)
    resp.raise_for_status()
    root = ET.fromstring(resp.content)
    holidays = []
    for item in root.findall(".//item"):
        name = (item.findtext("title") or "").strip()
        pub_raw = (item.findtext("pubDate") or "").strip()
        # The feed's pubDate IS the holiday's date, not an article publish time.
        try:
            holiday_date = parsedate_to_datetime(pub_raw).date().isoformat()
        except Exception:
            continue
        if name:
            holidays.append({"name": name, "date": holiday_date})
    holidays.sort(key=lambda h: h["date"])
    return holidays


def _run_cycle():
    try:
        holidays = _fetch_holidays()
        with _lock:
            _state["holidays"] = holidays
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
            "holiday_count": len(_state["holidays"]),
            "error": _state["error"],
        }


def get_all() -> list[dict]:
    with _lock:
        return list(_state["holidays"])


def get_upcoming(days: int = 10) -> list[dict]:
    today = date.today()
    with _lock:
        holidays = list(_state["holidays"])
    out = []
    for h in holidays:
        h_date = date.fromisoformat(h["date"])
        days_away = (h_date - today).days
        if 0 <= days_away <= days:
            out.append({**h, "days_away": days_away})
    return out
