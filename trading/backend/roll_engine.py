"""Strategy ROLL: exit a strategy that isn't working and redeploy its margin into a better one.

The exiting strategy's LIVE ROI (annualized remaining capture — what you forfeit by exiting) and
its MARGIN (what gets released) become the search constraints: candidates must offer ROI >= that
floor on real (Zerodha basket) margin <= that budget.

Scan = the short-strangle ROI scanner, plus an iron-condor ("winged") variant of each qualifying
strangle for defined-risk alternatives. Candidate ROI is recomputed on REAL margin, not the
scanner's ELM lower-bound, so the floor comparison is honest.

Execution is SEQUENTIAL and margin-safe: place limit exits at bid/ask (reusing the auto-exit
placement path) -> poll until every leg is flat -> only then place the new strategy's entry legs
as limit orders at fresh bids. If exits don't fill within the timeout, the roll STALLS and never
enters — it will not fire an entry the released margin can't fund."""
import threading
import time
import uuid

import roi_scanner
import spread_scanner
import events_db
from fyers_client import client
from zerodha_client import client as zclient

SCAN_TOP_N = 12          # candidates priced with a real basket-margin call
CONDOR_TOP_N = 6         # of those, how many also get a winged variant (extra chain fetch each)
EXIT_FILL_TIMEOUT = 15 * 60
EXIT_POLL_INTERVAL = 10
MARGIN_HEADROOM = 0.98   # require candidate margin <= 98% of released margin

_jobs: dict[str, dict] = {}
_jobs_lock = threading.Lock()


def _basket_margin(legs: list[dict]) -> float | None:
    """Real margin for a set of {tradingsymbol, side, qty} NFO legs via Zerodha basket API."""
    orders = [{
        "exchange": "NFO", "tradingsymbol": l["tradingsymbol"], "transaction_type": l["side"],
        "variety": "regular", "product": "NRML", "order_type": "MARKET",
        "quantity": l["qty"], "price": 0, "trigger_price": 0,
    } for l in legs]
    try:
        return zclient.get_basket_margins(orders).get("final", {}).get("total")
    except Exception:
        return None


def _bare(symbol: str) -> str:
    return symbol.split(":", 1)[1] if ":" in symbol else symbol


def _expiries(underlying: str) -> list[dict]:
    """All expiries for the target script, soonest first."""
    try:
        chain = client.get_option_chain(underlying, strike_count=3, timestamp="")
        if chain and chain.get("s") == "ok":
            return chain["data"].get("expiryData", [])
    except Exception:
        pass
    return []


def _days_to(expiry_ts: int) -> int:
    import datetime
    return (datetime.datetime.fromtimestamp(int(expiry_ts)).date() - datetime.date.today()).days + 1


def _price_candidate(legs_spec: list[dict], premium_money: float, days: int,
                     roi_floor: float, margin_budget: float) -> tuple[float, float] | None:
    """Real basket margin + honest annualized ROI; None if it misses the floor/budget."""
    margin = _basket_margin([{"tradingsymbol": _bare(l["symbol"]), "side": l["side"],
                              "qty": l["lot_size"]} for l in legs_spec])
    if not margin or margin > margin_budget * MARGIN_HEADROOM:
        return None
    roi = (premium_money / margin) * (365 / max(days, 1)) * 100
    if roi < roi_floor:
        return None
    return round(margin, 0), round(roi, 2)


SPREAD_WIDTHS_PER_SIDE = 3  # hedge widths priced (real margin) per side


def list_roll_expiries(target: str) -> list[dict]:
    """Selectable expiries for the roll UI: [{expiry_ts, date, days}], soonest first, future only."""
    return [{"expiry_ts": int(e["expiry"]), "date": e["date"], "days": _days_to(int(e["expiry"]))}
            for e in _expiries(target) if _days_to(int(e["expiry"])) >= 1]


def _nearest_strike(strikes: list[float], level: float) -> float | None:
    """Snap a user-supplied PRICE LEVEL to the closest available strike in the chain."""
    return min(strikes, key=lambda s: abs(s - level)) if strikes else None


def scan_for_roll(strategy: dict, target: str, expiry_ts: int,
                  safe_ce_level: float | None, safe_pe_level: float | None,
                  include_itm: bool = False, roi_floor_override: float | None = None,
                  ignore_margin: bool = False) -> dict:
    """Roll candidates in the USER-CHOSEN target script and expiry. `safe_ce_level`/`safe_pe_level`
    are OPTIONAL PRICE LEVELS you consider safe; each is snapped to the nearest strike. When BOTH
    are given we also add (b) a safe strangle at those strikes and (c) credit spreads selling them;
    when omitted (e.g. in a hurry) only (a) the short-strangle scan runs so you still get results.
    `include_itm` lets the strangle scan reach ITM strikes too, not just OTM/ATM. By default the
    exiting strategy's live ROI is the floor and its margin the budget; `roi_floor_override` sets a
    custom floor instead, and `ignore_margin` drops the margin-budget filter entirely. All
    candidates are re-priced on REAL basket margin. Sorted ASCENDING by ROI; strangles beyond the
    safe levels are flagged SAFE."""
    margin_budget = strategy.get("margin")
    roi_floor = roi_floor_override if roi_floor_override is not None else strategy.get("roi_pct")
    if roi_floor is None or not margin_budget:
        raise ValueError("Strategy needs a live ROI and margin to roll (broker quotes + margin required)")

    days = _days_to(expiry_ts)
    if days < 1:
        raise ValueError("Chosen expiry is in the past")

    chain = client.get_option_chain(target, strike_count=40, timestamp=str(expiry_ts))
    if not chain or chain.get("s") != "ok":
        raise ValueError(f"No option chain for {target} at that expiry — is it an F&O underlying?")
    rows = chain["data"]["optionsChain"]
    exp_date = next((e["date"] for e in chain["data"].get("expiryData", [])
                     if int(e["expiry"]) == expiry_ts), str(expiry_ts))
    ce_by_strike = {r["strike_price"]: r for r in rows if r["option_type"] == "CE"}
    pe_by_strike = {r["strike_price"]: r for r in rows if r["option_type"] == "PE"}

    have_safe = safe_ce_level and safe_pe_level
    ce_strike = _nearest_strike(list(ce_by_strike), safe_ce_level) if have_safe else None
    pe_strike = _nearest_strike(list(pe_by_strike), safe_pe_level) if have_safe else None

    out = []
    # Diagnostics so an empty result can explain WHY nothing qualified (margin vs ROI).
    diag = {"priced": 0, "rejected_margin": 0, "rejected_roi": 0,
            "cheapest_margin": None, "best_roi_in_budget": None}

    def _price(legs, premium_money, cand_days):
        """Real basket margin + annualized ROI on it; None only if the margin call fails. No filtering."""
        margin = _basket_margin([{"tradingsymbol": _bare(l["symbol"]), "side": l["side"],
                                  "qty": l["lot_size"]} for l in legs])
        if not margin:
            return None
        return margin, (premium_money / margin) * (365 / max(cand_days, 1)) * 100

    def consider(legs, premium_money, cand_days):
        """Real basket margin + honest annualized ROI; returns (margin, roi) if it clears the ROI
        floor AND the margin budget, else None. Records why it was rejected either way."""
        pr = _price(legs, premium_money, cand_days)
        if not pr:
            return None
        margin, roi = pr
        diag["priced"] += 1
        diag["cheapest_margin"] = margin if diag["cheapest_margin"] is None else min(diag["cheapest_margin"], margin)
        within_budget = ignore_margin or margin <= margin_budget * MARGIN_HEADROOM
        if within_budget:
            diag["best_roi_in_budget"] = roi if diag["best_roi_in_budget"] is None else max(diag["best_roi_in_budget"], roi)
        if not within_budget:
            diag["rejected_margin"] += 1
            return None
        if roi < roi_floor:
            diag["rejected_roi"] += 1
            return None
        return round(margin, 0), round(roi, 2)

    # (a) scanner-chosen strangles on the target, this expiry only
    try:
        raw = roi_scanner.scan(target_roi_pct=roi_floor, underlyings=[target], max_expiries=6,
                               include_itm=include_itm)
    except Exception:
        raw = []
    raw = [c for c in raw if c.get("expiry_date") == exp_date and c.get("roi_pct")]

    def _strangle_legs(c):
        return [
            {"symbol": c["ce_symbol"], "side": "SELL", "price": c["ce_bid"], "lot_size": c["lot_size"]},
            {"symbol": c["pe_symbol"], "side": "SELL", "price": c["pe_bid"], "lot_size": c["lot_size"]},
        ]

    # The scanner's roi_pct is an ELM-only estimate (~4x the real-margin ROI, since ELM margin is a
    # fraction of true basket margin). Filtering/sorting on it alone is misleading: at a HIGH floor
    # every strangle passes the ELM filter, but only the TIGHT (high real-ROI) strikes actually clear
    # the floor on real margin — and those have the highest ELM-ROI, so a naive lowest-ELM-first scan
    # never reaches them. So: calibrate an ELM->real ratio from one real-margin sample, estimate each
    # candidate's real ROI, and precisely price the ones whose ESTIMATED real ROI clears the floor,
    # lowest-risk first. This finds the low-excess-risk survivors in both high- and low-floor regimes.
    raw.sort(key=lambda c: c["roi_pct"])
    k = None
    if raw:
        mid = raw[len(raw) // 2]
        mp = _price(_strangle_legs(mid), mid["premium_money"], mid["days_to_expiry"])
        if mp and mid["roi_pct"]:
            k = mp[1] / mid["roi_pct"]           # real ROI / ELM ROI
    if k:
        for c in raw:
            c["_est_real"] = c["roi_pct"] * k
        # 0.85 buffer absorbs per-strike margin variation the single-sample ratio doesn't capture.
        pool = [c for c in raw if c["_est_real"] >= roi_floor * 0.85]
        pool.sort(key=lambda c: c["_est_real"])  # least excess risk first
        to_price = pool[:18]
    else:
        to_price = raw[:18]

    want_survivors = 8
    for cand in to_price:
        legs = _strangle_legs(cand)
        priced = consider(legs, cand["premium_money"], cand["days_to_expiry"])
        if priced:
            # "Safe" = both legs sit at or beyond your safe levels (CE at/above safe CE strike,
            # PE at/below safe PE strike) — i.e. no closer to spot than you said you're comfortable.
            # Only meaningful when you entered safe levels; otherwise unflagged.
            safe = bool(have_safe and cand.get("ce_strike", 0) >= ce_strike
                        and cand.get("pe_strike", 1e12) <= pe_strike)
            out.append({**cand, "type": "Short Strangle", "underlying": target, "safe": safe,
                        "real_margin": priced[0], "real_roi_pct": priced[1], "entry_legs": legs})
            if sum(1 for c in out if c["type"] == "Short Strangle") >= want_survivors:
                break

    # (b) safe strangle + (c) credit spreads only run when you supplied safe levels.
    ce_row = ce_by_strike.get(ce_strike) if have_safe else None
    pe_row = pe_by_strike.get(pe_strike) if have_safe else None
    if ce_row and pe_row and (ce_row.get("bid") or 0) > 0 and (pe_row.get("bid") or 0) > 0:
        from symbol_master import get_lot_size
        lot = get_lot_size(ce_row["symbol"])
        prem = (ce_row["bid"] + pe_row["bid"]) * lot
        legs = [
            {"symbol": ce_row["symbol"], "side": "SELL", "price": ce_row["bid"], "lot_size": lot},
            {"symbol": pe_row["symbol"], "side": "SELL", "price": pe_row["bid"], "lot_size": lot},
        ]
        priced = consider(legs, prem, days)
        if priced:
            out.append({"type": "Safe Strangle", "underlying": target, "expiry_date": exp_date,
                        "days_to_expiry": days, "ce_strike": ce_strike, "pe_strike": pe_strike,
                        "premium_money": round(prem, 2), "lot_size": lot,
                        "real_margin": priced[0], "real_roi_pct": priced[1], "entry_legs": legs})

    # (c) credit spreads selling each snapped strike, every hedge width
    for side, strike in ((("CE", ce_strike), ("PE", pe_strike)) if have_safe else ()):
        try:
            spreads = spread_scanner.scan_vertical_spread(target, side, strike, expiry_ts)
        except Exception:
            continue
        spreads.sort(key=lambda s: s["premium_money"], reverse=True)
        for sp in spreads[:SPREAD_WIDTHS_PER_SIDE]:
            if sp["premium_money"] <= 0:
                continue
            legs = [
                {"symbol": sp["sell_symbol"], "side": "SELL", "price": sp["sell_bid"], "lot_size": sp["lot_size"]},
                {"symbol": sp["buy_symbol"], "side": "BUY", "price": sp["buy_ask"], "lot_size": sp["lot_size"]},
            ]
            priced = consider(legs, sp["premium_money"], sp["days_to_expiry"])
            if priced:
                out.append({"type": f"{side} Credit Spread", "underlying": target,
                            "expiry_date": exp_date, "days_to_expiry": sp["days_to_expiry"],
                            "ce_strike": sp["sell_strike"] if side == "CE" else None,
                            "pe_strike": sp["sell_strike"] if side == "PE" else None,
                            "buy_strike": sp["buy_strike"], "width": sp["width"],
                            "premium_money": sp["premium_money"], "lot_size": sp["lot_size"],
                            "real_margin": priced[0], "real_roi_pct": priced[1], "entry_legs": legs})

    # Lowest -> highest ROI within the filtered set (user preference)
    out.sort(key=lambda c: c["real_roi_pct"])
    if diag["cheapest_margin"] is not None:
        diag["cheapest_margin"] = round(diag["cheapest_margin"])
    if diag["best_roi_in_budget"] is not None:
        diag["best_roi_in_budget"] = round(diag["best_roi_in_budget"], 2)
    return {"roi_floor": roi_floor, "margin_budget": margin_budget, "target": target,
            "expiry_date": exp_date, "safe_ce_level": safe_ce_level, "safe_pe_level": safe_pe_level,
            "ce_strike": ce_strike, "pe_strike": pe_strike, "include_itm": include_itm,
            "have_safe": bool(have_safe), "roi_floor_overridden": roi_floor_override is not None,
            "ignore_margin": ignore_margin, "diag": diag, "candidates": out}


# ---- Sequential roll execution -------------------------------------------------------------

def start_roll(strategy: dict, entry_legs: list[dict], lots: int, broker: str,
               new_name: str, notes: str | None) -> str:
    job_id = uuid.uuid4().hex[:8]
    job = {
        "id": job_id, "strategy_id": strategy["id"], "old_name": strategy["name"],
        "phase": "EXITING", "detail": "placing limit exit orders at bid/ask",
        "entry_legs": entry_legs, "lots": lots, "broker": broker,
        "new_name": new_name, "notes": notes, "new_strategy_id": None,
        "started_at": time.time(), "error": None,
    }
    with _jobs_lock:
        _jobs[job_id] = job
    threading.Thread(target=_run_roll, args=(job,), daemon=True).start()
    return job_id


def _set(job, **kw):
    with _jobs_lock:
        job.update(kw)


def _run_roll(job):
    from routes.strategy import compute_strategies, execute_auto_exit, ExecuteRequest, Leg, \
        execute_strategy, execute_zerodha_strategy, execute_shoonya_strategy, _fetch_bid_ask
    try:
        s = next((x for x in compute_strategies() if x["id"] == job["strategy_id"]), None)
        if not s or s["status"] != "OPEN":
            raise RuntimeError("strategy not found or not open")
        result = execute_auto_exit(s)
        legs = result.get("legs", [])
        if not legs or not all(l.get("ok") for l in legs):
            raise RuntimeError("some exit orders were rejected — roll aborted, check the broker")
        placed_oids = {str(l.get("order_id")) for l in legs if l.get("order_id")}
        _set(job, detail=f"{len(legs)} exit orders resting — waiting for fills")

        import strategy_db as db
        deadline = time.time() + EXIT_FILL_TIMEOUT
        while time.time() < deadline:
            time.sleep(EXIT_POLL_INTERVAL)
            cur = next((x for x in compute_strategies() if x["id"] == job["strategy_id"]), None)
            if cur is None or cur["status"] != "OPEN" or all(l["qty"] == 0 for l in cur["legs"]):
                break
            # Early stall: if EVERY exit order we placed has left PENDING (filled short / cancelled /
            # rejected) yet the position still isn't flat, nothing more will fill — stall now instead
            # of burning the whole timeout while the UI says "waiting for fills".
            still_pending = {str(o["order_id"]) for o in db.list_orders(statuses=("PENDING",)) if o.get("order_id")}
            if placed_oids and not (placed_oids & still_pending):
                residual = sum(l["qty"] for l in cur["legs"])
                _set(job, phase="STALLED",
                     detail=f"exit orders resolved but {residual} qty still open (partial fill/rejected) — NO entry placed",
                     error="exit under-filled")
                events_db.add_event("roll", f"Roll STALLED: '{job['old_name']}' exits under-filled",
                                    f"{residual} qty still open after every exit order resolved (partial fill or "
                                    "rejection). No new strategy entered — clear the residual (re-exit the leg or "
                                    "modify/replace the order), then roll again.",
                                    dedupe_key=f"roll_understall:{job['id']}")
                return
        else:
            _set(job, phase="STALLED", detail="exit orders did not all fill in time — NO entry placed",
                 error="exit fill timeout")
            events_db.add_event("roll", f"Roll STALLED: '{job['old_name']}' exits not filled",
                                "Exit limit orders are still resting. No new strategy was entered — "
                                "manage the exits at the broker, then enter manually if still wanted.",
                                dedupe_key=f"roll_stall:{job['id']}")
            return

        _set(job, phase="ENTERING", detail="exits flat — placing new strategy at fresh bids")
        symbols = [l["symbol"] for l in job["entry_legs"]]
        fresh = _fetch_bid_ask(symbols)
        req_legs = []
        for l in job["entry_legs"]:
            q = fresh.get(l["symbol"], {})
            px = (q.get("bid") if l["side"] == "SELL" else q.get("ask")) or l["price"]
            req_legs.append(Leg(symbol=l["symbol"], side=l["side"], quantity=job["lots"] * l["lot_size"],
                                order_type="LMT", limit_price=px, product_type="MARGIN"))
        req = ExecuteRequest(legs=req_legs, strategy_name=job["new_name"],
                             notes=job["notes"] or f"Rolled from #{job['strategy_id']} ({job['old_name']})")
        fn = {"zerodha": execute_zerodha_strategy, "shoonya": execute_shoonya_strategy}.get(job["broker"], execute_strategy)
        res = fn(req)
        _set(job, phase="DONE", detail="roll complete", new_strategy_id=res.get("strategy_id"))
        events_db.add_event("roll", f"Roll complete: '{job['old_name']}' → '{job['new_name']}'",
                            f"New strategy #{res.get('strategy_id')} placed on {job['broker']}.",
                            dedupe_key=f"roll_done:{job['id']}")
    except Exception as e:
        _set(job, phase="FAILED", detail=str(e), error=str(e))
        events_db.add_event("roll", f"Roll FAILED: '{job['old_name']}'", str(e),
                            dedupe_key=f"roll_fail:{job['id']}")


def get_job(job_id: str) -> dict | None:
    with _jobs_lock:
        j = _jobs.get(job_id)
        return dict(j) if j else None
