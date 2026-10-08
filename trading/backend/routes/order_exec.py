"""Guarded order-execution endpoints (Phase 3). preview (no side effects) / place (confirm-gated,
dry_run-aware) / trading-mode (dry_run | live | killed kill-switch). Consumed by the AI via MCP."""
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import order_exec
import trading_mode

router = APIRouter(prefix="/order", tags=["order-exec"])


class OrderRequest(BaseModel):
    ce_symbol: str
    pe_symbol: str
    lots: int
    ce_limit: float
    pe_limit: float
    broker: str = order_exec.DEFAULT_EXEC_BROKER
    fill_mode: str = order_exec.DEFAULT_FILL_MODE   # protective | exact
    confirm: bool = False


@router.post("/preview")
def preview(req: OrderRequest):
    return order_exec.preview_order(req.ce_symbol, req.pe_symbol, req.lots,
                                    req.ce_limit, req.pe_limit, req.broker, req.fill_mode)


@router.post("/place")
def place(req: OrderRequest):
    return order_exec.place_order(req.ce_symbol, req.pe_symbol, req.lots, req.ce_limit,
                                  req.pe_limit, req.broker, req.fill_mode, req.confirm)


@router.get("/mode")
def get_mode():
    return {"mode": trading_mode.get_mode(), "valid": list(trading_mode.VALID)}


class ModeRequest(BaseModel):
    mode: str   # dry_run | live | killed


@router.post("/mode")
def set_mode(req: ModeRequest):
    try:
        return {"mode": trading_mode.set_mode(req.mode)}
    except ValueError as e:
        raise HTTPException(400, str(e))
