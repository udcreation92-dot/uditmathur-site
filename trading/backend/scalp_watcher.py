"""Scalp auto-trade engine. Polls bid/ask (WebSocket cache first, REST fallback) for every armed or
open scalp and, when auto-trading is ON:
  - WAITING: fires the ENTRY when the tradable side of the book reaches the entry price — a BUY when
    ask <= entry, a SELL when bid >= entry — as a LIMIT order at the entry price.
  - OPEN:    fires the EXIT when target or stop is reached (again on bid/ask, never LTP) as a LIMIT.
  - MIS end-of-day: the broker force-squares off any open MIS position at 3:20pm. From 3:15pm we get
    ahead of that on our own terms — an MIS scalp sitting in profit (but short of target) is banked
    immediately rather than risking the broker's square-off giving it back; one still in loss is left
    to keep working target/SL until 3:19pm, then force-closed regardless of P&L.
Entry/exit fills are confirmed against the broker order book before the state advances, so a scalp is
only 'OPEN' once truly filled. Everything is tracked by its orders. Real money — the global toggle is
the consent; refuses to fire on a read-only deployment.
"""
import datetime
import os
import threading
import time

import scalp_db as db
import events_db
import holding_lots
from fyers_client import client
from zerodha_client import client as zclient
from shoonya_client import client as sclient

POLL_INTERVAL = 3  # seconds — scalps want a tight loop; the ranking read is a cheap cache lookup
_READ_ONLY = os.environ.get("LEDGER_READ_ONLY", "").strip().lower() in ("1", "true", "yes")
_MIS_PROFIT_SQUAREOFF = datetime.time(15, 15)  # from here, exit an in-profit MIS scalp on sight
_MIS_FORCE_SQUAREOFF = datetime.time(15, 19)   # broker auto-squares at 15:20 — get out first, any P&L

_stop = threading.Event()
_wake = threading.Event()
_thread: threading.Thread | None = None


def _quote(symbol: str) -> dict | None:
    """{bid, ask, ltp} — stream cache when fresh, else a REST quote. None if unavailable.
    Requires both sides to be genuinely positive: a thin book can tick bid/ask to 0 (empty side),
    and 0 is not None — left unguarded, that reads as "price already crossed" for a BUY entry
    (0 <= any entry price) or a SELL stoploss, firing/exiting on a bogus price."""
    try:
        import fyers_ws
        fyers_ws.subscribe([symbol])
        q = fyers_ws.fresh_quotes([symbol]).get(symbol)
        if q and q.get("bid") and q.get("ask"):
            return {"bid": q["bid"], "ask": q["ask"], "ltp": q.get("ltp")}
    except Exception:
        pass
    try:
        resp = client.get_quotes(symbol)
        if resp and resp.get("s") == "ok":
            v = (resp.get("d") or [{}])[0].get("v", {})
            if v.get("bid") and v.get("ask"):
                return {"bid": v.get("bid"), "ask": v.get("ask"), "ltp": v.get("lp")}
    except Exception:
        pass
    return None


def _product(trade_type: str, broker: str) -> str:
    mis = trade_type == "MIS"
    if broker == "zerodha":
        return "MIS" if mis else "CNC"
    if broker == "shoonya":
        return "I" if mis else "C"
    return "INTRADAY" if mis else "CNC"   # fyers


def place_order(broker: str, symbol: str, side: str, qty: int, price: float, trade_type: str):
    """LIMIT equity order on the chosen broker. Returns (ok, order_id, message)."""
    body = symbol.split(":")[-1]            # RELIANCE-EQ
    price = round(float(price), 2)
    try:
        if broker == "zerodha":
            tsym = body[:-3] if body.endswith("-EQ") else body   # RELIANCE
            oid = zclient.place_order(variety="regular", exchange="NSE", tradingsymbol=tsym,
                                      transaction_type=side, quantity=int(qty),
                                      product=_product(trade_type, broker), order_type="LIMIT", price=price)
            return True, str(oid), None
        if broker == "shoonya":
            r = sclient.place_order(exchange="NSE", tradingsymbol=body,
                                    transaction_type="B" if side == "BUY" else "S", quantity=int(qty),
                                    price_type="LMT", product=_product(trade_type, broker), price=price)
            ok = r.get("stat") == "Ok"
            return ok, r.get("norenordno"), None if ok else r.get("emsg", str(r))
        r = client.place_order(symbol=symbol, qty=int(qty), side=1 if side == "BUY" else -1,
                               order_type=1, product_type=_product(trade_type, broker), limit_price=price)
        ok = bool(r and r.get("s") == "ok")
        return ok, (r.get("id") if r else None), None if ok else str(r)
    except Exception as e:
        return False, None, str(e)


def _fill(broker: str, order_id: str) -> dict:
    """{'state','filled_qty','avg_price'} for one order — reuses the strategy fill parser."""
    from routes.strategy import _order_fill_status, _fetch_order_books
    return _order_fill_status(broker, order_id, _fetch_order_books({broker}))


def _exit_side(scalp) -> str:
    return "SELL" if scalp["side"] == "BUY" else "BUY"   # close the position


def place_exit(scalp, price: float, reason: str) -> tuple[bool, str | None, str | None]:
    """Place the closing LIMIT order for a scalp and move it to EXITING. Shared by the watcher
    (target/SL) and the manual-exit route."""
    ok, oid, msg = place_order(scalp["broker"], scalp["symbol"], _exit_side(scalp),
                               scalp["qty"], price, scalp["trade_type"])
    if ok and oid:
        db.update(scalp["id"], status="EXITING", exit_order_id=str(oid), exit_reason=reason)
    return ok, oid, msg


def _alert(title, body, key):
    events_db.add_event("scalp", title, body=body, dedupe_key=key)


def _cycle():
    if _READ_ONLY:
        return
    auto = db.auto_enabled()
    scalps = db.list_scalps(("WAITING", "ENTERING", "OPEN", "EXITING"))
    for s in scalps:
        try:
            _handle(s, auto)
        except Exception:
            pass


def _handle(s, auto: bool):
    st = s["status"]

    # ENTERING / EXITING: advance only on a confirmed fill (independent of the auto toggle — an order
    # already resting at the broker must be reconciled).
    if st == "ENTERING" and s.get("entry_order_id"):
        f = _fill(s["broker"], s["entry_order_id"])
        if f["state"] == "filled":
            px = f["avg_price"] or s["entry_price"]
            db.update(s["id"], status="OPEN", entry_fill_price=px, entered_at=_now())
            if s["side"] == "BUY":
                # A BUY entry is now sitting as a broker holding — record its buy date/price the
                # same way any other dashboard-bought equity is, so the Holdings tab's ROI calc
                # picks it up with no manual "Add lot" step. (A SELL entry is a short, never a
                # holding, so nothing to record.)
                try:
                    holding_lots.add_lot(f"{s['broker']}:{s['symbol'].replace('NSE:', '')}",
                                         datetime.date.today().isoformat(), s["qty"], px)
                except Exception:
                    pass
            _alert(f"Scalp ENTERED: {_lbl(s)} {s['qty']}@{px}",
                   f"{s['trade_type']} on {s['broker']} — now tracking target {s['target_price']} / SL {s['sl_price']}.",
                   f"scalp_in:{s['id']}")
        elif f["state"] == "rejected":
            db.update(s["id"], status="WAITING", entry_order_id=None)
            _alert(f"Scalp entry REJECTED: {_lbl(s)}", "Re-armed as WAITING.", f"scalp_inrej:{s['id']}:{time.time()//60}")
        return
    if st == "EXITING" and s.get("exit_order_id"):
        f = _fill(s["broker"], s["exit_order_id"])
        if f["state"] == "filled":
            px = f["avg_price"] or 0
            pnl = ((px - s["entry_fill_price"]) if s["side"] == "BUY" else (s["entry_fill_price"] - px)) * s["qty"]
            db.update(s["id"], status="CLOSED", exit_fill_price=px, realized_pnl=round(pnl, 2), closed_at=_now())
            _alert(f"Scalp CLOSED ({s.get('exit_reason')}): {_lbl(s)} @ {px}",
                   f"Realized P&L ₹{pnl:,.0f}.", f"scalp_out:{s['id']}")
        elif f["state"] == "rejected":
            db.update(s["id"], status="OPEN", exit_order_id=None, exit_reason=None)
        return

    if not auto or s.get("paused"):
        return  # WAITING/OPEN auto-act only when the global toggle is ON and this scalp isn't paused

    q = _quote(s["symbol"])
    if not q:
        return
    bid, ask = q.get("bid"), q.get("ask")

    if st == "WAITING" and bid is not None and ask is not None:
        # Two-tier entry-arming guard — stops a gap from firing the entry instantly at open / auto-on:
        #   1. SNAPSHOT (first live tick each session, or when auto-trade is switched on): if price is
        #      on the WAITING side of the entry (above entry for a BUY, below for a SELL) the scalp
        #      ARMS normally; if it's on the wrong side (gapped through the entry) it goes INACTIVE.
        #   2. An INACTIVE scalp then re-arms ONLY once price reaches its TARGET — drifting back
        #      across the entry alone is not enough. Once ARMED, the entry fires on the usual trigger.
        # arm_state is valid only for armed_date's day; a new session (or auto re-toggle, which clears
        # it) forces a fresh snapshot instead of carrying a stale decision into a gap. Any arming
        # transition waits until the NEXT cycle before it can fire, so we never arm-and-fire in one tick.
        today = datetime.date.today().isoformat()
        ltp = q.get("ltp")
        ref = ltp if ltp is not None else (ask if s["side"] == "BUY" else bid)
        state = s.get("arm_state") if s.get("armed_date") == today else None

        if state is None:  # PENDING — take the open / auto-on snapshot now, off the entry price
            on_waiting_side = (ref > s["entry_price"]) if s["side"] == "BUY" else (ref < s["entry_price"])
            if on_waiting_side:
                db.update(s["id"], arm_state="ARMED", armed_date=today)
                _alert(f"Scalp ARMED: {_lbl(s)} {s['side']} — waiting for entry {s['entry_price']}",
                       "Opened on the waiting side of the entry; now watching for the entry trigger.",
                       f"scalp_arm:{s['id']}:{today}")
            else:
                db.update(s["id"], arm_state="INACTIVE", armed_date=today)
                _alert(f"Scalp INACTIVE: {_lbl(s)} {s['side']} — opened past its entry",
                       f"Price is on the wrong side of the entry ({s['entry_price']}); it stays inactive until "
                       f"it reaches the target ({s['target_price']}), protecting against a gap fill.",
                       f"scalp_inactive:{s['id']}:{today}")
            return  # armed/inactivated this cycle — never fire on the same tick we snapshot

        if state == "INACTIVE":  # re-arm ONLY by reaching the target
            reached_target = (ref >= s["target_price"]) if s["side"] == "BUY" else (ref <= s["target_price"])
            if reached_target:
                db.update(s["id"], arm_state="ARMED")
                _alert(f"Scalp ARMED: {_lbl(s)} {s['side']} — waiting for entry {s['entry_price']}",
                       f"Reached the target zone ({s['target_price']}); now watching for the entry to come.",
                       f"scalp_arm:{s['id']}:{today}")
            return  # still inactive, or just armed — either way wait for the next cycle to fire

        # state == "ARMED" coming into this cycle → normal entry trigger
        hit = (ask <= s["entry_price"]) if s["side"] == "BUY" else (bid >= s["entry_price"])
        if hit:
            ok, oid, msg = place_order(s["broker"], s["symbol"], s["side"], s["qty"], s["entry_price"], s["trade_type"])
            if ok and oid:
                db.update(s["id"], status="ENTERING", entry_order_id=str(oid))
                _alert(f"Scalp entry FIRED: {_lbl(s)} {s['side']} {s['qty']}@{s['entry_price']}",
                       f"{'ask' if s['side']=='BUY' else 'bid'} reached entry — LIMIT placed on {s['broker']}.",
                       f"scalp_fire:{s['id']}")
            else:
                _alert(f"Scalp entry FAILED to place: {_lbl(s)}", str(msg), f"scalp_firefail:{s['id']}:{time.time()//60}")
        return

    if st == "OPEN":
        exit_price = bid if s["side"] == "BUY" else ask  # long exits at the bid, short at the ask
        if s["trade_type"] == "MIS" and exit_price is not None:
            now = datetime.datetime.now().time()
            if now >= _MIS_FORCE_SQUAREOFF:
                place_exit(s, exit_price, "EOD_SQUAREOFF")
                return
            if now >= _MIS_PROFIT_SQUAREOFF:
                in_profit = (exit_price > s["entry_fill_price"]) if s["side"] == "BUY" else (exit_price < s["entry_fill_price"])
                if in_profit:
                    place_exit(s, exit_price, "EOD_PROFIT")
                    return
                # in loss/flat — keep watching target/SL below until the 15:19 force square-off

        if s["side"] == "BUY":
            if bid is not None and bid >= s["target_price"]:
                place_exit(s, s["target_price"], "TARGET")
            elif bid is not None and bid <= s["sl_price"]:
                place_exit(s, s["sl_price"], "SL")
        else:
            if ask is not None and ask <= s["target_price"]:
                place_exit(s, s["target_price"], "TARGET")
            elif ask is not None and ask >= s["sl_price"]:
                place_exit(s, s["sl_price"], "SL")


def _now():
    return datetime.datetime.utcnow().isoformat()


def _lbl(s):
    return s["symbol"].replace("NSE:", "").replace("-EQ", "")


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
