"""Holdings target/SL auto-exit engine. Polls the live bid for every ARMED holding (any
Holdings-tab instrument — equity, ETF, bond; bought through this dashboard or already sitting at
the broker) and, when auto-trading is on for that row, sells the FULL current qty the instant
target or SL is touched — a marketable LIMIT at the live bid. Same convention as the cash-segment
Scalps and the Strategies auto-exit. Real money — arming a row is the explicit consent; refuses to
fire on a read-only deployment."""
import os
import threading
import time

import holding_targets_db as db
import events_db
from fyers_client import client
from zerodha_client import client as zclient
from shoonya_client import client as sclient

POLL_INTERVAL = 5  # seconds
_READ_ONLY = os.environ.get("LEDGER_READ_ONLY", "").strip().lower() in ("1", "true", "yes")

_stop = threading.Event()
_wake = threading.Event()
_thread: threading.Thread | None = None


def _quote_bid(fyers_symbol: str | None) -> float | None:
    """The live bid — the price a SELL would actually fill at. Requires a genuinely positive bid
    (a thin book can tick to 0/empty, and 0 is not None — see scalp_watcher's _quote for the same
    guard and why it matters: unguarded, that reads as a stoploss already touched)."""
    if not fyers_symbol:
        return None
    try:
        import fyers_ws
        fyers_ws.subscribe([fyers_symbol])
        q = fyers_ws.fresh_quotes([fyers_symbol]).get(fyers_symbol)
        if q and q.get("bid"):
            return q["bid"]
    except Exception:
        pass
    try:
        resp = client.get_quotes(fyers_symbol)
        if resp and resp.get("s") == "ok":
            v = (resp.get("d") or [{}])[0].get("v", {})
            if v.get("bid"):
                return v["bid"]
    except Exception:
        pass
    return None


def _current_qty(broker: str, symbol: str) -> int:
    """Live qty from the broker's own holdings right now — never a stale snapshot, since a holding
    can shrink/grow between arming and firing. Reuses each broker route's own normalized holdings
    call (deferred import: main.py imports both this module and the routes)."""
    try:
        if broker == "zerodha":
            from routes.zerodha import holdings as _h
        elif broker == "shoonya":
            from routes.shoonya import holdings as _h
        else:
            from routes.orders import holdings as _h
        for h in (_h() or []):
            if h.get("tradingsymbol") == symbol:
                return int(h.get("quantity") or 0)
    except Exception:
        pass
    return 0


def _place_sell(broker: str, symbol: str, qty: int, price: float) -> tuple[bool, str | None, str | None]:
    """Marketable SELL LIMIT for a delivery holding. `symbol` is used exactly as given — the same
    string that broker's own holdings endpoint returned — so no symbol-format conversion, and no
    risk of exiting the wrong instrument."""
    price = round(float(price), 2)
    try:
        if broker == "zerodha":
            oid = zclient.place_order(variety="regular", exchange="NSE", tradingsymbol=symbol,
                                      transaction_type="SELL", quantity=int(qty),
                                      product="CNC", order_type="LIMIT", price=price)
            return True, str(oid), None
        if broker == "shoonya":
            r = sclient.place_order(exchange="NSE", tradingsymbol=symbol, transaction_type="S",
                                    quantity=int(qty), price_type="LMT", product="C", price=price)
            ok = r.get("stat") == "Ok"
            return ok, r.get("norenordno"), None if ok else r.get("emsg", str(r))
        r = client.place_order(symbol=symbol, qty=int(qty), side=-1, order_type=1,
                               product_type="CNC", limit_price=price)
        ok = bool(r and r.get("s") == "ok")
        return ok, (r.get("id") if r else None), None if ok else str(r)
    except Exception as e:
        return False, None, str(e)


def _handle(row: dict):
    bid = _quote_bid(row.get("fyers_symbol"))
    if bid is None:
        return
    target, sl = row.get("target_price"), row.get("sl_price")
    hit_target = target is not None and bid >= target
    hit_sl = sl is not None and bid <= sl
    if not (hit_target or hit_sl):
        return
    reason = "TARGET" if hit_target else "SL"
    qty = _current_qty(row["broker"], row["symbol"])
    if qty <= 0:
        return  # nothing left to sell right now (already exited elsewhere) — stays ARMED, re-checks next cycle
    ok, oid, msg = _place_sell(row["broker"], row["symbol"], qty, bid)
    if ok and oid:
        db.mark_fired(row["broker"], row["symbol"], oid, reason)
        events_db.add_event(
            "holding_target", f"Holding auto-exit FIRED: {row['symbol']} — {reason}",
            body=f"Sold {qty} qty on {row['broker']} at ₹{bid} (limit). {reason} level was "
                 f"{target if hit_target else sl}.",
            dedupe_key=f"holdtgt_fire:{row['id']}")
    else:
        events_db.add_event(
            "holding_target", f"Holding auto-exit FAILED to place: {row['symbol']}",
            body=str(msg), dedupe_key=f"holdtgt_failfire:{row['id']}:{time.time()//60}")


def _cycle():
    if _READ_ONLY:
        return
    for row in db.list_armed():
        try:
            _handle(row)
        except Exception:
            pass


def _loop():
    while not _stop.is_set():
        try:
            _cycle()
        except Exception:
            pass
        _wake.wait(POLL_INTERVAL)
        _wake.clear()


def ensure_started():
    global _thread
    if _thread is None or not _thread.is_alive():
        _stop.clear()
        _thread = threading.Thread(target=_loop, daemon=True)
        _thread.start()


def wake():
    _wake.set()
