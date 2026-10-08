from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import tbill_watch_db as db
import tbill_watcher

router = APIRouter(prefix="/tbill-watch", tags=["tbill-watch"])


class StartRequest(BaseModel):
    target_roi: float
    budget_total: float
    broker: str = "fyers"
    label: str | None = None


class StopRequest(BaseModel):
    id: int


def _state():
    return {"watches": db.list_watches(), "log": db.get_log(50)}


@router.get("/status")
def status():
    return _state()


@router.post("/start")
def start(req: StartRequest):
    if req.budget_total <= 0:
        raise HTTPException(400, "Budget must be positive")
    if req.target_roi < 0:
        raise HTTPException(400, "Target ROI must be non-negative")
    if req.broker not in ("fyers", "zerodha", "shoonya"):
        raise HTTPException(400, "Broker must be fyers, zerodha, or shoonya")
    if db.active_count() >= db.MAX_ACTIVE_WATCHES:
        raise HTTPException(400, f"At most {db.MAX_ACTIVE_WATCHES} auto-buys can run at once. Stop one first.")
    db.create_watch(req.target_roi, req.budget_total, req.broker, req.label)
    tbill_watcher.wake()
    return _state()


@router.post("/stop")
def stop(req: StopRequest):
    db.stop_watch(req.id)
    return _state()


@router.post("/delete")
def delete(req: StopRequest):
    db.delete_watch(req.id)
    return _state()
