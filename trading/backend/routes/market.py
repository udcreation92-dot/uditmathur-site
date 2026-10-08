from typing import Optional
from fastapi import APIRouter, HTTPException
from fyers_client import client
from symbol_master import search as search_symbols, get_lot_size
from tbill_scanner import scan_tbills, scan_traded_yields
import tbill_purchases
import holding_lots
import holding_targets_db
import shoonya_symbols
import volatility_watcher
import volatility_scanner

router = APIRouter(prefix="/market", tags=["market"])

@router.get("/search")
def search_scrip(q: str, segment: Optional[str] = None, limit: int = 20):
    if len(q) < 1:
        raise HTTPException(400, "Query too short")
    return search_symbols(q, limit=limit, segment=segment)

@router.get("/quote")
def get_quote(symbol: str):
    """symbol format: NSE:RELIANCE-EQ, NSE:NIFTY50-INDEX etc. Served from the live WebSocket cache
    when the symbol is streaming fresh (instant); otherwise a Fyers REST quote. Either way the
    symbol is subscribed so repeat polls (LivePrice, builder) come straight off the socket."""
    try:
        import fyers_ws
        fyers_ws.subscribe([symbol])
        cached = fyers_ws.quote_shaped(symbol)
        if cached:
            return cached
    except Exception:
        pass
    result = client.get_quotes(symbol)
    if not result or result.get("s") != "ok":
        raise HTTPException(404, "Symbol not found")
    return result

@router.get("/candles")
def get_candles(symbol: str, resolution: str = "5", range_from: str = "", range_to: str = ""):
    result = client.get_candles(symbol, resolution, range_from, range_to)
    if not result or result.get("s") != "ok":
        raise HTTPException(404, "No candle data")
    return result

@router.get("/option-chain")
def get_option_chain(symbol: str, strike_count: int = 10, timestamp: str = ""):
    """symbol format: NSE:NIFTY50-INDEX, NSE:RELIANCE-EQ, NSE:BANKNIFTY-INDEX etc."""
    result = client.get_option_chain(symbol, strike_count, timestamp)
    if not result or result.get("s") != "ok":
        raise HTTPException(404, f"No option chain data: {result}")
    # Stamp each option row with its lot size (from the symbol master, a cheap in-memory dict
    # lookup) so the frontend can add a leg straight to the Strategy Builder with the correct
    # lot-based quantity/stepper without a second round-trip.
    for row in result.get("data", {}).get("optionsChain", []):
        if row.get("option_type") and row.get("symbol"):
            row["lot_size"] = get_lot_size(row["symbol"])
    return result

@router.get("/tbills")
def get_tbills(with_depth: bool = True, max_stale: float = 300, rest_fallback: bool = True):
    """with_depth=False + rest_fallback=False = the watcher's instant pure-cache board."""
    return scan_tbills(with_depth=with_depth, max_stale=max_stale, rest_fallback=rest_fallback)

@router.get("/tbills/traded-yields")
def get_tbill_traded_yields():
    """Effective annualized ROI from the LAST TRADED PRICE of every T-Bill that traded today
    (volume > 0), best-yield first — a monitor of where the market is actually dealing."""
    return scan_traded_yields()

@router.post("/tbills/record-purchase")
def record_tbill_purchase(symbol: str):
    """Called right after a T-Bill buy order is placed, so the Holdings view can later show
    a buying date — Kite's holdings API doesn't expose the original purchase date itself."""
    bare_symbol = symbol.replace("NSE:", "")
    tbill_purchases.record_purchase(bare_symbol)
    return {"status": "recorded"}

@router.get("/tbills/purchases")
def get_tbill_purchases():
    return tbill_purchases.get_all_purchases()

@router.post("/tbills/purchases/set")
def set_tbill_purchase_date(symbol: str, date: str):
    """Manually set/correct a T-Bill holding's buying date, for holdings bought before this
    tracker existed (Kite's API doesn't expose a holding's original purchase date)."""
    bare_symbol = symbol.replace("NSE:", "")
    tbill_purchases.set_purchase_date(bare_symbol, date)
    return {"status": "set"}

# ---- Holding purchase lots (tranche-level ROI: one holding bought across several buys) --------

def _lot_key(broker: str, symbol: str) -> str:
    # Keyed by broker+bare-symbol so the same script held at two brokers keeps separate lots
    # (Fyers "NSE:CONCOR-EQ" and Shoonya "CONCOR-EQ" would otherwise collide).
    return f"{broker}:{symbol.replace('NSE:', '')}"

@router.get("/holding-lots")
def get_holding_lots():
    return holding_lots.get_all()

@router.post("/holding-lots")
def add_holding_lot(broker: str, symbol: str, date: str, qty: int, price: float):
    if qty <= 0 or price < 0:
        raise HTTPException(400, "qty must be positive and price non-negative")
    return holding_lots.add_lot(_lot_key(broker, symbol), date, qty, price)

@router.delete("/holding-lots/{lot_id}")
def delete_holding_lot(lot_id: str, broker: str, symbol: str):
    holding_lots.delete_lot(_lot_key(broker, symbol), lot_id)
    return {"deleted": True}

# ---- Holding target/SL auto-exit — arm ANY Holdings-tab instrument (equity or other) with an ------
# ---- optional target and/or stop-loss; the watcher sells the full qty the instant either hits. ----

def _resolve_fyers_symbol(broker: str, symbol: str) -> str | None:
    """Canonical Fyers symbol for a broker's own holdings tradingsymbol — used ONLY to poll a live
    quote (Fyers is the sole market-data source). The exit order itself is placed with `symbol`
    exactly as given, so a resolution miss just means no live quote (the watcher safely never
    fires), never a wrong order."""
    if broker == "fyers":
        return symbol if symbol.startswith("NSE:") else f"NSE:{symbol}"
    if broker == "shoonya":
        try:
            fy = shoonya_symbols.shoonya_to_fyers(symbol, "NSE")
            if fy:
                return fy
        except Exception:
            pass
    root = symbol.split(":")[-1].split("-")[0].upper()
    matches = search_symbols(root, limit=5)
    exact = next((m for m in matches if m["symbol"].split(":")[-1].split("-")[0] == root), None)
    chosen = exact or (matches[0] if matches else None)
    return chosen["symbol"] if chosen else None

@router.get("/holding-targets")
def get_holding_targets():
    return holding_targets_db.list_all()

@router.post("/holding-targets")
def arm_holding_target(broker: str, symbol: str, target_price: Optional[float] = None,
                       sl_price: Optional[float] = None):
    if target_price is None and sl_price is None:
        raise HTTPException(400, "Set at least one of target_price / sl_price")
    if target_price is not None and target_price <= 0:
        raise HTTPException(400, "target_price must be positive")
    if sl_price is not None and sl_price <= 0:
        raise HTTPException(400, "sl_price must be positive")
    fy = _resolve_fyers_symbol(broker, symbol)
    return holding_targets_db.arm(broker, symbol, fy, target_price, sl_price)

@router.post("/holding-targets/auto")
def set_holding_target_auto(broker: str, symbol: str, on: bool):
    row = holding_targets_db.set_auto(broker, symbol, on)
    if not row:
        raise HTTPException(404, "Not armed")
    return row

@router.delete("/holding-targets")
def remove_holding_target(broker: str, symbol: str):
    holding_targets_db.disarm(broker, symbol)
    return {"disarmed": True}

@router.post("/fo-volatility/start")
def start_fo_volatility_scan(strike_count: int = 20):
    """Kicks off the F&O volatility scan in the background (~200 underlyings, paced well
    below Fyers' option-chain rate limit — takes a few minutes). Poll /fo-volatility/status."""
    return volatility_watcher.start_scan(strike_count=strike_count)

@router.get("/fo-volatility/status")
def fo_volatility_status():
    return volatility_watcher.get_status()

@router.get("/volatility")
def volatility_for_symbol(root: str, strike_count: int = 20):
    """Volatility ratio for a single F&O underlying (by root) — for the per-strategy card badge.
    Returns {} when the root isn't an F&O underlying or no chain data is available."""
    return volatility_scanner.volatility_for_root(root, strike_count=strike_count) or {}

@router.get("/depth")
def get_depth(symbol: str):
    """Live market depth (best 5 bid/ask levels with quantity) for a single symbol."""
    result = client.get_depth(symbol)
    if not result or result.get("s") != "ok":
        raise HTTPException(404, f"No depth data: {result}")
    return result["d"].get(symbol, {})
