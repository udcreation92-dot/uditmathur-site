import threading
import time
from fyers_client import client
from symbol_master import list_fo_underlyings

# Per-underlying cache for the strategy-card volatility badge: computing one ratio is a single
# option-chain fetch, so we serve a cached value for a short window rather than hitting Fyers on
# every card poll (and letting several cards share one fetch).
_SINGLE_TTL = 120  # seconds
_single_cache: dict[str, tuple[float, dict | None]] = {}
_single_lock = threading.Lock()

# Fyers' option-chain endpoint rate-limits well below what a burst of ~200 calls needs —
# even sequential calls a fraction of a second apart return "request limit reached".
# Pace requests and retry once on a rate-limit hit rather than dropping the underlying.
REQUEST_DELAY = 0.75
RATE_LIMIT_RETRY_DELAY = 3.0


def _fetch_chain(symbol: str, strike_count: int):
    for attempt in range(2):
        try:
            resp = client.get_option_chain(symbol, strike_count=strike_count, timestamp="")
        except Exception:
            return None
        if resp and resp.get("s") == "ok":
            return resp
        if resp and "request limit" in (resp.get("message") or "").lower() and attempt == 0:
            time.sleep(RATE_LIMIT_RETRY_DELAY)
            continue
        return None
    return None


def _scan_one(underlying: dict, strike_count: int) -> dict | None:
    resp = _fetch_chain(underlying["symbol"], strike_count)
    if not resp:
        return None
    data = resp["data"]
    chain = data.get("optionsChain", [])
    spot_row = next((o for o in chain if o["option_type"] == ""), None)
    if not spot_row:
        return None
    spot = spot_row["ltp"]

    ce_total_oi = ce_itm_oi = pe_total_oi = pe_itm_oi = 0
    for row in chain:
        oi = row.get("oi") or 0
        if row["option_type"] == "CE":
            ce_total_oi += oi
            if row["strike_price"] < spot:  # call is ITM below spot
                ce_itm_oi += oi
        elif row["option_type"] == "PE":
            pe_total_oi += oi
            if row["strike_price"] > spot:  # put is ITM above spot
                pe_itm_oi += oi

    if ce_total_oi == 0 or pe_total_oi == 0:
        return None

    ce_ratio = ce_itm_oi / ce_total_oi
    pe_ratio = pe_itm_oi / pe_total_oi
    volatility_ratio = max(ce_ratio, pe_ratio)

    expiry = next((e for e in data.get("expiryData", [])), None)

    return {
        "root": underlying["root"],
        "symbol": underlying["symbol"],
        "is_index": underlying["is_index"],
        "spot": spot,
        "expiry_date": expiry["date"] if expiry else None,
        "ce_itm_oi": ce_itm_oi,
        "ce_total_oi": ce_total_oi,
        "ce_ratio": round(ce_ratio * 100, 2),
        "pe_itm_oi": pe_itm_oi,
        "pe_total_oi": pe_total_oi,
        "pe_ratio": round(pe_ratio * 100, 2),
        "volatility_ratio": round(volatility_ratio * 100, 2),
    }


def _find_underlying(root: str) -> dict | None:
    r = (root or "").upper()
    for u in list_fo_underlyings():
        if u["root"].upper() == r:
            return u
    return None


def volatility_for_root(root: str, strike_count: int = 20) -> dict | None:
    """Volatility ratio for a SINGLE F&O underlying (by root, e.g. 'NIFTY', 'LODHA') — one option-
    chain fetch, short-TTL cached. Returns None if the root isn't an F&O underlying or no chain
    data is available. Used by the per-strategy card badge."""
    key = (root or "").upper()
    if not key:
        return None
    now = time.time()
    with _single_lock:
        hit = _single_cache.get(key)
        if hit and now - hit[0] < _SINGLE_TTL:
            return hit[1]
    underlying = _find_underlying(key)
    result = _scan_one(underlying, strike_count) if underlying else None
    with _single_lock:
        _single_cache[key] = (now, result)
    return result


def scan_fo_volatility(strike_count: int = 20, on_progress=None) -> list[dict]:
    """Ranks every F&O underlying by how much of its option OI sits in-the-money, on the
    nearest expiry — volatility_ratio = max of (ITM CE OI / total CE OI) and
    (ITM PE OI / total PE OI). Sequential + paced (~200 underlyings x ~0.75s+ each, so a
    couple of minutes) since Fyers rate-limits option-chain well below what concurrency
    would need. `on_progress(done, total)` is called after each underlying if given."""
    underlyings = list_fo_underlyings()
    total = len(underlyings)
    results = []
    for i, u in enumerate(underlyings, start=1):
        r = _scan_one(u, strike_count)
        if r is not None:
            results.append(r)
        if on_progress:
            on_progress(i, total)
        time.sleep(REQUEST_DELAY)

    results.sort(key=lambda r: r["volatility_ratio"], reverse=True)
    return results
