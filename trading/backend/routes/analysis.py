from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import List, Optional
import pandas as pd
from fyers_client import client
from modules import ALL_MODULES
from datetime import datetime, timedelta

router = APIRouter(prefix="/analysis", tags=["analysis"])

class AnalyzeRequest(BaseModel):
    symbol: str          # e.g. "NSE:RELIANCE-EQ"
    resolution: str = "5"  # minutes, or "D" for daily
    days: int = 10
    modules: Optional[List[str]] = None

def fetch_df(symbol: str, resolution: str, days: int) -> pd.DataFrame:
    end = datetime.now()
    start = end - timedelta(days=days)
    data = client.get_candles(
        symbol, resolution,
        range_from=start.strftime("%Y-%m-%d"),
        range_to=end.strftime("%Y-%m-%d"),
    )
    if not data or data.get("s") != "ok" or not data.get("candles"):
        raise HTTPException(404, "No market data")

    df = pd.DataFrame(data["candles"], columns=["time", "open", "high", "low", "close", "volume"])
    df = df.dropna(subset=["open", "high", "low", "close"]).reset_index(drop=True)
    return df

@router.post("/run")
def run_analysis(req: AnalyzeRequest):
    df = fetch_df(req.symbol, req.resolution, req.days)
    if len(df) < 30:
        raise HTTPException(400, "Not enough candle data (need 30+)")

    active = req.modules if req.modules else list(ALL_MODULES.keys())
    results = {}
    buy_votes = sell_votes = hold_votes = 0
    total_confidence = 0.0

    for name in active:
        if name not in ALL_MODULES:
            continue
        try:
            r = ALL_MODULES[name].analyze(df)
            results[name] = {
                "signal": r.signal,
                "confidence": r.confidence,
                "reason": r.reason,
                "indicators": r.indicators,
            }
            if r.signal == "BUY":
                buy_votes += 1
                total_confidence += r.confidence
            elif r.signal == "SELL":
                sell_votes += 1
                total_confidence -= r.confidence
            else:
                hold_votes += 1
        except Exception as e:
            results[name] = {"error": str(e)}

    total = buy_votes + sell_votes + hold_votes or 1
    if buy_votes > sell_votes:
        consensus = "BUY"
    elif sell_votes > buy_votes:
        consensus = "SELL"
    else:
        consensus = "HOLD"

    return {
        "consensus": consensus,
        "buy_votes": buy_votes,
        "sell_votes": sell_votes,
        "hold_votes": hold_votes,
        "confidence_score": round(total_confidence / total, 3),
        "candles": len(df),
        "latest_close": float(df["close"].iloc[-1]),
        "modules": results,
    }

@router.get("/modules")
def list_modules():
    return [{"id": k, "name": v.name, "description": v.description}
            for k, v in ALL_MODULES.items()]
