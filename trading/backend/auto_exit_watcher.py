"""Auto-exit engine. Polls the armed strategies' live exit ROI (P&L at bid/ask ÷ margin) and, when
a target is reached, AUTOMATICALLY places limit exit orders at the current bid/ask on each leg.

Real-money automation: arming a target in the UI is the user's explicit consent (the normal
per-order confirm is intentionally bypassed here — that's the whole point of the feature). Refuses
to fire on a read-only/ephemeral deployment (LEDGER_READ_ONLY)."""
import os
import threading
import time

import strategy_db as db
import events_db

POLL_INTERVAL = 15  # seconds — fast enough to catch a target without hammering broker quotes
_READ_ONLY = os.environ.get("LEDGER_READ_ONLY", "").strip().lower() in ("1", "true", "yes")
_MAX_RETRIES = 4          # partial-placement retries before giving up loudly on a stuck leg
_RETRIES: dict[int, int] = {}   # strategy_id -> consecutive partial-placement attempts

_stop_event = threading.Event()
_wake_event = threading.Event()
_thread: threading.Thread | None = None


def _cycle():
    armed = db.list_armed_auto_exits()
    if not armed or _READ_ONLY:
        return
    targets = {a["strategy_id"]: a for a in armed}
    # Deferred import: routes.strategy is the shared compute + order-placement home, and main.py
    # imports both this module and the routes.
    from routes.strategy import compute_strategies, execute_auto_exit

    for s in compute_strategies():
        a = targets.get(s["id"])
        if not a or s.get("status") != "OPEN":
            continue
        trigger = (a.get("trigger_type") or "roi")
        if trigger == "spot":
            # Fire when the UNDERLYING's LTP crosses the target level in the chosen direction —
            # a hard price stop, exiting at whatever bid/ask is live then. 'above' fires when spot
            # >= target (call-side breach), 'below' when spot <= target (put-side breach).
            spot = s.get("spot")
            target_spot, spot_dir = a.get("target_spot"), a.get("spot_dir")
            if spot is None or target_spot is None:
                continue
            hit = (spot >= target_spot) if spot_dir == "above" else (spot <= target_spot)
            if not hit:
                continue
            note = f"underlying LTP {spot} {'>=' if spot_dir == 'above' else '<='} target {target_spot}"
        else:
            # Trigger on LIVE ROI (annualized forward capture, same as the card's "Live ROI p.a."
            # tile) falling TO OR BELOW the target: for short premium, entry locks in e.g. 24% p.a.;
            # once the remaining capture decays to <= target (e.g. 10%), most of the edge is banked
            # and the residual isn't worth the risk — buy it back. Adverse moves RAISE live ROI
            # (buyback costs more), so this direction can't fire into a loss-making squeeze.
            roi = s.get("roi_pct")
            if roi is None:
                continue  # needs margin + live quotes; skip until both exist
            if roi > a["target_roi_pct"]:
                continue
            note = f"live ROI {roi:.1f}% p.a. <= target {a['target_roi_pct']}% p.a."
        try:
            result = execute_auto_exit(s)
        except Exception as e:
            events_db.add_event(
                "auto_exit",
                f"Auto-exit FAILED to place orders: '{s['name']}'",
                body=f"{note}. Error: {e}. Check the broker and the strategy manually.",
                dedupe_key=f"autoexit_err:{s['id']}:{a['created_at']}",
            )
            db.mark_auto_exit_fired(s["id"], note=f"error: {e}")
            continue
        legs = result.get("legs", [])
        placed = sum(1 for l in legs if l.get("ok"))
        all_ok = bool(legs) and all(l.get("ok") for l in legs)
        if all_ok:
            # Every open leg now has a resting (or freshly placed) exit — done. execute_auto_exit
            # skips legs that already have a closing order, so a retry never double-sells.
            _RETRIES.pop(s["id"], None)
            db.mark_auto_exit_fired(s["id"], note=note)
            events_db.add_event(
                "auto_exit", f"Auto-exit fired: '{s['name']}' — {note}",
                body=f"Placed {placed}/{len(legs)} limit exit orders at bid/ask ({note}). All resting at broker.",
                dedupe_key=f"autoexit:{s['id']}:{a['created_at']}")
            continue
        # PARTIAL: some leg couldn't be placed (no quote / broker reject). Do NOT mark fired — leave
        # it ARMED so the next cycle retries ONLY the un-exited legs (the placed ones now get skipped).
        # After a few failed cycles, give up loudly rather than spin forever — a naked leg the system
        # can't close needs a human.
        n = _RETRIES.get(s["id"], 0) + 1
        _RETRIES[s["id"]] = n
        fails = [l for l in legs if not l.get("ok")]
        detail = "; ".join(f"{l.get('symbol')}: {l.get('message', 'failed')}" for l in fails)
        if n >= _MAX_RETRIES:
            _RETRIES.pop(s["id"], None)
            db.mark_auto_exit_fired(s["id"], note=f"{note} — PARTIAL after {n} tries: {detail}")
            events_db.add_event(
                "auto_exit", f"⚠ Auto-exit STUCK: '{s['name']}' — a leg won't close",
                body=(f"Placed {placed}/{len(legs)}; after {n} tries these still won't place: {detail}. "
                      "The other leg(s) are exiting/exited — EXIT THE REMAINING LEG MANUALLY NOW."),
                dedupe_key=f"autoexit_stuck:{s['id']}:{a['created_at']}")
        else:
            events_db.add_event(
                "auto_exit", f"Auto-exit partial: '{s['name']}' — retrying leg",
                body=(f"Placed {placed}/{len(legs)} ({note}). Retrying the rest (attempt {n}/{_MAX_RETRIES}): {detail}."),
                dedupe_key=f"autoexit_partial:{s['id']}:{a['created_at']}:{n}")


def _loop():
    while not _stop_event.is_set():
        try:
            _cycle()
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
