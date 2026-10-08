import datetime
import math
import greeks
from fyers_client import client
from symbol_master import get_lot_size

# Composite-score weights (must sum to 1): return, time-decay efficiency, safety distance.
_W_ROI, _W_THETA, _W_DIST = 0.20, 0.40, 0.40

DEFAULT_UNDERLYINGS = ["NSE:NIFTY50-INDEX", "NSE:NIFTYBANK-INDEX", "NSE:FINNIFTY-INDEX"]


def _days_to_expiry(expiry_ts: int) -> int:
    """Whole calendar days from today to expiry date, inclusive (+1)."""
    expiry_date = datetime.datetime.fromtimestamp(int(expiry_ts)).date()
    today = datetime.date.today()
    return (expiry_date - today).days + 1


def _elm_rate(underlying: str, is_expiry_day: bool = False) -> float:
    """NSE Extreme Loss Margin: 2% of notional for index derivatives, 3.5% for stock
    derivatives. Source: nseclearing.in risk-management/equity-derivatives/margins.

    On an index option's EXPIRY DAY the exchange levies an additional 2% ELM on short index
    option contracts (even if hedged/intraday), effective 2024-11-20 — so a short index option
    expiring today is 4%, not 2%. Both strangle legs here are short, so the bump applies.
    Kept in sync with the frontend's elmRateFor (spanUtils.js)."""
    is_index = underlying.endswith("-INDEX")
    base = 0.02 if is_index else 0.035
    return base + (0.02 if is_index and is_expiry_day else 0.0)


def _snap_to_strike(value: float, strikes: list[float]) -> float | None:
    """Nearest available strike to a free-typed figure (e.g. 23588 -> 23600), so the 'safe' bound
    need not be an exact strike."""
    return min(strikes, key=lambda s: abs(s - value)) if strikes else None


def scan(target_roi_pct: float, underlyings: list[str] = None, max_expiries: int = 3,
         product_type: str = "INTRADAY", strike_count: int = 20, include_itm: bool = False,
         expiry_index: int | None = None, safe_ce: float | None = None,
         safe_pe: float | None = None, limit: int = 40) -> list[dict]:
    """Short strangle scanner. ROI here is an ELM-only estimate (no margin API call) —
    both legs are short so both attract ELM, with no hedge to offset against. This is a LOWER bound
    on true required margin, so ELM-ROI is an UPPER bound on real ROI: every combo that would clear
    the target on real Zerodha margin also clears it here, which makes the ELM target_roi a safe
    (permissive) coarse pre-filter. The frontend then pulls each returned combo's REAL Zerodha basket
    margin and recomputes ROI + Score from it — so `limit` caps the result to the top-N by ELM-score
    to keep that per-combo margin fan-out bounded."""
    underlyings = underlyings or DEFAULT_UNDERLYINGS
    candidates = []

    for underlying in underlyings:
        try:
            base_chain = client.get_option_chain(underlying, strike_count=strike_count, timestamp="")
        except Exception:
            continue
        if not base_chain or base_chain.get("s") != "ok":
            continue

        all_expiries = base_chain["data"].get("expiryData", [])
        if expiry_index is not None:
            # Scan ONLY the one selected expiry — not every expiry up to it.
            expiries = [all_expiries[expiry_index]] if 0 <= expiry_index < len(all_expiries) else []
        else:
            expiries = all_expiries[:max_expiries]

        for exp in expiries:
            expiry_ts = int(exp["expiry"])
            days = _days_to_expiry(expiry_ts)
            if days < 1:
                continue

            # days == 1 means the expiry date is today — bump ELM by the additional index-expiry 2%.
            elm_rate = _elm_rate(underlying, is_expiry_day=days == 1)

            chain_resp = client.get_option_chain(underlying, strike_count=strike_count, timestamp=str(expiry_ts))
            if not chain_resp or chain_resp.get("s") != "ok":
                continue
            data = chain_resp["data"]
            underlying_row = next((o for o in data["optionsChain"] if o["option_type"] == ""), None)
            if not underlying_row:
                continue
            spot = underlying_row["ltp"]

            strikes = [o for o in data["optionsChain"] if o["option_type"] != ""]
            by_strike = {}
            for row in strikes:
                by_strike.setdefault(row["strike_price"], {})[row["option_type"]] = row

            # OTM+ATM only by default; include_itm relaxes to every listed strike on each side.
            ce_candidates = [s for s, d in by_strike.items() if "CE" in d and (include_itm or s >= spot)]
            pe_candidates = [s for s, d in by_strike.items() if "PE" in d and (include_itm or s <= spot)]

            # "Safe" bounds (optional): keep only CE strikes at/above safe_ce and PE strikes at/below
            # safe_pe. The typed figure is snapped to the nearest available strike this expiry, so a
            # loose number (23588) resolves to a real strike (23600). A bound on one side leaves the
            # other side unrestricted (all CE / all PE), matching the requested behaviour.
            if safe_ce is not None:
                snapped = _snap_to_strike(safe_ce, [s for s, d in by_strike.items() if "CE" in d])
                if snapped is not None:
                    ce_candidates = [s for s in ce_candidates if s >= snapped]
            if safe_pe is not None:
                snapped = _snap_to_strike(safe_pe, [s for s, d in by_strike.items() if "PE" in d])
                if snapped is not None:
                    pe_candidates = [s for s in pe_candidates if s <= snapped]

            if not ce_candidates or not pe_candidates:
                continue

            atm_strike = min(by_strike.keys(), key=lambda s: abs(s - spot))
            atm_ce = by_strike.get(atm_strike, {}).get("CE")
            if not atm_ce:
                continue
            lot_size = get_lot_size(atm_ce["symbol"])

            # Both legs are short (no hedge), so ELM applies to each leg individually.
            elm_estimate = spot * lot_size * elm_rate * 2
            if not elm_estimate:
                continue

            # Per-strike (iv, short-theta income/day), solved once from each leg's bid and cached —
            # both depend only on the strike, not the CE+PE pairing. iv feeds the σ-distance below.
            g_ce = {s: greeks.short_theta_income(by_strike[s]["CE"].get("bid") or 0, spot, s, days, True)
                    for s in ce_candidates}
            g_pe = {s: greeks.short_theta_income(by_strike[s]["PE"].get("bid") or 0, spot, s, days, False)
                    for s in pe_candidates}
            sqrtT = math.sqrt(days / 365.0)

            for ce_strike in ce_candidates:
                ce = by_strike[ce_strike]["CE"]
                for pe_strike in pe_candidates:
                    pe = by_strike[pe_strike]["PE"]
                    ce_bid = ce.get("bid") or 0
                    pe_bid = pe.get("bid") or 0
                    if ce_bid <= 0 or pe_bid <= 0:
                        continue  # no real bid to sell into
                    premium_total = ce_bid + pe_bid
                    money = premium_total * lot_size
                    roi_pct = (money / elm_estimate) * (365 / days) * 100
                    if roi_pct < target_roi_pct:
                        continue

                    # Theta%: combined daily decay income as % of premium collected (both legs short).
                    iv_ce, tc = g_ce.get(ce_strike, (None, None))
                    iv_pe, tp = g_pe.get(pe_strike, (None, None))
                    theta_total = (tc or 0) + (tp or 0)  # premium points/day earned
                    theta_pct = round(theta_total / premium_total * 100, 2) if premium_total else None
                    theta_money = round(theta_total * lot_size, 2)

                    # Distance from ATM: each leg's gap from spot as % of spot; the NEAREST side is
                    # the most-at-risk breach point, so that's the safety figure shown.
                    ce_dist = (ce_strike - spot) / spot * 100
                    pe_dist = (spot - pe_strike) / spot * 100
                    dist_atm = round(min(ce_dist, pe_dist), 2)

                    # σ-distance: how many standard deviations OTM the NEAREST leg sits, using that
                    # leg's IV and √time. This is what the Score ranks on, so 3.5% at 7 DTE (few days
                    # to travel) correctly beats 3.5% at 30 DTE. 1σ move ≈ IV·√(days/365) of spot.
                    near_iv = iv_ce if ce_dist <= pe_dist else iv_pe
                    dist_sigma = round((min(ce_dist, pe_dist) / 100.0) / (near_iv * sqrtT), 2) \
                        if (near_iv and sqrtT > 0) else None

                    candidates.append({
                        "underlying": underlying,
                        "expiry_date": exp["date"],
                        "expiry_ts": expiry_ts,
                        "days_to_expiry": days,
                        "ce_symbol": ce["symbol"],
                        "ce_strike": ce_strike,
                        "ce_bid": ce_bid,
                        "pe_symbol": pe["symbol"],
                        "pe_strike": pe_strike,
                        "pe_bid": pe_bid,
                        "lot_size": lot_size,
                        "premium_total": round(premium_total, 2),
                        "premium_money": round(money, 2),
                        "elm_estimate": round(elm_estimate, 2),
                        "roi_pct": round(roi_pct, 2),
                        "theta_pct": theta_pct,
                        "theta_money": theta_money,
                        "ce_dist_pct": round(ce_dist, 2),
                        "pe_dist_pct": round(pe_dist, 2),
                        "dist_atm_pct": dist_atm,
                        "dist_sigma": dist_sigma,
                        "spot": spot,
                    })

    _add_scores(candidates)
    candidates.sort(key=lambda c: (c.get("score") is not None, c.get("score", 0)), reverse=True)
    return candidates[:limit] if limit and limit > 0 else candidates


def _percentile(sorted_vals: list[float], p: float) -> float:
    """Linear-interpolated percentile (p in 0..1) of an already-sorted list."""
    if not sorted_vals:
        return 0.0
    if len(sorted_vals) == 1:
        return sorted_vals[0]
    idx = p * (len(sorted_vals) - 1)
    lo = int(idx)
    frac = idx - lo
    hi = min(lo + 1, len(sorted_vals) - 1)
    return sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * frac


def _add_scores(candidates: list[dict]) -> None:
    """Attach a 0-100 composite Score to each combo, weighting ROI%, Theta%, and distance-from-ATM.

    Each metric is WINSORIZED to its 5th–95th percentile before min-max scaling. This matters most
    across expiries: a near-ATM short-dated combo can post an absurd annualized ROI (e.g. 1500%+ from
    the 365/few-days multiplier), and with plain min-max that single outlier would stretch the ROI
    scale so every balanced combo normalizes near 0 and the reckless one wins. Clipping the tails lets
    a safer, high-decay combo with moderate ROI actually out-score an ATM lottery ticket — which is
    the whole point of ranking on ROI AND theta AND safety together."""
    if not candidates:
        return

    def _norm(key):
        vals = sorted(c[key] for c in candidates if c.get(key) is not None)
        if not vals:
            return lambda c: 0.0
        lo, hi = _percentile(vals, 0.05), _percentile(vals, 0.95)
        span = hi - lo

        def f(c):
            v = c.get(key)
            if v is None or span <= 0:
                return 0.0
            return max(0.0, min(1.0, (v - lo) / span))  # clip to [0,1] at the winsorized bounds
        return f

    # Distance term ranks on σ-distance (time-adjusted) — see dist_sigma in scan(). This is why a
    # near-dated combo at the same raw % distance scores safer than a longer-dated one.
    n_roi, n_theta, n_dist = _norm("roi_pct"), _norm("theta_pct"), _norm("dist_sigma")
    for c in candidates:
        c["score"] = round(100 * (_W_ROI * n_roi(c) + _W_THETA * n_theta(c) + _W_DIST * n_dist(c)), 1)
