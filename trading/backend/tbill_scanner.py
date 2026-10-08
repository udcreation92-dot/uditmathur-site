import time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from fyers_client import client
from symbol_master import list_tbills as _list_tbills_raw

DEPTH_LIMIT = 20  # depth is one API call per symbol; only fetch it for the top-ROI rows

_TBILLS_CACHE = {"ts": 0.0, "data": None}   # the T-Bill universe doesn't change intraday


def list_tbills():
    """Cached T-Bill universe — the raw call iterates the whole symbol master with a regex, which is
    wasteful to repeat every 5s watcher cycle. Refresh hourly."""
    if _TBILLS_CACHE["data"] is None or time.time() - _TBILLS_CACHE["ts"] > 3600:
        _TBILLS_CACHE["data"] = _list_tbills_raw()
        _TBILLS_CACHE["ts"] = time.time()
    return _TBILLS_CACHE["data"]


def ask_qty_depth(symbol: str):
    """Top-of-book ask size via one Fyers depth call — used by the auto-buy watcher to size a bill
    it's about to buy when the stream didn't have the ask_qty. One call, only for buy candidates."""
    try:
        d = client.get_depth(symbol)
        levels = (d or {}).get("d", {}).get(symbol, {}).get("ask") or []
        return levels[0]["volume"] if levels else None
    except Exception:
        return None


def fresh_quote(symbol: str) -> dict | None:
    """One live REST quote + depth for a single bill — {ask, bid, lp, ask_qty}. Used to VERIFY a
    bill's live price/liquidity right before the auto-buy places a real order, so a stale cached
    snapshot can never drive a bad fill. None if unquotable."""
    try:
        resp = client.get_quotes(symbol)
        if not resp or resp.get("s") != "ok":
            return None
        v = (resp.get("d") or [{}])[0].get("v", {})
        ask = v.get("ask")
        if not ask or ask <= 0:
            return None
        return {"ask": ask, "bid": v.get("bid"), "lp": v.get("lp"), "ask_qty": ask_qty_depth(symbol)}
    except Exception:
        return None


def scan_traded_yields() -> list[dict]:
    """Market-traded yields: for every T-Bill that has TRADED today (volume > 0), the effective
    annualized ROI implied by its LAST TRADED PRICE (not the ask). Sorted best-yield first. This is
    a monitor of where the market is actually dealing — and a way to spot a bill that traded above
    your target yet your order didn't trigger (or triggered late). REST-quoted (called ~every 5 min).
    ROI% = (100 - ltp) / ltp * (365 / days_to_maturity) * 100.
    """
    candidates = list_tbills()
    if not candidates:
        return []
    today = date.today()
    symbols = [c["symbol"] for c in candidates]
    quote_map = {}
    for i in range(0, len(symbols), 50):
        chunk = symbols[i:i + 50]
        try:
            resp = client.get_quotes(",".join(chunk))
        except Exception:
            continue
        if resp and resp.get("s") == "ok":
            for item in resp.get("d", []):
                if item.get("s") == "ok":
                    quote_map[item["n"]] = item.get("v", {})

    out = []
    for c in candidates:
        v = quote_map.get(c["symbol"])
        if not v:
            continue
        ltp = v.get("lp") or 0
        volume = v.get("volume") or v.get("vol_traded_today") or 0
        if ltp <= 0 or volume <= 0:            # only bills that actually traded today
            continue
        days = (date.fromisoformat(c["maturity_date"]) - today).days
        if days <= 0:
            continue
        roi_pct = (100 - ltp) / ltp * (365 / days) * 100
        out.append({
            "symbol": c["symbol"],
            "desc": c.get("desc"),
            "maturity_date": c["maturity_date"],
            "days_to_maturity": days,
            "ltp": ltp,
            "volume": int(volume),
            "roi_pct": round(roi_pct, 2),
        })
    out.sort(key=lambda r: r["roi_pct"], reverse=True)
    return out


def scan_tbills(with_depth: bool = True, max_stale: float = 300, rest_fallback: bool = True) -> list[dict]:
    """Live-quoted GOI T-Bills ranked by annualized ROI (best first).

    T-Bills are zero-coupon: bought at a discount to face value (100) and
    redeemed at 100 on maturity. ROI% = (100 - ask) / ask * (365 / days_to_maturity) * 100.

    with_depth=True (UI) fills top-of-book ask_qty for the top rows, using a depth call only for
    rows the socket didn't cover. with_depth=False (the auto-buy watcher) skips ALL depth calls —
    ask_qty comes from the stream when available, else None — so the scan is fast enough to run on a
    tight interval; the watcher then depth-checks only the few bills it's actually about to buy.
    """
    candidates = list_tbills()
    if not candidates:
        return []

    today = date.today()
    symbols = [c["symbol"] for c in candidates]

    # Stream-first: keep the T-Bills on the Fyers WebSocket and read ask/bid/ltp AND top-of-book
    # ask_size straight from the cache (instant). The stream's ask_size is exactly the ask_qty we
    # used to make a separate per-symbol depth call for — so streamed rows need NO depth call at all.
    # T-Bills tick rarely, so allow a generous staleness window (their prices barely move); anything
    # not fresh in the cache falls back to a batched REST quote.
    quote_map = {}   # symbol -> {"ask","bid","lp", optional "ask_qty"}
    try:
        import fyers_ws
        fyers_ws.subscribe(symbols)
        # T-Bills tick rarely, but they're near-cash instruments whose price barely moves — so a
        # cached quote that's minutes old is almost always still the live price (no tick BECAUSE
        # nothing changed). A 5-min window keeps the whole board served from the socket (quotes +
        # ask_size), so the scan does no depth calls and stays fast. The buy is a protective LIMIT
        # at that ask, so even a slightly stale price can't produce a bad fill.
        for s, q in fyers_ws.fresh_quotes(symbols, max_age=max_stale).items():
            if q.get("ask") is not None:
                quote_map[s] = {"ask": q.get("ask"), "bid": q.get("bid"),
                                "lp": q.get("ltp"), "ask_qty": q.get("ask_qty")}
    except Exception:
        pass
    # rest_fallback=False (the watcher's fast 5s cycle) skips REST entirely — a pure-cache scan is
    # instant. Bills not cached with an ask can't be bought anyway; the 30s full-refresh cycle
    # (rest_fallback=True, max_stale=0) REST-fetches the whole board to catch any that gained an ask.
    misses = [s for s in symbols if s not in quote_map] if rest_fallback else []
    for i in range(0, len(misses), 50):
        chunk = misses[i:i + 50]
        try:
            resp = client.get_quotes(",".join(chunk))
        except Exception:
            continue
        if resp and resp.get("s") == "ok":
            for item in resp.get("d", []):
                if item.get("s") == "ok":
                    v = item.get("v", {})
                    quote_map[item["n"]] = {"ask": v.get("ask"), "bid": v.get("bid"), "lp": v.get("lp")}

    live = []
    for c in candidates:
        v = quote_map.get(c["symbol"])
        if not v:
            continue
        ask = v.get("ask") or 0
        if ask <= 0:
            continue
        days_to_maturity = (date.fromisoformat(c["maturity_date"]) - today).days
        if days_to_maturity <= 0:
            continue
        roi_pct = (100 - ask) / ask * (365 / days_to_maturity) * 100
        live.append({
            **c,
            "ask": ask,
            "bid": v.get("bid") or 0,
            "ltp": v.get("lp") or 0,
            "days_to_maturity": days_to_maturity,
            "roi_pct": round(roi_pct, 2),
            "_stream_ask_qty": v.get("ask_qty"),
        })

    live.sort(key=lambda r: r["roi_pct"], reverse=True)

    def _ask_qty(symbol: str):
        try:
            d = client.get_depth(symbol)
            levels = (d or {}).get("d", {}).get(symbol, {}).get("ask") or []
            return levels[0]["volume"] if levels else None
        except Exception:
            return None

    # ask_qty for the top rows: use the streamed ask_size when we have it; only fall back to a depth
    # call for the few top rows that weren't streaming (usually none) — no more 20 serial depth calls.
    top = live[:DEPTH_LIMIT]
    need_depth = [r for r in top if r.get("_stream_ask_qty") is None]
    depth_qty = {}
    if with_depth and need_depth:
        with ThreadPoolExecutor(max_workers=5) as pool:
            for r, q in zip(need_depth, pool.map(_ask_qty, [r["symbol"] for r in need_depth])):
                depth_qty[r["symbol"]] = q
    for r in top:
        sq = r.get("_stream_ask_qty")
        r["ask_qty"] = sq if sq is not None else depth_qty.get(r["symbol"])
    for r in live[DEPTH_LIMIT:]:
        r["ask_qty"] = None
    for r in live:
        r.pop("_stream_ask_qty", None)

    return live
