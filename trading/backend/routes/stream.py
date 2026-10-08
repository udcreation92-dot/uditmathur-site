"""Live-stream endpoints: subscribe symbols to the Fyers WebSocket feed and read the in-memory
tick cache (instant, no broker round-trip). The foundation for the intraday system."""
from fastapi import APIRouter
from pydantic import BaseModel

import fyers_ws

router = APIRouter(prefix="/stream", tags=["stream"])


class SubscribeRequest(BaseModel):
    symbols: list[str]   # Fyers-format, e.g. ["NSE:NIFTY50-INDEX", "NSE:RELIANCE-EQ"]


@router.get("/status")
def stream_status():
    """Socket connection state, subscription/cache counts, and how fresh the newest tick is."""
    fyers_ws.ensure_started()
    return fyers_ws.status()


@router.post("/subscribe")
def stream_subscribe(req: SubscribeRequest):
    """Add symbols to the live feed. Returns the current cached quotes for them plus stream status."""
    st = fyers_ws.subscribe(req.symbols)
    return {"status": st, "quotes": fyers_ws.get_quotes(req.symbols)}


@router.post("/unsubscribe")
def stream_unsubscribe(req: SubscribeRequest):
    return {"status": fyers_ws.unsubscribe(req.symbols)}


@router.get("/quotes")
def stream_quotes(symbols: str):
    """Latest streamed tick per symbol (comma-separated Fyers symbols). Instant dict lookup."""
    syms = [s.strip() for s in symbols.split(",") if s.strip()]
    return {"quotes": fyers_ws.get_quotes(syms), "status": fyers_ws.status()}
