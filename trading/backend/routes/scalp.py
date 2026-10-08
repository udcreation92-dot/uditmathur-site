"""Cash-segment scalping endpoints."""
import math
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import scalp_db as db
import scalp_watcher
import events_db
import event_calendar
import rss_watcher
from zerodha_client import client as zclient

router = APIRouter(prefix="/scalp", tags=["scalp"])


def tradable_qty(max_loss: float, entry: float, sl: float) -> int:
    d = abs(sl - entry)
    return int(math.floor(max_loss / d)) if d > 0 else 0


class CreateScalp(BaseModel):
    symbol: str                 # Fyers equity, e.g. NSE:RELIANCE-EQ
    name: str | None = None
    side: str                   # BUY | SELL
    entry_price: float
    sl_price: float
    target_price: float
    max_loss: float = 100.0
    trade_type: str = "MIS"     # MIS | CNC
    broker: str = "fyers"
    note: str | None = None


@router.post("")
def create_scalp(req: CreateScalp):
    if req.side not in ("BUY", "SELL"):
        raise HTTPException(400, "side must be BUY or SELL")
    if req.trade_type not in ("MIS", "CNC"):
        raise HTTPException(400, "trade_type must be MIS or CNC")
    if not (req.entry_price > 0 and req.sl_price > 0 and req.target_price > 0):
        raise HTTPException(400, "entry / sl / target prices must be positive")
    qty = tradable_qty(req.max_loss, req.entry_price, req.sl_price)
    if qty < 1:
        raise HTTPException(400, "tradable qty < 1 — widen Max Loss or tighten the SL distance")
    sid = db.create_scalp(symbol=req.symbol, name=req.name, side=req.side, entry_price=req.entry_price,
                          sl_price=req.sl_price, target_price=req.target_price, max_loss=req.max_loss,
                          qty=qty, trade_type=req.trade_type, broker=req.broker, note=req.note, status="WAITING")
    scalp_watcher.wake()
    return db.get(sid)


@router.get("/list")
def list_scalps():
    """All scalps enriched with a live quote and (for OPEN) unrealized P&L. Also the global toggle."""
    import datetime
    today = datetime.date.today().isoformat()
    out = []
    for s in db.list_scalps():
        s = dict(s)
        # Surface the arming state so the UI can show it. A WAITING scalp's entry can only fire when
        # ARMED. 'PENDING' = snapshot not yet taken this session (e.g. pre-open); 'INACTIVE' = opened
        # on the wrong side of the entry, waiting to reach the target before it can arm.
        if s["status"] == "WAITING":
            eff = s.get("arm_state") if s.get("armed_date") == today else None
            s["arm_state"] = eff or "PENDING"
            s["armed"] = eff == "ARMED"
        else:
            s["arm_state"], s["armed"] = None, True
        if s["status"] in ("WAITING", "ENTERING", "OPEN", "EXITING"):
            q = scalp_watcher._quote(s["symbol"])
            if q:
                s["bid"], s["ask"], s["ltp"] = q.get("bid"), q.get("ask"), q.get("ltp")
                if s["status"] in ("OPEN", "EXITING") and s.get("entry_fill_price") and s.get("ltp"):
                    px = s["ltp"]
                    s["unrealized_pnl"] = round(((px - s["entry_fill_price"]) if s["side"] == "BUY"
                                                 else (s["entry_fill_price"] - px)) * s["qty"], 2)
            # Event risk on this script: upcoming financial results + any matching news headlines,
            # so an active scalp flags an event you may want to pause around.
            try:
                root = rss_watcher.extract_root(s["symbol"])
                s["earnings_event"] = event_calendar.earnings_within(root, days=7) if root else None
                s["news"] = (rss_watcher.find_relevant(s["symbol"]) or [])[:5]
            except Exception:
                s["earnings_event"], s["news"] = None, []
        out.append(s)
    return {"scalps": out, "auto_enabled": db.auto_enabled()}


class AutoReq(BaseModel):
    on: bool


@router.post("/auto")
def set_auto(req: AutoReq):
    db.set_auto_enabled(req.on)
    if req.on:
        # Un-arm all waiting scalps on switch-on: a scalp armed earlier must re-tag its target
        # before it can fire, so turning auto back on can't punch instantly against a price that
        # has since moved past the entry on the trigger side.
        db.clear_arming_waiting()
    events_db.add_event("scalp", f"Scalp auto-trade {'ON' if req.on else 'OFF'}",
                        "Entries/exits " + ("will now fire automatically." if req.on else "are paused — open scalps still show and can be exited manually."))
    scalp_watcher.wake()
    return {"auto_enabled": req.on}


class EditScalp(BaseModel):
    target_price: float | None = None
    sl_price: float | None = None


@router.patch("/{scalp_id}")
def edit_scalp(scalp_id: int, req: EditScalp):
    """Alter target / SL while WAITING or OPEN."""
    s = db.get(scalp_id)
    if not s:
        raise HTTPException(404, "Scalp not found")
    if s["status"] not in ("WAITING", "ENTERING", "OPEN"):
        raise HTTPException(400, "Can only edit a waiting or open scalp")
    fields = {}
    if req.target_price is not None and req.target_price > 0:
        fields["target_price"] = req.target_price
    if req.sl_price is not None and req.sl_price > 0:
        fields["sl_price"] = req.sl_price
        if s["status"] == "WAITING":  # SL feeds the qty while still waiting
            fields["qty"] = tradable_qty(s["max_loss"], s["entry_price"], req.sl_price)
    db.update(scalp_id, **fields)
    scalp_watcher.wake()
    return db.get(scalp_id)


class TradeTypeReq(BaseModel):
    trade_type: str   # MIS | CNC


@router.post("/{scalp_id}/trade-type")
def change_trade_type(scalp_id: int, req: TradeTypeReq):
    """Change MIS <-> CNC. For a WAITING scalp it's just a ledger change; for an OPEN one it also
    converts the product at the broker so the position genuinely carries forward (CNC) or stays
    intraday (MIS)."""
    if req.trade_type not in ("MIS", "CNC"):
        raise HTTPException(400, "trade_type must be MIS or CNC")
    s = db.get(scalp_id)
    if not s:
        raise HTTPException(404, "Scalp not found")
    if s["trade_type"] == req.trade_type:
        return s
    warn = None
    if s["status"] in ("OPEN", "EXITING") and s["broker"] == "zerodha":
        try:
            body = s["symbol"].split(":")[-1]
            tsym = body[:-3] if body.endswith("-EQ") else body
            zclient.get_api().convert_position(
                exchange="NSE", tradingsymbol=tsym,
                transaction_type="BUY" if s["side"] == "BUY" else "SELL",
                position_type="day", quantity=s["qty"],
                old_product="MIS" if s["trade_type"] == "MIS" else "CNC",
                new_product="MIS" if req.trade_type == "MIS" else "CNC")
        except Exception as e:
            warn = f"Ledger updated, but the Zerodha product conversion failed: {e}. Convert it in the broker app."
    elif s["status"] in ("OPEN", "EXITING"):
        warn = f"Ledger updated to {req.trade_type}. Convert the product in the {s['broker']} app too (auto-conversion isn't wired for that broker)."
    db.update(scalp_id, trade_type=req.trade_type)
    r = db.get(scalp_id)
    r["warning"] = warn
    return r


class PauseReq(BaseModel):
    paused: bool


@router.post("/{scalp_id}/pause")
def pause_scalp(scalp_id: int, req: PauseReq):
    """Pause/resume a single scalp — while paused it won't auto-enter (WAITING) or auto-exit (OPEN),
    but its resting orders still reconcile and manual exit still works. For sitting out an event."""
    s = db.get(scalp_id)
    if not s:
        raise HTTPException(404, "Scalp not found")
    db.update(scalp_id, paused=1 if req.paused else 0)
    scalp_watcher.wake()
    return db.get(scalp_id)


@router.post("/{scalp_id}/cancel")
def cancel_scalp(scalp_id: int):
    """Cancel a scalp that hasn't entered yet (WAITING). Open scalps must be exited, not cancelled."""
    s = db.get(scalp_id)
    if not s:
        raise HTTPException(404, "Scalp not found")
    if s["status"] not in ("WAITING",):
        raise HTTPException(400, "Only a WAITING scalp can be cancelled — exit an open one instead")
    db.update(scalp_id, status="CANCELLED")
    return {"cancelled": True}


@router.post("/{scalp_id}/exit")
def manual_exit(scalp_id: int):
    """Exit an OPEN scalp now — a marketable LIMIT (sell at the bid / buy at the ask) so it fills."""
    s = db.get(scalp_id)
    if not s:
        raise HTTPException(404, "Scalp not found")
    if s["status"] != "OPEN":
        raise HTTPException(400, "Only an OPEN scalp can be exited")
    q = scalp_watcher._quote(s["symbol"])
    if not q:
        raise HTTPException(502, "No live quote to price the exit")
    price = q["bid"] if s["side"] == "BUY" else q["ask"]   # sell at bid / buy at ask
    ok, oid, msg = scalp_watcher.place_exit(s, price, "MANUAL")
    if not ok:
        raise HTTPException(502, f"Exit order rejected: {msg}")
    return {"exiting": True, "order_id": oid, "price": price}


@router.delete("/{scalp_id}")
def delete_scalp(scalp_id: int):
    """Remove a scalp record (CLOSED/CANCELLED cleanup, or a WAITING one you don't want)."""
    s = db.get(scalp_id)
    if not s:
        raise HTTPException(404, "Scalp not found")
    db.delete(scalp_id)
    return {"deleted": True}


@router.get("/report")
def report():
    """Cash-segment performance: open (unrealized) + completed (realized) scalps."""
    scalps = db.list_scalps()
    closed = [s for s in scalps if s["status"] == "CLOSED"]
    realized = sum(s.get("realized_pnl") or 0 for s in closed)
    wins = [s for s in closed if (s.get("realized_pnl") or 0) > 0]
    losses = [s for s in closed if (s.get("realized_pnl") or 0) < 0]
    open_scalps, unrealized = [], 0.0
    for s in scalps:
        if s["status"] in ("OPEN", "EXITING") and s.get("entry_fill_price"):
            q = scalp_watcher._quote(s["symbol"])
            if q and q.get("ltp"):
                u = ((q["ltp"] - s["entry_fill_price"]) if s["side"] == "BUY" else (s["entry_fill_price"] - q["ltp"])) * s["qty"]
                unrealized += u
            open_scalps.append(s["id"])
    return {
        "realized_pnl": round(realized, 2),
        "unrealized_pnl": round(unrealized, 2),
        "total_pnl": round(realized + unrealized, 2),
        "closed_count": len(closed), "wins": len(wins), "losses": len(losses),
        "win_rate": round(100 * len(wins) / len(closed), 1) if closed else None,
        "avg_win": round(sum(s["realized_pnl"] for s in wins) / len(wins), 0) if wins else None,
        "avg_loss": round(sum(s["realized_pnl"] for s in losses) / len(losses), 0) if losses else None,
        "open_count": len(open_scalps),
        "waiting_count": sum(1 for s in scalps if s["status"] == "WAITING"),
    }
