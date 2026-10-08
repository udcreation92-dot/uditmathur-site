"""NSE corporate-actions feed — the ACTUAL declared dividends, splits, bonuses, buybacks and
rights with their EX-DATES (the date the price adjusts), as opposed to event_calendar's
board-meeting dates. Same editable/cached-poll pattern as event_calendar.

NSE's /api endpoints need a cookie first obtained from a homepage GET, so we use a warmed-up
requests.Session. Unofficial API — best-effort, fails soft (empty list on error) exactly like
the event calendar."""
import re
import threading
import time
import requests
from datetime import date, datetime

import symbol_master

BASE = "https://www.nseindia.com"
CA_URL = BASE + "/api/corporates-corporateActions?index=equities"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
    "Accept": "application/json",
    "Referer": "https://www.nseindia.com/companies-listing/corporate-filings-actions",
}
POLL_INTERVAL = 6 * 3600  # ex-dates barely change intraday

_stop_event = threading.Event()
_wake_event = threading.Event()
_thread: threading.Thread | None = None
_lock = threading.Lock()

_state = {
    "actions": [],        # [{symbol, company, ex_date, record_date, subject, type, amount, series, is_fo}]
    "last_checked": None,
    "error": None,
}


def _parse_date(s: str) -> str | None:
    try:
        return datetime.strptime((s or "").strip(), "%d-%b-%Y").date().isoformat()
    except Exception:
        return None


def _classify(subject: str) -> tuple[str, float | None]:
    """Map an NSE 'subject' string to a coarse action type and, for cash dividends, the per-share
    amount (the ~size of the ex-date price drop)."""
    s = (subject or "").lower()
    if "dividend" in s:
        m = re.search(r"(?:rs\.?|re\.?|inr|₹)\s*([0-9]+(?:\.[0-9]+)?)", s)
        return "Dividend", (float(m.group(1)) if m else None)
    if "split" in s or "sub-division" in s or "sub division" in s:
        return "Split", None
    if "bonus" in s:
        return "Bonus", None
    if "buy back" in s or "buyback" in s or "buy-back" in s:
        return "Buyback", None
    if "rights" in s:
        return "Rights", None
    return "Other", None


def _fo_roots() -> set[str]:
    try:
        return {u["root"].upper() for u in symbol_master.list_fo_underlyings()}
    except Exception:
        return set()


def _fetch() -> list[dict]:
    sess = requests.Session()
    sess.headers.update(HEADERS)
    sess.get(BASE, timeout=15)  # warm-up: obtain the cookie NSE requires for /api calls
    resp = sess.get(CA_URL, timeout=15)
    resp.raise_for_status()
    rows = resp.json()
    fo = _fo_roots()
    out = []
    for r in rows:
        # Skip government securities / T-Bill interest rows (series GS/TB) — not equity actions.
        series = (r.get("series") or "").upper()
        if series and series not in ("EQ", "BE", "BZ"):
            continue
        ex = _parse_date(r.get("exDate", ""))
        if not ex:
            continue
        symbol = (r.get("symbol") or "").upper()
        action_type, amount = _classify(r.get("subject", ""))
        out.append({
            "symbol": symbol,
            "company": r.get("comp", ""),
            "ex_date": ex,
            "record_date": _parse_date(r.get("recDate", "")),
            "subject": (r.get("subject") or "").strip()[:200],
            "type": action_type,
            "amount": amount,
            "series": series,
            "face_value": r.get("faceVal", ""),
            "is_fo": symbol in fo,
        })
    out.sort(key=lambda x: x["ex_date"])
    return out


def _run_cycle():
    try:
        actions = _fetch()
        with _lock:
            _state["actions"] = actions
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
            "count": len(_state["actions"]),
            "error": _state["error"],
        }


def get_upcoming(days: int = 30, fo_only: bool = False) -> list[dict]:
    """Corporate actions whose EX-DATE falls within the next `days`."""
    today = date.today()
    with _lock:
        actions = list(_state["actions"])
    out = []
    for a in actions:
        try:
            away = (date.fromisoformat(a["ex_date"]) - today).days
        except ValueError:
            continue
        if not (0 <= away <= days):
            continue
        if fo_only and not a["is_fo"]:
            continue
        out.append({**a, "days_away": away})
    return out


def action_for_symbol(symbol_root: str, days: int = 5) -> dict | None:
    """Next corporate action for an underlying within `days` of its ex-date — used to warn about
    open positions before the price adjusts (e.g. a dividend ex-date gap)."""
    today = date.today()
    root = symbol_root.upper()
    with _lock:
        actions = list(_state["actions"])
    for a in actions:
        if a["symbol"] != root:
            continue
        try:
            away = (date.fromisoformat(a["ex_date"]) - today).days
        except ValueError:
            continue
        if 0 <= away <= days:
            return {**a, "days_away": away}
    return None
