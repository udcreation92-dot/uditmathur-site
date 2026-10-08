from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from fyers_client import client

router = APIRouter(prefix="/gtt", tags=["gtt"])


class GttLeg(BaseModel):
    price: float
    trigger_price: Optional[float] = None
    quantity: int


class PlaceGttRequest(BaseModel):
    symbol: str
    side: str              # "BUY" or "SELL"
    product_type: str = "CNC"   # CNC, MARGIN, MTF
    leg1: GttLeg
    leg2: Optional[GttLeg] = None   # OCO second leg


def _leg_payload(leg: GttLeg) -> dict:
    d = {"price": leg.price, "qty": leg.quantity}
    if leg.trigger_price is not None:
        d["triggerPrice"] = leg.trigger_price
    return d


@router.post("/place")
def place_gtt(req: PlaceGttRequest):
    if req.side not in ("BUY", "SELL"):
        raise HTTPException(400, "side must be 'BUY' or 'SELL'")
    result = client.place_gtt_order(
        symbol=req.symbol,
        side=1 if req.side == "BUY" else -1,
        product_type=req.product_type,
        leg1=_leg_payload(req.leg1),
        leg2=_leg_payload(req.leg2) if req.leg2 else None,
    )
    if not result or result.get("s") != "ok":
        raise HTTPException(400, f"GTT place failed: {result}")
    return result


class ModifyGttRequest(BaseModel):
    leg1: GttLeg
    leg2: Optional[GttLeg] = None


@router.patch("/{order_id}")
def modify_gtt(order_id: str, req: ModifyGttRequest):
    result = client.modify_gtt_order(
        order_id, leg1=_leg_payload(req.leg1), leg2=_leg_payload(req.leg2) if req.leg2 else None
    )
    if not result or result.get("s") != "ok":
        raise HTTPException(400, f"GTT modify failed: {result}")
    return result


@router.delete("/{order_id}")
def cancel_gtt(order_id: str):
    result = client.cancel_gtt_order(order_id)
    if not result or result.get("s") != "ok":
        raise HTTPException(400, f"GTT cancel failed: {result}")
    return result


@router.get("/list")
def list_gtt():
    result = client.get_gtt_orders()
    return result.get("data", []) if result else []
