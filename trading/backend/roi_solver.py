"""
ROI-target option-selling solver (Phase 2 of the trading AI overhaul) — the deterministic engine
behind "put ₹6L at 20% in Nifty".

Given a capital amount and a TARGET ANNUALIZED ROI, it finds the short-strangle (sell CE + sell PE,
symmetric distance from ATM) whose ROI matches the target, sizes the lots to deploy the capital, and
returns a small ladder of nearby candidates so the caller can also judge by distance-from-ATM.

Definitions (matches the user's basis):
    ROI% (annualized) = (premium_collected ÷ margin_blocked) × (365 ÷ days_to_expiry) × 100
    - premium_collected = (CE bid + PE bid) × lot_size   (bid = the price you actually sell into)
    - margin_blocked    = REAL Zerodha basket margin for the short strangle (SPAN+exposure, netted)
      — the consistent yardstick even if execution is on another broker (Shoonya's SPAN differs;
      size actual lots against the execution broker before firing — handled at the order stage).

Market data (chain/spot/expiries) comes from Fyers; margin from Zerodha. Pure calculation — no LLM,
no orders. Used by an MCP tool and (later) a dashboard button.
"""
import datetime

from fyers_client import client as fyers
from zerodha_client import client as zclient
from symbol_master import get_lot_size

DEFAULT_UNDERLYING = "NSE:NIFTY50-INDEX"
_STRIKE_WINDOW = 50     # strikes each side to pull from the chain
_COARSE_STEP = 3        # coarse probe stride (in strikes) when bracketing the target ROI

# Brokerage: FLAT ₹ per option order (each leg is its own order), independent of lots/qty.
# A short strangle = 2 orders to enter (sell CE + sell PE). ROI is reported NET of this.
# Only brokerage is modelled here (not STT/exchange/GST/stamp). Override via env if it changes.
import os as _os
BROKERAGE_PER_ORDER = float(_os.environ.get("BROKERAGE_PER_ORDER", "6"))
_ENTRY_ORDERS = 2       # CE + PE


class RoiSolverError(RuntimeError):
    pass


def _days_to_expiry(expiry_ts: int) -> int:
    expiry_date = datetime.datetime.fromtimestamp(int(expiry_ts)).date()
    return (expiry_date - datetime.date.today()).days + 1


def _zerodha_strangle_margin_per_lot(ce_symbol: str, pe_symbol: str, lot_size: int) -> float:
    """Real Zerodha basket margin to SELL 1 lot CE + 1 lot PE. Fyers body == Zerodha NFO
    tradingsymbol (same convention as strategy._to_zerodha_leg). Returns net (hedge-benefited) total."""
    orders = [{
        "exchange": "NFO", "tradingsymbol": sym.split(":")[-1], "transaction_type": "SELL",
        "variety": "regular", "product": "NRML", "order_type": "MARKET",
        "quantity": lot_size, "price": 0, "trigger_price": 0,
    } for sym in (ce_symbol, pe_symbol)]
    result = zclient.get_basket_margins(orders) or {}
    final = result.get("final") or {}
    total = final.get("total")
    if total is None:
        raise RoiSolverError(f"Zerodha basket margin returned no total: {result}")
    return float(total)


def _load_chain(underlying: str, expiry_index: int):
    """Returns (expiry_row, days, spot, by_strike, lot_size, strikes_sorted, step)."""
    base = fyers.get_option_chain(underlying, strike_count=_STRIKE_WINDOW, timestamp="")
    if not base or base.get("s") != "ok":
        raise RoiSolverError(f"option chain unavailable (is Fyers logged in?): {base}")
    expiries = base["data"].get("expiryData", [])
    if not expiries:
        raise RoiSolverError("no expiries returned for underlying")
    if not (0 <= expiry_index < len(expiries)):
        raise RoiSolverError(f"expiry_index {expiry_index} out of range (0..{len(expiries)-1})")
    exp = expiries[expiry_index]
    expiry_ts = int(exp["expiry"])
    days = _days_to_expiry(expiry_ts)
    if days < 1:
        raise RoiSolverError("selected expiry is in the past")

    chain = fyers.get_option_chain(underlying, strike_count=_STRIKE_WINDOW, timestamp=str(expiry_ts))
    if not chain or chain.get("s") != "ok":
        raise RoiSolverError(f"option chain for expiry unavailable: {chain}")
    data = chain["data"]
    underlying_row = next((o for o in data["optionsChain"] if o["option_type"] == ""), None)
    if not underlying_row:
        raise RoiSolverError("no underlying/spot row in chain")
    spot = underlying_row["ltp"]

    by_strike: dict[float, dict] = {}
    for row in data["optionsChain"]:
        if row["option_type"] in ("CE", "PE"):
            by_strike.setdefault(row["strike_price"], {})[row["option_type"]] = row
    strikes_sorted = sorted(by_strike)
    if len(strikes_sorted) < 3:
        raise RoiSolverError("not enough strikes in chain")
    step = min(b - a for a, b in zip(strikes_sorted, strikes_sorted[1:]))
    atm_strike = min(strikes_sorted, key=lambda s: abs(s - spot))
    lot_size = get_lot_size(by_strike[atm_strike].get("CE", {}).get("symbol")
                            or by_strike[atm_strike].get("PE", {}).get("symbol"))
    return exp, days, spot, by_strike, lot_size, strikes_sorted, step, atm_strike


def _bid(row: dict) -> float:
    return float(row.get("bid") or row.get("ltp") or 0)


def _evaluate_rung(by_strike, atm, step, spot, lot_size, days, capital, d) -> dict | None:
    """One symmetric rung d strikes out (sell ATM+d CE, ATM-d PE). One Zerodha margin call.
    Returns None if either leg is missing / has no bid / margin is unavailable."""
    ce = by_strike.get(atm + d * step, {}).get("CE")
    pe = by_strike.get(atm - d * step, {}).get("PE")
    if not ce or not pe:
        return None
    ce_bid, pe_bid = _bid(ce), _bid(pe)
    if ce_bid <= 0 or pe_bid <= 0:
        return None
    premium_per_lot = (ce_bid + pe_bid) * lot_size
    try:
        margin_per_lot = _zerodha_strangle_margin_per_lot(ce["symbol"], pe["symbol"], lot_size)
    except RoiSolverError:
        return None
    if margin_per_lot <= 0:
        return None
    roi_abs = premium_per_lot / margin_per_lot * 100            # GROSS per-cycle (life of the trade)
    roi_ann = roi_abs * (365 / days)                            # GROSS annualized
    lots = int(capital // margin_per_lot)
    # Brokerage is a FLAT cost for the whole position (₹6 × 2 legs to enter), not per-lot — so the
    # net ROI is computed on totals. eff_lots (>=1) keeps it defined even when capital < 1 lot.
    brokerage = BROKERAGE_PER_ORDER * _ENTRY_ORDERS
    eff_lots = max(lots, 1)
    net_prem = eff_lots * premium_per_lot - brokerage
    net_roi_abs = net_prem / (eff_lots * margin_per_lot) * 100
    net_roi_ann = net_roi_abs * (365 / days)
    return {
        "distance_strikes": d,
        "distance_pct": round((ce["strike_price"] - spot) / spot * 100, 2),
        "ce_strike": ce["strike_price"], "ce_symbol": ce["symbol"], "ce_bid": ce_bid,
        "pe_strike": pe["strike_price"], "pe_symbol": pe["symbol"], "pe_bid": pe_bid,
        "ce_oi": ce.get("oi"), "pe_oi": pe.get("oi"),
        "premium_per_lot": round(premium_per_lot, 2),
        "margin_per_lot": round(margin_per_lot, 2),
        "roi_annual_pct": round(roi_ann, 2),           # gross (before brokerage)
        "roi_absolute_pct": round(roi_abs, 2),         # gross
        "net_roi_annual_pct": round(net_roi_ann, 2),   # after ₹ brokerage
        "net_roi_absolute_pct": round(net_roi_abs, 2), # after ₹ brokerage
        "lots": lots,
        "brokerage": round(brokerage, 2),
        "total_premium": round(lots * premium_per_lot, 2),           # gross premium collected
        "net_premium": round(lots * premium_per_lot - brokerage, 2), # after brokerage
        "total_margin": round(lots * margin_per_lot, 2),
    }


def solve(capital: float, target_roi_pct: float, underlying: str = DEFAULT_UNDERLYING,
          expiry_index: int = 0, roi_basis: str = "annualized") -> dict:
    """Find the symmetric short strangle near `target_roi_pct` and size lots to `capital`.

    roi_basis: "annualized" (premium/margin × 365/DTE — use for weekly/monthly) or "absolute"
    (premium/margin for the trade's life — use for same-day / expiry-day, where annualizing by
    ÷1 day is meaningless). Every rung reports BOTH; the target is matched on the chosen basis.

    ROI falls monotonically as strikes go further OTM, so we coarse-probe outward to bracket the
    target, then fine-scan that neighbourhood — reaching far-OTM targets with bounded margin calls."""
    if capital <= 0:
        raise RoiSolverError("capital must be > 0")
    if target_roi_pct <= 0:
        raise RoiSolverError("target_roi_pct must be > 0")
    if roi_basis not in ("annualized", "absolute"):
        raise RoiSolverError("roi_basis must be 'annualized' or 'absolute'")
    # Target on the NET (after-brokerage) ROI so "20%" is a real, brokerage-adjusted figure.
    roi_key = "net_roi_annual_pct" if roi_basis == "annualized" else "net_roi_absolute_pct"

    exp, days, spot, by_strike, lot_size, strikes, step, atm = _load_chain(underlying, expiry_index)
    max_d = min(int((max(strikes) - atm) / step), int((atm - min(strikes)) / step))
    if max_d < 1:
        raise RoiSolverError("not enough OTM strikes around ATM")

    cache: dict[int, dict | None] = {}

    def ev(d):
        if d not in cache:
            cache[d] = _evaluate_rung(by_strike, atm, step, spot, lot_size, days, capital, d)
        return cache[d]

    # Coarse probe outward until ROI drops to/below target (brackets it), or strikes run out.
    bracket = None
    d = 1
    while d <= max_d:
        r = ev(d)
        if r and r[roi_key] <= target_roi_pct:
            bracket = d
            break
        d += _COARSE_STEP
    target_reached = bracket is not None

    # Fine-scan the neighbourhood so the ladder is dense around the decision point.
    if target_reached:
        for dd in range(max(1, bracket - _COARSE_STEP), min(max_d, bracket + 1) + 1):
            ev(dd)

    ladder = [cache[k] for k in sorted(cache) if cache[k]]
    if not ladder:
        raise RoiSolverError("no sellable strangle found (thin bids or margin unavailable)")

    best = min(ladder, key=lambda r: abs(r[roi_key] - target_roi_pct))
    for r in ladder:
        r["is_target"] = (r is best)

    notes = []
    if not target_reached:
        notes.append(f"target {target_roi_pct}% ({roi_basis}) not reachable within the listed "
                     f"strikes — the deepest OTM rung ({best[roi_key]}%) is the closest.")
    if best["lots"] < 1:
        notes.append(f"₹{capital:,.0f} is below one lot's margin (₹{best['margin_per_lot']:,.0f}) "
                     f"at the target strike — increase capital or move the target closer to ATM.")
    if roi_basis == "annualized" and days <= 2:
        notes.append(f"only {days} day(s) to expiry — annualized ROI (×{round(365/days)}) is very "
                     f"sensitive here; for same-day trades use roi_basis='absolute' instead.")

    return {
        "underlying": underlying,
        "spot": spot,
        "atm_strike": atm,
        "expiry_date": exp["date"],
        "days_to_expiry": days,
        "lot_size": lot_size,
        "target_roi_pct": target_roi_pct,
        "roi_basis": roi_basis,
        "roi_is_net_of_brokerage": True,
        "brokerage_per_order": BROKERAGE_PER_ORDER,
        "entry_brokerage": round(BROKERAGE_PER_ORDER * _ENTRY_ORDERS, 2),
        "target_reached": target_reached,
        "capital": capital,
        "best": best,
        "ladder": ladder,
        "note": " ".join(notes) or None,
        "disclaimer": "The target ROI (net_roi_*) is NET of ₹%g brokerage per order (₹%g to enter the "
                      "strangle: sell CE + sell PE); gross roi_* is before brokerage. Only brokerage is "
                      "modelled — STT/exchange/GST/stamp and any exit brokerage are not. ROI uses Zerodha "
                      "basket margin; if executing elsewhere re-check that broker's margin. Premiums are "
                      "current bids." % (BROKERAGE_PER_ORDER, BROKERAGE_PER_ORDER * _ENTRY_ORDERS),
    }
