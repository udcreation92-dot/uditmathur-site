"""
Guarded order execution for the AI ROI strategy (Phase 3). Short strangle = SELL CE + SELL PE.

Safety model (the LLM NEVER enforces limits — this backend does, on every call):
  - trading_mode gate: 'killed' refuses everything; 'dry_run' simulates + logs; 'live' places.
  - instrument allowlist (NIFTY only to start), options-only (CE/PE), LIMIT orders only.
  - place_order requires confirm=True (two-step: preview_order first, then place with confirm).
  - PER_ORDER_MARGIN_CAP backstop (currently disabled per user choice — set a number to enable).
  - every order recorded in strategy_db so order_watcher reconciles fills; every action audited.

preview_order shows EXACTLY what would be sent (no side effects). place_order acts per trading_mode.
"""
import datetime
import re

import events_db
import freeze_qty
import shoonya_symbols
import strategy_db as db
import trading_mode
from fyers_client import client as fyers
from zerodha_client import client as zclient
from shoonya_client import client as sclient
from symbol_master import get_lot_size
import roi_solver

ALLOWED_ROOTS = None               # None = ALL optionable instruments allowed (options-only still enforced);
                                   # set to a set() like {"NIFTY","BANKNIFTY"} to restrict.
PER_ORDER_MARGIN_CAP = None        # ₹ backstop; None = no cap (user choice). Set a number to enable.
DEFAULT_EXEC_BROKER = "shoonya"    # margin math is Zerodha; execution defaults to Shoonya
DEFAULT_FILL_MODE = "protective"   # 'protective' (fill even if price ticks down) or 'exact' (at the bid)
FILL_MODES = ("protective", "exact")
TICK = 0.05                        # NSE option tick
PROTECTIVE_PCT = 2.0               # protective SELL sits this % below the bid (>= 1 tick), to fill reliably


def _round_tick(p: float) -> float:
    return round(round(p / TICK) * TICK, 2)


def _fill_price(bid: float, fill_mode: str) -> float:
    """SELL limit price for one leg. 'exact' = the bid (fills only while that bid holds). 'protective'
    = a hair below the bid (>= 1 tick, ~PROTECTIVE_PCT%) so it stays marketable and fills even if the
    price ticks down — you collect slightly less but rarely miss the fill. Floored at one tick."""
    if fill_mode == "exact":
        return _round_tick(bid)
    buffer = max(TICK, _round_tick(bid * PROTECTIVE_PCT / 100))
    return _round_tick(max(_round_tick(bid) - buffer, TICK))


def _root(fyers_symbol: str) -> str:
    body = fyers_symbol.split(":")[-1]
    m = re.match(r"^([A-Z]+)", body)
    return m.group(1) if m else body


def _is_option(fyers_symbol: str) -> bool:
    return fyers_symbol.split(":")[-1].endswith(("CE", "PE"))


def _guardrail_problems(ce_symbol, pe_symbol, lots, est_margin) -> list[str]:
    problems = []
    mode = trading_mode.get_mode()
    if mode == "killed":
        problems.append("KILL SWITCH is ON — all order placement is disabled (set_trading_mode).")
    if lots < 1:
        problems.append("lots must be >= 1.")
    for sym in (ce_symbol, pe_symbol):
        if not _is_option(sym):
            problems.append(f"{sym} is not an option — only CE/PE legs may be placed.")
        if ALLOWED_ROOTS is not None and _root(sym) not in ALLOWED_ROOTS:
            problems.append(f"{_root(sym)} is not in the allowed instruments {sorted(ALLOWED_ROOTS)}.")
    if PER_ORDER_MARGIN_CAP is not None and est_margin and est_margin > PER_ORDER_MARGIN_CAP:
        problems.append(f"est margin ₹{est_margin:,.0f} exceeds per-order cap ₹{PER_ORDER_MARGIN_CAP:,.0f}.")
    return problems


def _shoonya_symbol(fyers_symbol: str) -> dict:
    return shoonya_symbols.fyers_to_shoonya(fyers_symbol)


def _broker_symbol(broker: str, fyers_symbol: str) -> str:
    """Display-only broker symbol for the preview. Resilient: if the broker's symbol master isn't
    available (e.g. Shoonya logged out), fall back to the Fyers symbol rather than failing the
    preview — the real conversion happens at placement time (when the broker must be logged in)."""
    try:
        if broker == "shoonya":
            c = _shoonya_symbol(fyers_symbol)
            return f"{c['exch']}:{c['tsym']}"
        if broker == "zerodha":
            return f"NFO:{fyers_symbol.split(':')[-1]}"
        return fyers_symbol  # fyers
    except Exception:
        return f"{fyers_symbol} (broker symbol resolved at placement — is {broker} logged in?)"


def _place_leg(broker: str, fyers_symbol: str, qty: int, limit: float):
    """Place ONE short (SELL) option leg as a LIMIT NRML/carry order. Returns (ok, order_id, err)."""
    if broker == "zerodha":
        oid = zclient.place_order(
            variety="regular", exchange="NFO", tradingsymbol=fyers_symbol.split(":")[-1],
            transaction_type="SELL", quantity=qty, product="NRML", order_type="LIMIT", price=limit,
        )
        return True, oid, None
    if broker == "shoonya":
        c = _shoonya_symbol(fyers_symbol)
        res = sclient.place_order(
            exchange=c["exch"], tradingsymbol=c["tsym"], transaction_type="S",
            quantity=qty, price_type="LMT", product="M", price=limit,
        )
        ok = res.get("stat") == "Ok"
        return ok, res.get("norenordno"), None if ok else res.get("emsg", str(res))
    # fyers
    res = fyers.place_order(symbol=fyers_symbol, qty=qty, side=-1, order_type=1,
                            product_type="MARGIN", limit_price=limit)
    ok = bool(res and res.get("s") == "ok")
    return ok, (res.get("id") if res else None), None if ok else str(res)


def _place_leg_sliced(broker, fyers_symbol, slice_qtys, limit, lot_size, root):
    """Place ONE leg as its freeze-qty-compliant chunks. If a chunk is still rejected for freeze qty
    (unknown/updated instrument), learn the real limit from the broker message and re-split just that
    chunk — so it self-corrects within this call. Returns a list of {status, order_id|error, qty}."""
    out, queue, guard = [], list(slice_qtys), 0
    while queue and guard < 80:
        guard += 1
        chunk = queue.pop(0)
        try:
            ok, oid, err = _place_leg(broker, fyers_symbol, chunk, limit)
        except Exception as e:
            ok, oid, err = False, None, str(e)
        if not ok:
            fq = freeze_qty.parse_reject(err)
            new_max = (fq // lot_size) * lot_size if fq else 0
            if new_max and new_max < chunk:   # broker's freeze qty is smaller than this chunk — re-split
                freeze_qty.learn(root, fq)
                queue = freeze_qty.chunks(chunk, max(new_max, lot_size)) + queue
                continue
        out.append({"status": "PENDING" if ok else "ERROR",
                    **({"order_id": str(oid)} if ok else {"error": err}), "qty": chunk})
    return out


def _build(ce_symbol, pe_symbol, lots, ce_bid, pe_bid, broker, fill_mode):
    """ce_bid/pe_bid are the current bids (from roi_solve). The actual SELL limit sent is derived
    from fill_mode (protective sits just below the bid; exact = the bid)."""
    lot_size = get_lot_size(ce_symbol) or get_lot_size(pe_symbol)
    qty = lots * lot_size
    ce_limit = _fill_price(ce_bid, fill_mode)
    pe_limit = _fill_price(pe_bid, fill_mode)
    try:
        margin_per_lot = roi_solver._zerodha_strangle_margin_per_lot(ce_symbol, pe_symbol, lot_size)
        est_margin = round(margin_per_lot * lots, 2)
    except Exception:
        est_margin = None
    gross_premium = round((ce_limit + pe_limit) * qty, 2)   # at the ACTUAL limits you'd collect
    # Auto-slice: NSE caps a single option order at the instrument's freeze qty, so split each leg
    # into lot-aligned chunks <= that. Brokerage counts the ACTUAL number of orders (₹6 each).
    root = _root(ce_symbol)
    max_per_order = freeze_qty.max_qty(root, lot_size)
    ce_slices = freeze_qty.chunks(qty, max_per_order)
    pe_slices = freeze_qty.chunks(qty, max_per_order)
    total_orders = len(ce_slices) + len(pe_slices)
    brokerage = round(roi_solver.BROKERAGE_PER_ORDER * total_orders, 2)
    legs = [
        {"leg": "CE", "action": "SELL", "fyers_symbol": ce_symbol,
         "broker_symbol": _broker_symbol(broker, ce_symbol), "qty": qty,
         "bid": ce_bid, "limit": ce_limit, "slices": ce_slices},
        {"leg": "PE", "action": "SELL", "fyers_symbol": pe_symbol,
         "broker_symbol": _broker_symbol(broker, pe_symbol), "qty": qty,
         "bid": pe_bid, "limit": pe_limit, "slices": pe_slices},
    ]
    return lot_size, qty, est_margin, gross_premium, brokerage, legs, max_per_order, total_orders


def preview_order(ce_symbol, pe_symbol, lots, ce_limit, pe_limit,
                  broker=DEFAULT_EXEC_BROKER, fill_mode=DEFAULT_FILL_MODE) -> dict:
    """Show EXACTLY what place_order would send — no side effects. Includes the guardrail verdict.
    ce_limit/pe_limit are the current bids from roi_solve; the SELL limit actually sent depends on
    fill_mode (protective = just below the bid so it fills reliably; exact = at the bid)."""
    if fill_mode not in FILL_MODES:
        fill_mode = DEFAULT_FILL_MODE
    lot_size, qty, est_margin, gross_premium, brokerage, legs, max_per_order, total_orders = _build(
        ce_symbol, pe_symbol, lots, ce_limit, pe_limit, broker, fill_mode)
    problems = _guardrail_problems(ce_symbol, pe_symbol, lots, est_margin)
    per_leg_orders = len(legs[0]["slices"])
    return {
        "mode": trading_mode.get_mode(),
        "broker": broker,
        "fill_mode": fill_mode,
        "structure": "short_strangle (SELL CE + SELL PE), LIMIT NRML",
        "lots": lots, "lot_size": lot_size, "qty_per_leg": qty,
        "max_qty_per_order": max_per_order,
        "orders_per_leg": per_leg_orders,
        "total_orders": total_orders,
        "slicing_note": (f"each leg auto-split into {per_leg_orders} order(s) of ≤{max_per_order} "
                         f"qty (NSE freeze limit) — {total_orders} orders total"
                         if per_leg_orders > 1 else "fits in one order per leg (no slicing)"),
        "legs": legs,
        "gross_premium": gross_premium,
        "brokerage": brokerage,
        "net_premium": round(gross_premium - brokerage, 2),
        "est_margin": est_margin,
        "guardrails_ok": not problems,
        "problems": problems,
        "next": "If this looks right, call place_order with the same params and confirm=true.",
    }


def place_order(ce_symbol, pe_symbol, lots, ce_limit, pe_limit,
                broker=DEFAULT_EXEC_BROKER, fill_mode=DEFAULT_FILL_MODE, confirm=False) -> dict:
    """Place (or, in dry_run, simulate) the short strangle. Requires confirm=True. Enforces all
    guardrails. fill_mode (protective/exact) sets the SELL limit relative to the bid. Records every
    leg in strategy_db so order_watcher reconciles + Telegrams fills."""
    if not confirm:
        return {"placed": False, "error": "confirm=true is required — call preview_order first, "
                                           "show the user, then place_order with confirm=true."}
    if fill_mode not in FILL_MODES:
        fill_mode = DEFAULT_FILL_MODE
    lot_size, qty, est_margin, gross_premium, brokerage, legs, max_per_order, total_orders = _build(
        ce_symbol, pe_symbol, lots, ce_limit, pe_limit, broker, fill_mode)
    problems = _guardrail_problems(ce_symbol, pe_symbol, lots, est_margin)
    if problems:
        events_db.add_event("order_rejected", f"ROI strangle REJECTED ({broker})", "; ".join(problems))
        return {"placed": False, "rejected": True, "problems": problems, "mode": trading_mode.get_mode()}

    mode = trading_mode.get_mode()
    ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    strategy_id = db.create_strategy(name=f"ROI strangle {ts}",
                                     notes=f"{broker} {lots} lot(s); mode={mode}")
    results = []
    for leg in legs:
        sym, limit, slices = leg["fyers_symbol"], leg["limit"], leg["slices"]
        if mode == "dry_run":
            subs = [{"status": "SIMULATED", "qty": c} for c in slices]
        else:  # live — place each freeze-qty chunk as its own order (self-corrects on freeze reject)
            subs = _place_leg_sliced(broker, sym, slices, limit, lot_size, _root(sym))
        for s in subs:
            db.add_order(strategy_id, broker, sym, "SELL", s["qty"], limit,
                         order_id=s.get("order_id"),
                         status=("SIMULATED" if mode == "dry_run"
                                 else ("PENDING" if s["status"] == "PENDING" else "CANCELLED")),
                         source="roi_ai")
        results.append({"leg": leg["leg"], "broker_symbol": leg["broker_symbol"],
                        "limit": limit, "orders": len(subs), "sub_orders": subs})

    all_subs = [s for r in results for s in r["sub_orders"]]
    placed_live = mode == "live" and bool(all_subs) and all(s["status"] == "PENDING" for s in all_subs)
    events_db.add_event(
        "order_simulated" if mode == "dry_run" else "order_placed",
        f"ROI strangle {'SIMULATED' if mode == 'dry_run' else 'placed'} ({broker}) {lots} lot(s), {total_orders} orders",
        f"{ce_symbol} + {pe_symbol} @ {ce_limit}/{pe_limit} · est margin ₹{est_margin or 0:,.0f}",
    )
    return {
        "placed": mode == "live", "simulated": mode == "dry_run", "mode": mode,
        "broker": broker, "strategy_id": strategy_id, "lots": lots, "qty_per_leg": qty,
        "orders_per_leg": len(legs[0]["slices"]), "total_orders": total_orders,
        "est_margin": est_margin, "brokerage": brokerage, "net_premium": round(gross_premium - brokerage, 2),
        "legs": results,
        "note": ("DRY-RUN — nothing was sent to the broker; flip to live with set_trading_mode('live')."
                 if mode == "dry_run" else
                 ("all legs/chunks accepted — order_watcher will track fills and Telegram you."
                  if placed_live else "one or more chunks failed — check legs[].sub_orders[].error.")),
    }
