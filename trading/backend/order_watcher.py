"""
Background order-lifecycle watcher.

The strategy system already tracks each order (PENDING → FILLED / CANCELLED) and reconciles it
against the broker order book via strategy._resolve_pending_orders(). BUT that only ran when the
dashboard polled /strategy/list — so an order placed with no dashboard open (e.g. an AI-placed
trade from the phone) could sit PENDING with nobody watching.

This watcher closes that hole: during market hours it continuously reconciles PENDING orders to
their terminal state, and Telegrams the user on every transition (filled / cancelled-rejected), so
the system — and you — always know an order's true state. Read-only bookkeeping; it never places or
cancels anything itself. Started from main.py like the other watchers.
"""
import threading
from datetime import datetime, timezone, timedelta

_IST = timezone(timedelta(hours=5, minutes=30))
_POLL = 20                    # seconds between reconciliation sweeps
_MKT_OPEN, _MKT_CLOSE = "09:10", "15:45"   # a touch past 15:30 to catch late fills

_stop = threading.Event()
_thread: threading.Thread | None = None


def _in_market_hours(now) -> bool:
    if now.weekday() >= 5:
        return False
    return _MKT_OPEN <= now.strftime("%H:%M") <= _MKT_CLOSE


def _run_cycle():
    import strategy_db as db
    from routes import strategy          # lazy — already imported at startup; avoids import cycles
    import telegram_news

    pending = [p for p in db.list_orders(statuses=("PENDING",)) if p.get("order_id")]
    if not pending:
        return
    before = {p["id"]: p for p in pending}

    try:
        strategy._resolve_pending_orders()   # reuse the existing broker-orderbook reconciliation
    except Exception:
        return

    for rid, p in before.items():
        cur = db.get_order(rid)
        if not cur or cur.get("status") == "PENDING":
            continue  # still pending — keep tracking next sweep
        sym = (p.get("symbol") or "").replace("NSE:", "")
        if cur["status"] == "FILLED":
            qty = cur.get("qty", p["qty"]); px = cur.get("price", p["price"])
            msg = f"✅ <b>Order filled</b> ({p['broker']}) {p['side']} {qty} × {sym} @ ₹{px}"
        else:  # CANCELLED covers broker cancel + reject
            msg = (f"❌ <b>Order not filled</b> ({p['broker']}) {p['side']} {p['qty']} × {sym} "
                   f"— cancelled/rejected")
        try:
            telegram_news.send_alert(msg)
        except Exception:
            pass


def _loop():
    while not _stop.is_set():
        try:
            if _in_market_hours(datetime.now(_IST)):
                _run_cycle()
        except Exception:
            pass
        _stop.wait(_POLL)


def ensure_started():
    global _thread
    if _thread is None or not _thread.is_alive():
        _stop.clear()
        _thread = threading.Thread(target=_loop, daemon=True)
        _thread.start()
