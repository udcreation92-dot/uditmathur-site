import threading
import time
import datetime
from fyers_client import client
from zerodha_client import client as zclient
from shoonya_client import client as sclient
from tbill_scanner import scan_tbills, ask_qty_depth, fresh_quote
import shoonya_symbols
import tbill_watch_db as db
import tbill_purchases
import holding_lots
import events_db
import fyers_ws

POLL_INTERVAL = 5  # seconds — the ranking scan reads the WebSocket snapshot (instant, no broker
# calls), so it's light enough to run ~6x more often. A T-Bill crossing the target ROI is caught
# within ~5s instead of ~30s; the live price is REST-verified before any real buy. On top of this
# poll, an event-driven WebSocket listener wakes the loop the instant a T-Bill ask ticks, so a
# fleeting high-yield ask is caught in ~sub-second rather than up to a full poll interval later.
_FULL_REFRESH_EVERY = 6   # every ~30s (6 × 5s) force a full REST refresh to catch quote-only moves
_cycle_n = 0
_last_tick_wake = 0.0     # throttle event-driven wakes so a tick burst can't spin the loop

# Skip-logging: record WHY a bill that cleared target on the snapshot wasn't bought, so a miss is
# diagnosable instead of silent. Deduped per (watch, symbol, reason) so the 5s loop / tick wakes
# can't spam the same skip — re-logged at most once per window.
_skip_seen: dict = {}
_SKIP_LOG_WINDOW = 300  # seconds


def _log_skip(watch_id, symbol: str, reason: str, detail: str = ""):
    key = (watch_id, symbol, reason)
    now = time.time()
    if now - _skip_seen.get(key, 0) < _SKIP_LOG_WINDOW:
        return
    _skip_seen[key] = now
    db.log_buy(symbol, 0, 0, 0, None, "skipped",
               f"{reason}{': ' + detail if detail else ''}", watch_id=watch_id)


def _place_tbill_order(broker: str, symbol: str, qty: int, price: float):
    """Place a CNC/delivery limit buy for a T-Bill on the chosen broker. `symbol` is Fyers-format
    (e.g. "NSE:91D300726-TB"). Returns (ok, order_id, message). T-Bill tsym is identical across
    all three brokers on NSE."""
    if broker == "zerodha":
        body = symbol.split(":")[-1]
        order_id = zclient.place_order(
            variety="regular", exchange="NSE", tradingsymbol=body,
            transaction_type="BUY", quantity=qty, product="CNC",
            order_type="LIMIT", price=price,
        )
        return True, order_id, None
    if broker == "shoonya":
        contract = shoonya_symbols.fyers_to_shoonya(symbol)
        result = sclient.place_order(
            exchange=contract["exch"], tradingsymbol=contract["tsym"],
            transaction_type="B", quantity=qty, price_type="LMT",
            product="C", price=price,
        )
        ok = result.get("stat") == "Ok"
        return ok, result.get("norenordno"), None if ok else result.get("emsg", str(result))
    # fyers
    result = client.place_order(
        symbol=symbol, qty=qty, side=1, order_type=1,
        product_type="CNC", limit_price=price,
    )
    ok = bool(result and result.get("s") == "ok")
    return ok, (result.get("id") if result else None), None if ok else str(result)

# ---- Reconcile placed orders against the broker order book ----
# An auto-buy logs status='placed' the instant the order is accepted; that only means the broker
# took it, not that it filled. This step re-checks each placed order's real outcome — traded (with
# the actual fill qty/price), cancelled, or rejected — and updates the activity row. Throttled so
# it doesn't add a broker order-book REST call on every 5s poll.
_RECONCILE_EVERY = 6      # ~30s (6 × 5s poll)
_reconcile_cycle_n = 0


def _num0(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _order_outcome(broker: str, order_id: str, rows: list) -> dict:
    """Find `order_id` in a broker's order book and classify it. Returns
    {"state": traded|cancelled|rejected|pending|unknown, "filled_qty": int, "avg_price": float}.
    Parsed defensively — broker field names / status strings differ."""
    for o in rows:
        oid = str(o.get("norenordno") or o.get("order_id") or o.get("id") or "")
        if oid != str(order_id):
            continue
        status = str(o.get("status") or "").upper()
        if broker == "shoonya":
            filled = int(_num0(o.get("fillshares")))
            avg = _num0(o.get("avgprc"))
            if status == "COMPLETE":
                return {"state": "traded", "filled_qty": filled, "avg_price": avg}
            if status in ("CANCELED", "CANCELLED"):
                return {"state": "cancelled", "filled_qty": filled, "avg_price": avg}
            if status == "REJECTED":
                return {"state": "rejected", "filled_qty": filled, "avg_price": avg}
            return {"state": "pending", "filled_qty": filled, "avg_price": avg}
        if broker == "zerodha":
            filled = int(_num0(o.get("filled_quantity")))
            avg = _num0(o.get("average_price"))
            if status == "COMPLETE":
                return {"state": "traded", "filled_qty": filled, "avg_price": avg}
            if status == "CANCELLED":
                return {"state": "cancelled", "filled_qty": filled, "avg_price": avg}
            if status == "REJECTED":
                return {"state": "rejected", "filled_qty": filled, "avg_price": avg}
            return {"state": "pending", "filled_qty": filled, "avg_price": avg}
        # fyers: numeric status — 2 = filled/traded, 1 = cancelled, 5 = rejected; else pending/transit
        filled = int(_num0(o.get("filledQty")))
        avg = _num0(o.get("tradedPrice") or o.get("limitPrice"))
        st = o.get("status")
        if st == 2 or (filled and filled >= int(_num0(o.get("qty")))):
            return {"state": "traded", "filled_qty": filled, "avg_price": avg}
        if st == 1:
            return {"state": "cancelled", "filled_qty": filled, "avg_price": avg}
        if st == 5:
            return {"state": "rejected", "filled_qty": filled, "avg_price": avg}
        return {"state": "pending", "filled_qty": filled, "avg_price": avg}
    return {"state": "unknown", "filled_qty": 0, "avg_price": 0}


def _fetch_order_book(broker: str) -> list:
    try:
        if broker == "zerodha":
            return zclient.get_order_book() or []
        if broker == "shoonya":
            return sclient.get_order_book() or []
        resp = client.get_order_book()
        return (resp.get("orderBook", []) if isinstance(resp, dict) else resp) or []
    except Exception:
        return []


def _reconcile_placed():
    """Update every still-'placed' auto-buy row with its terminal broker outcome. Only today's
    orders are chased (older books are gone). One order-book fetch per broker involved."""
    local_midnight = datetime.datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff = local_midnight.astimezone(datetime.timezone.utc).replace(tzinfo=None).isoformat()
    placed = db.list_unresolved_placed(since_iso=cutoff)
    if not placed:
        return
    books = {b: _fetch_order_book(b) for b in {(p.get("broker") or "fyers") for p in placed}}
    for p in placed:
        broker = p.get("broker") or "fyers"
        out = _order_outcome(broker, p["order_id"], books.get(broker, []))
        if out["state"] in ("pending", "unknown"):
            continue  # not terminal yet (or not in book) — re-check next cycle
        msg = None
        if out["state"] == "traded":
            msg = f"{out['filled_qty'] or p['qty']} @ ₹{out['avg_price'] or p['price']} · order {p['order_id']}"
        elif out["state"] == "cancelled":
            msg = f"order {p['order_id']} cancelled at broker"
        elif out["state"] == "rejected":
            msg = f"order {p['order_id']} rejected by broker"
        db.resolve_log(p["id"], out["state"],
                       filled_qty=out["filled_qty"] or None,
                       avg_price=out["avg_price"] or None,
                       message=msg)


# NOTE: the auto-buy log stores the placing broker on the log row so reconciliation can pick the
# right order book. Older rows (before this column) fall back to 'fyers'.

_stop_event = threading.Event()
_wake_event = threading.Event()
_thread: threading.Thread | None = None


def _run_cycle():
    # Reconcile placed orders first, independent of whether any watch is still active — an order
    # placed earlier can fill/cancel after its watch stopped or ran out of budget. Throttled.
    global _reconcile_cycle_n
    _reconcile_cycle_n += 1
    if _reconcile_cycle_n % _RECONCILE_EVERY == 1:
        try:
            _reconcile_placed()
        except Exception:
            pass

    watches = [w for w in db.list_watches(active_only=True) if w["budget_remaining"] >= 1]
    if not watches:
        return
    # Fyers provides the market data for scanning regardless of which broker executes the buy.
    if not client.is_logged_in():
        _log_skip(None, "-", "fyers-not-logged-in", "no market data — cannot scan or verify")
        return

    global _cycle_n
    _cycle_n += 1
    # T-Bills barely tick, so their WebSocket snapshot stays valid between the rare price changes.
    # Normal cycle: pure-cache ranking (no REST, no depth) — instant, so the 5s loop is nearly free.
    # Every ~30s: a full REST refresh re-baselines the whole board and catches any bill that gained
    # an ask / moved without ticking. Either way, the live price is REST-verified before any buy.
    full_refresh = (_cycle_n % _FULL_REFRESH_EVERY == 0)
    try:
        bills = scan_tbills(with_depth=False,
                            max_stale=(0 if full_refresh else 36000),
                            rest_fallback=full_refresh)
    except Exception as e:
        # A scan that collides with a backend --reload restart raises "cannot schedule new
        # futures after interpreter shutdown" — transient, the next cycle (fresh process) is
        # fine. Don't log a scary error row for it.
        if "interpreter shutdown" not in str(e):
            db.log_buy("-", 0, 0, 0, None, "error", f"scan failed: {e}")
        return

    # One live REST verify per bill per cycle, shared across watches so two watches eyeing the same
    # bill don't double-quote it. None means "unquotable / no ask right now".
    _verify_cache: dict[str, dict | None] = {}

    def verify(symbol):
        if symbol not in _verify_cache:
            _verify_cache[symbol] = fresh_quote(symbol)
        return _verify_cache[symbol]

    # Each watch buys independently against its own target / budget / broker.
    for w in watches:
        _process_watch(w, bills, verify)


def _process_watch(watch: dict, bills: list[dict], verify):
    remaining = watch["budget_remaining"]
    target_roi = watch["target_roi"]
    broker = watch.get("broker") or "fyers"
    wid = watch["id"]

    for b in bills:
        # Bills are sorted best-ROI first, so this is the common, uninteresting case — not logged.
        if b["roi_pct"] < target_roi:
            continue
        # A bill clears target but the budget's spent — worth knowing, logged once per window.
        if remaining < 1:
            _log_skip(wid, "-", "budget-exhausted", f"{b['symbol'].replace('NSE:', '')} cleared {target_roi}% but budget is used up")
            break

        # This bill clears the target on the (possibly cached) snapshot — VERIFY with a live REST
        # quote + depth before risking real money. If the fresh price no longer clears target, skip.
        fresh = verify(b["symbol"])
        if not fresh:
            _log_skip(wid, b["symbol"], "no-live-ask", "cleared target on snapshot but no live ask to buy")
            continue
        ask = fresh["ask"]
        ask_qty = fresh.get("ask_qty")
        days = b["days_to_maturity"]
        roi_pct = round((100 - ask) / ask * (365 / days) * 100, 2) if days > 0 else 0
        if roi_pct < target_roi:
            _log_skip(wid, b["symbol"], "ask-moved-below-target", f"live ask {ask} = {roi_pct}% < {target_roi}%")
            continue

        max_by_budget = int(remaining // (ask * b["lot_size"])) * b["lot_size"]
        if ask_qty is not None:
            max_by_liquidity = (ask_qty // b["lot_size"]) * b["lot_size"]
            qty = min(max_by_budget, max_by_liquidity)
        else:
            qty = max_by_budget
        if qty < b["lot_size"]:
            _log_skip(wid, b["symbol"], "below-one-lot", f"buyable qty {qty} < lot {b['lot_size']} (ask_qty={ask_qty})")
            continue

        cost = qty * ask
        try:
            ok, order_id, err = _place_tbill_order(broker, b["symbol"], qty, ask)
            if ok:
                db.deduct_budget(wid, cost)
                remaining -= cost
                db.log_buy(b["symbol"], qty, ask, cost, order_id, "placed", watch_id=wid, broker=broker)
                bare = b["symbol"].replace("NSE:", "")
                tbill_purchases.record_purchase(bare)
                # Each auto-buy fill is its own tranche — the watch places multiple orders for the
                # same bill as liquidity allows, so lot-level ROI is genuinely useful here.
                holding_lots.add_lot(f"{broker}:{bare}", __import__("datetime").date.today().isoformat(), qty, ask)
                events_db.add_event(
                    "auto_buy",
                    f"T-Bill auto-buy ({broker}): {qty} × {b['symbol'].replace('NSE:', '')}",
                    f"₹{ask} each, cost ₹{cost:,.0f} @ {roi_pct}% ROI · order {order_id}",
                )
            else:
                db.log_buy(b["symbol"], qty, ask, cost, None, "error", err or "order rejected", watch_id=wid)
        except Exception as e:
            db.log_buy(b["symbol"], qty, ask, cost, None, "error", str(e), watch_id=wid)


def _loop():
    while not _stop_event.is_set():
        try:
            _run_cycle()
        except Exception:
            pass
        _wake_event.wait(POLL_INTERVAL)
        _wake_event.clear()


def _on_tick(symbol: str):
    """WebSocket tick hook — wake the loop the instant a T-Bill's price moves, so a fleeting ask
    that clears target is caught in ~sub-second instead of waiting for the next poll. Throttled and
    filtered to T-Bill symbols so equity/option ticks never spin the loop."""
    if "-TB" not in symbol:
        return
    global _last_tick_wake
    now = time.time()
    if now - _last_tick_wake < 0.5:  # coalesce bursts; the cycle itself is cheap but not free
        return
    _last_tick_wake = now
    wake()


def ensure_started():
    global _thread
    if _thread is None or not _thread.is_alive():
        _stop_event.clear()
        _thread = threading.Thread(target=_loop, daemon=True)
        _thread.start()
    # Register the event-driven wake once the socket module is importable (add_tick_listener is
    # idempotent, so calling this on every ensure_started is safe).
    try:
        fyers_ws.add_tick_listener(_on_tick)
    except Exception:
        pass


def wake():
    """Trigger an immediate check instead of waiting for the next poll interval."""
    _wake_event.set()
