"""ROI-target option-selling solver endpoints (Phase 2). Read-only / compute-only — no orders.
Powers the AI ('put ₹6L at 20% in Nifty') and, later, a dashboard button."""
import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import roi_solver
from fyers_client import client as fyers

router = APIRouter(prefix="/roi", tags=["roi-solver"])


@router.get("/expiries")
def expiries(underlying: str = roi_solver.DEFAULT_UNDERLYING):
    """Available expiries for the underlying, so the caller can choose expiry_index (0 = nearest)."""
    base = fyers.get_option_chain(underlying, strike_count=2, timestamp="")
    if not base or base.get("s") != "ok":
        raise HTTPException(404, f"expiries unavailable (is Fyers logged in?): {base}")
    out = []
    for i, e in enumerate(base["data"].get("expiryData", [])):
        ts = int(e["expiry"])
        days = (datetime.datetime.fromtimestamp(ts).date() - datetime.date.today()).days + 1
        out.append({"index": i, "date": e["date"], "days_to_expiry": days})
    return {"underlying": underlying, "expiries": out}


class SolveRequest(BaseModel):
    capital: float
    target_roi_pct: float
    underlying: str = roi_solver.DEFAULT_UNDERLYING
    expiry_index: int = 0
    roi_basis: str = "annualized"   # "annualized" (weekly/monthly) or "absolute" (same-day)


@router.post("/solve")
def solve(req: SolveRequest):
    try:
        return roi_solver.solve(
            capital=req.capital,
            target_roi_pct=req.target_roi_pct,
            underlying=req.underlying,
            expiry_index=req.expiry_index,
            roi_basis=req.roi_basis,
        )
    except roi_solver.RoiSolverError as e:
        raise HTTPException(400, str(e))
