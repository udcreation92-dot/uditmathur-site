from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from fyers_client import client

router = APIRouter(prefix="/orders", tags=["orders"])

ORDER_TYPE_MAP = {"MKT": 2, "LMT": 1, "SL": 4, "SL-M": 3}

class OrderRequest(BaseModel):
    symbol: str                 # e.g. "NSE:RELIANCE-EQ"
    side: str                   # "BUY" or "SELL"
    quantity: int
    order_type: str             # "MKT", "LMT", "SL", "SL-M"
    limit_price: float = 0
    stop_price: float = 0
    product_type: str = "INTRADAY"  # INTRADAY, CNC, MARGIN

@router.post("/place")
def place_order(req: OrderRequest):
    if req.side not in ("BUY", "SELL"):
        raise HTTPException(400, "side must be 'BUY' or 'SELL'")
    if req.order_type not in ORDER_TYPE_MAP:
        raise HTTPException(400, f"order_type must be one of {list(ORDER_TYPE_MAP)}")

    result = client.place_order(
        symbol=req.symbol,
        qty=req.quantity,
        side=1 if req.side == "BUY" else -1,
        order_type=ORDER_TYPE_MAP[req.order_type],
        product_type=req.product_type,
        limit_price=req.limit_price,
        stop_price=req.stop_price,
    )
    if not result or result.get("s") != "ok":
        raise HTTPException(400, f"Order failed: {result}")
    return result

@router.get("/book")
def order_book():
    result = client.get_order_book()
    return result.get("orderBook", []) if result else []

@router.get("/positions")
def positions():
    result = client.get_positions()
    return result.get("netPositions", []) if result else []

@router.get("/funds")
def funds():
    """Standardized across brokers: cash + pledged collateral = total; available = total -
    utilized. Fyers labels its cash ledger "Total Balance"; its own "Available Balance" differs
    slightly from total-utilized (Receivables/Adhoc buckets) and is kept as native_available."""
    result = client.get_funds()
    rows = result.get("fund_limit", []) if result else []
    by_title = {row["title"]: row["equityAmount"] for row in rows}
    cash = by_title.get("Total Balance", 0)
    collateral = by_title.get("Collaterals", 0)
    utilized = by_title.get("Utilized Amount", 0)
    total = cash + collateral
    return {
        "cash": cash,
        "collateral": collateral,
        "utilized": utilized,
        "available": total - utilized,
        "total": total,
        "native_available": by_title.get("Available Balance"),
        "raw": rows,
    }


class ModifyOrderRequest(BaseModel):
    limit_price: Optional[float] = None
    stop_price: Optional[float] = None
    quantity: Optional[int] = None
    order_type: Optional[str] = None  # "MKT", "LMT", "SL", "SL-M"

@router.patch("/{order_id}")
def modify_order(order_id: str, req: ModifyOrderRequest):
    fields = {}
    if req.limit_price is not None: fields["limitPrice"] = req.limit_price
    if req.stop_price is not None: fields["stopPrice"] = req.stop_price
    if req.quantity is not None: fields["qty"] = req.quantity
    if req.order_type is not None: fields["type"] = ORDER_TYPE_MAP.get(req.order_type)

    result = client.modify_order(order_id, **fields)
    if not result or result.get("s") != "ok":
        raise HTTPException(400, f"Modify failed: {result}")
    return result

@router.delete("/{order_id}")
def cancel_order(order_id: str):
    result = client.cancel_order(order_id)
    if not result or result.get("s") != "ok":
        raise HTTPException(400, f"Cancel failed: {result}")
    return result

class ExitPositionRequest(BaseModel):
    position_id: Optional[str] = None  # omit to exit ALL open positions

@router.post("/exit")
def exit_positions(req: ExitPositionRequest):
    result = client.exit_positions(req.position_id)
    if not result or result.get("s") != "ok":
        raise HTTPException(400, f"Exit failed: {result}")
    return result

class ConvertPositionRequest(BaseModel):
    symbol: str
    position_side: int      # 1 = long, -1 = short
    convert_qty: int
    convert_from: str       # existing productType
    convert_to: str         # new productType

@router.post("/convert")
def convert_position(req: ConvertPositionRequest):
    result = client.convert_position(
        req.symbol, req.position_side, req.convert_qty, req.convert_from, req.convert_to
    )
    if not result or result.get("s") != "ok":
        raise HTTPException(400, f"Convert failed: {result}")
    return result

@router.get("/tradebook")
def tradebook():
    result = client.get_tradebook()
    return result.get("tradeBook", []) if result else []

@router.get("/holdings")
def holdings():
    result = client.get_holdings()
    return result.get("holdings", []) if result else []

@router.get("/history/{order_id}")
def order_history(order_id: str):
    result = client.get_order_history(id=order_id)
    if not result or result.get("s") != "ok":
        raise HTTPException(404, f"Order history not found: {result}")
    return result.get("orderBook", result)

@router.get("/market-status")
def market_status():
    result = client.get_market_status()
    return result.get("marketStatus", []) if result else []

@router.post("/logout")
def logout():
    result = client.logout()
    return {"status": "logged out", "raw": result}
