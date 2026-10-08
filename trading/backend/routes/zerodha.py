import os
from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from typing import List, Optional
from kiteconnect import KiteConnect
from zerodha_client import client

router = APIRouter(prefix="/zerodha", tags=["zerodha"])

FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:5173/task/trading.html")


@router.get("/auth/status")
def auth_status():
    return {"logged_in": client.is_logged_in()}


@router.get("/auth/login-url")
def login_url():
    try:
        return {"url": client.get_login_url()}
    except KeyError:
        raise HTTPException(400, "ZERODHA_API_KEY / ZERODHA_API_SECRET not set in backend/.env yet")


@router.post("/auth/callback")
def auth_callback(request_token: str):
    try:
        data = client.exchange_request_token(request_token)
        return {"status": "logged in", "user_id": data.get("user_id"), "user_name": data.get("user_name")}
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/auth/redirect")
def auth_redirect(request_token: str = None, status: str = None):
    """Receives Kite Connect's OAuth redirect directly (registered as the app's Redirect URL
    in the Kite Connect developer console), exchanges the token server-side, then bounces the
    browser back to the frontend — no more copying the redirect URL by hand each day."""
    if not request_token:
        return RedirectResponse(f"{FRONTEND_URL}?zerodha_login=error")
    try:
        client.exchange_request_token(request_token)
        return RedirectResponse(f"{FRONTEND_URL}?zerodha_login=success")
    except Exception:
        return RedirectResponse(f"{FRONTEND_URL}?zerodha_login=error")


@router.post("/auth/logout")
def logout():
    client.logout()
    return {"status": "logged out"}


@router.get("/positions")
def positions():
    result = client.get_positions()
    return result.get("net", []) if result else []


@router.get("/holdings")
def holdings():
    return client.get_holdings() or []


@router.get("/funds")
def funds():
    """Standardized: cash + collateral = total; available = total - utilized. Kite's `net` is
    actually the available margin (not a true total), so we compute total from cash+collateral
    for cross-broker consistency; live_balance is kept as native_available."""
    margins = client.get_funds() or {}
    equity = margins.get("equity", {})
    available = equity.get("available", {})
    utilised = equity.get("utilised", {})
    cash = available.get("cash", 0) or 0
    collateral = available.get("collateral", 0) or 0
    utilized = utilised.get("debits", 0) or 0
    total = cash + collateral
    return {
        "cash": cash,
        "collateral": collateral,
        "utilized": utilized,
        "available": total - utilized,
        "total": total,
        "native_available": available.get("live_balance", equity.get("net")),
        "raw": margins,
    }


@router.get("/orders/book")
def order_book():
    return client.get_order_book() or []


class OrderRequest(BaseModel):
    exchange: str          # NSE, BSE, NFO, BFO, MCX, CDS
    tradingsymbol: str     # e.g. "INFY" (no exchange prefix, unlike Fyers)
    side: str              # "BUY" or "SELL"
    quantity: int
    order_type: str        # "MARKET", "LIMIT", "SL", "SL-M"
    product: str = "MIS"   # MIS, CNC, NRML
    price: Optional[float] = None
    trigger_price: Optional[float] = None
    variety: str = "regular"
    validity: str = "DAY"


# Kite rejects plain MARKET orders on F&O via API ("Market orders without market protection
# are not allowed…") — the sanctioned workaround is a marketable LIMIT at LTP padded by a
# protection buffer: fills immediately in a liquid book, but caps the worst fill in a thin one.
MARKET_PROTECTION_PCT = 3.0


def _protective_limit_price(exchange: str, tradingsymbol: str, side: str) -> float | None:
    try:
        ltp = client.get_ltp([f"{exchange}:{tradingsymbol}"]).get(f"{exchange}:{tradingsymbol}")
    except Exception:
        return None
    if not ltp:
        return None
    pad = ltp * MARKET_PROTECTION_PCT / 100
    price = ltp + pad if side == "BUY" else ltp - pad
    return max(round(round(price / 0.05) * 0.05, 2), 0.05)


@router.post("/orders/place")
def place_order(req: OrderRequest):
    if req.side not in ("BUY", "SELL"):
        raise HTTPException(400, "side must be 'BUY' or 'SELL'")
    order_type, price = req.order_type, req.price
    if order_type == "MARKET" and req.exchange in ("NFO", "BFO"):
        protected = _protective_limit_price(req.exchange, req.tradingsymbol, req.side)
        if protected:
            order_type, price = "LIMIT", protected
        # If LTP lookup failed, fall through with MARKET and let Kite report its own error.
    try:
        order_id = client.place_order(
            variety=req.variety,
            exchange=req.exchange,
            tradingsymbol=req.tradingsymbol,
            transaction_type=req.side,
            quantity=req.quantity,
            product=req.product,
            order_type=order_type,
            price=price,
            trigger_price=req.trigger_price,
            validity=req.validity,
        )
    except Exception as e:
        raise HTTPException(400, f"Order failed: {e}")
    return {"order_id": order_id, "order_type": order_type, "price": price}


class ModifyOrderRequest(BaseModel):
    variety: str = "regular"
    quantity: Optional[int] = None
    price: Optional[float] = None
    order_type: Optional[str] = None
    trigger_price: Optional[float] = None
    validity: Optional[str] = None


@router.patch("/orders/{order_id}")
def modify_order(order_id: str, req: ModifyOrderRequest):
    fields = {k: v for k, v in req.dict().items() if v is not None and k != "variety"}
    try:
        result = client.modify_order(variety=req.variety, order_id=order_id, **fields)
    except Exception as e:
        raise HTTPException(400, f"Modify failed: {e}")
    return {"order_id": result}


@router.delete("/orders/{order_id}")
def cancel_order(order_id: str, variety: str = "regular"):
    try:
        result = client.cancel_order(variety=variety, order_id=order_id)
    except Exception as e:
        raise HTTPException(400, f"Cancel failed: {e}")
    return {"order_id": result}


@router.get("/trades")
def trades():
    return client.get_trades() or []


_instr_cache: dict[str, dict] = {}   # exchange -> {tradingsymbol: instrument_token}
_instr_ts: dict[str, float] = {}
_INSTR_TTL = 12 * 3600               # instrument list is refreshed by Zerodha daily


def _instrument_map(exchange: str) -> dict:
    """{tradingsymbol: instrument_token} for one exchange, from Kite's instruments master dump
    (available to every Kite app — no quote permission needed). Cached for 12h."""
    now = __import__("time").time()
    if exchange in _instr_cache and now - _instr_ts.get(exchange, 0) < _INSTR_TTL:
        return _instr_cache[exchange]
    rows = client.get_api().instruments(exchange)
    m = {r["tradingsymbol"]: r["instrument_token"] for r in rows}
    _instr_cache[exchange] = m
    _instr_ts[exchange] = now
    return m


@router.get("/instrument-token")
def instrument_token(symbol: str):
    """Resolve a Kite "EXCHANGE:TRADINGSYMBOL" (e.g. "NSE:HDFCBANK") to its instrument token,
    used to build a kite.zerodha.com chart deep-link."""
    if ":" not in symbol:
        raise HTTPException(400, "symbol must be EXCHANGE:TRADINGSYMBOL")
    exchange, tsym = symbol.split(":", 1)
    try:
        m = _instrument_map(exchange)
    except Exception as e:
        raise HTTPException(400, f"Instruments lookup failed: {e}")
    token = m.get(tsym)
    if not token:
        raise HTTPException(404, f"No instrument token found for {symbol}")
    return {"symbol": symbol, "instrument_token": token}


class MarginLeg(BaseModel):
    exchange: str
    tradingsymbol: str
    side: str              # "BUY" or "SELL"
    product: str
    order_type: str
    quantity: int
    price: float = 0
    trigger_price: float = 0
    variety: str = "regular"


class MarginRequest(BaseModel):
    legs: List[MarginLeg]


@router.post("/margins")
def calculate_margins(req: MarginRequest):
    if not req.legs:
        raise HTTPException(400, "At least one leg is required")
    orders = [{
        "exchange": leg.exchange,
        "tradingsymbol": leg.tradingsymbol,
        "transaction_type": leg.side,
        "variety": leg.variety,
        "product": leg.product,
        "order_type": leg.order_type,
        "quantity": leg.quantity,
        "price": leg.price,
        "trigger_price": leg.trigger_price,
    } for leg in req.legs]
    try:
        result = client.get_basket_margins(orders)
    except Exception as e:
        raise HTTPException(400, f"Margin calc failed: {e}")
    return result


class GttOrderLeg(BaseModel):
    transaction_type: str  # "BUY" or "SELL"
    quantity: int
    price: float


class GttRequest(BaseModel):
    trigger_type: str       # "single" or "two-leg"
    exchange: str
    tradingsymbol: str
    last_price: float
    trigger_values: List[float]
    orders: List[GttOrderLeg]


def _gtt_type(trigger_type: str) -> str:
    return KiteConnect.GTT_TYPE_OCO if trigger_type == "two-leg" else KiteConnect.GTT_TYPE_SINGLE


@router.get("/gtt/list")
def list_gtt():
    return client.get_gtts() or []


@router.post("/gtt/place")
def place_gtt(req: GttRequest):
    try:
        result = client.place_gtt(
            _gtt_type(req.trigger_type), req.tradingsymbol, req.exchange,
            req.trigger_values, req.last_price, [o.dict() for o in req.orders],
        )
    except Exception as e:
        raise HTTPException(400, f"GTT place failed: {e}")
    return {"trigger_id": result}


@router.put("/gtt/{trigger_id}")
def modify_gtt(trigger_id: int, req: GttRequest):
    try:
        result = client.modify_gtt(
            trigger_id, _gtt_type(req.trigger_type), req.tradingsymbol, req.exchange,
            req.trigger_values, req.last_price, [o.dict() for o in req.orders],
        )
    except Exception as e:
        raise HTTPException(400, f"GTT modify failed: {e}")
    return {"trigger_id": result}


@router.delete("/gtt/{trigger_id}")
def delete_gtt(trigger_id: int):
    try:
        result = client.delete_gtt(trigger_id)
    except Exception as e:
        raise HTTPException(400, f"GTT delete failed: {e}")
    return {"trigger_id": result}
