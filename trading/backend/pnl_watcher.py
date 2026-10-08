import threading
from datetime import date

import strategy_db as db
import events_db
import rss_watcher
import event_calendar
import corporate_actions
from fyers_client import client

POLL_INTERVAL = 15 * 60  # 15 min — enough resolution for an equity curve without hammering APIs

_stop_event = threading.Event()
_wake_event = threading.Event()
_thread: threading.Thread | None = None


def _snapshot_open_strategies():
    # Imported here (not at module top) to avoid a circular import: routes.strategy is the
    # shared computation home and main.py imports both this module and the routes.
    from routes.strategy import compute_strategies
    if not client.is_logged_in():
        return  # no quotes without a Fyers session; a flat-zero snapshot would pollute the curve
    for s in compute_strategies():
        if s["status"] != "OPEN":
            continue
        db.add_pnl_snapshot(s["id"], s["total_pl"], s.get("margin"), s.get("roi_pct"))
        _check_expiry_event(s)
        _check_news_events(s)
        _check_earnings_event(s)
        _check_corporate_action_event(s)


def _check_expiry_event(strategy: dict):
    expiry = strategy.get("expiry")
    if not expiry:
        return
    days_away = (date.fromisoformat(expiry) - date.today()).days
    if 0 <= days_away <= 1:
        when = "TODAY" if days_away == 0 else "tomorrow"
        events_db.add_event(
            "expiry_soon",
            f"Strategy '{strategy['name']}' expires {when}",
            f"Expiry {expiry} · margin ₹{strategy.get('margin') or 0:,.0f} · live P&L ₹{strategy['total_pl']:,.0f}",
            dedupe_key=f"expiry:{strategy['id']}:{expiry}:{days_away}",
        )


def _check_earnings_event(strategy: dict):
    """Warns when an underlying you're holding options on reports earnings within 3 days —
    a known IV-crush/gap risk that a short-premium position especially needs to see coming."""
    seen_roots = set()
    for leg in strategy["legs"]:
        root = rss_watcher.extract_root(leg["symbol"])
        if root in seen_roots:
            continue
        seen_roots.add(root)
        ev = event_calendar.earnings_within(root, days=3)
        if ev:
            events_db.add_event(
                "earnings_soon",
                f"{root} reports earnings in {ev['days_away']}d (in '{strategy['name']}')",
                f"{ev['company']} · {ev['date']} · {ev['purpose']}",
                dedupe_key=f"earnings:{strategy['id']}:{root}:{ev['date']}",
            )


def _check_corporate_action_event(strategy: dict):
    """Warns when an underlying you're holding goes ex-dividend / ex-split / ex-bonus within a few
    days — the price gaps down on the ex-date, so a heads-up stops it looking like a loss."""
    seen_roots = set()
    for leg in strategy["legs"]:
        root = rss_watcher.extract_root(leg["symbol"])
        if root in seen_roots:
            continue
        seen_roots.add(root)
        ev = corporate_actions.action_for_symbol(root, days=3)
        if ev:
            when = "TODAY" if ev["days_away"] == 0 else f"in {ev['days_away']}d"
            amt = f" (~₹{ev['amount']}/sh)" if ev.get("amount") else ""
            events_db.add_event(
                "corporate_action",
                f"{root} goes ex-{ev['type'].lower()} {when} (in '{strategy['name']}')",
                f"{ev['subject']}{amt} · ex-date {ev['ex_date']}",
                dedupe_key=f"ca:{strategy['id']}:{root}:{ev['ex_date']}",
            )


def _check_news_events(strategy: dict):
    seen_roots = set()
    for leg in strategy["legs"]:
        root = rss_watcher.extract_root(leg["symbol"])
        if root in seen_roots:
            continue
        seen_roots.add(root)
        for match in rss_watcher.find_relevant(leg["symbol"]):
            events_db.add_event(
                "news_match",
                f"News mentions {root} (in '{strategy['name']}')",
                match["title"],
                dedupe_key=f"news:{strategy['id']}:{match['link']}",
            )


def _loop():
    while not _stop_event.is_set():
        try:
            _snapshot_open_strategies()
        except Exception:
            pass
        _wake_event.wait(POLL_INTERVAL)
        _wake_event.clear()


def ensure_started():
    global _thread
    if _thread is None or not _thread.is_alive():
        _stop_event.clear()
        _thread = threading.Thread(target=_loop, daemon=True)
        _thread.start()
