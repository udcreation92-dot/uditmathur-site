from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from fyers_client import client

router = APIRouter(prefix="/alerts", tags=["alerts"])

VALID_COMPARISON = {"OPEN", "HIGH", "LOW", "CLOSE", "LTP"}
VALID_CONDITION = {"GT", "LT", "EQ"}


class CreateAlertRequest(BaseModel):
    symbol: str
    comparison_type: str    # OPEN, HIGH, LOW, CLOSE, LTP
    condition: str           # GT, LT, EQ
    value: float
    name: str


@router.post("/create")
def create_alert(req: CreateAlertRequest):
    if req.comparison_type not in VALID_COMPARISON:
        raise HTTPException(400, f"comparison_type must be one of {VALID_COMPARISON}")
    if req.condition not in VALID_CONDITION:
        raise HTTPException(400, f"condition must be one of {VALID_CONDITION}")
    result = client.create_alert(req.symbol, req.comparison_type, req.condition, req.value, req.name)
    if not result or result.get("s") != "ok":
        raise HTTPException(400, f"Alert creation failed: {result}")
    return result


class UpdateAlertRequest(BaseModel):
    symbol: str
    comparison_type: str
    condition: str
    value: float
    name: str


@router.put("/{alert_id}")
def update_alert(alert_id: str, req: UpdateAlertRequest):
    result = client.update_alert(alert_id, req.symbol, req.comparison_type, req.condition, req.value, req.name)
    if not result or result.get("s") != "ok":
        raise HTTPException(400, f"Alert update failed: {result}")
    return result


@router.delete("/{alert_id}")
def delete_alert(alert_id: str):
    result = client.delete_alert(alert_id)
    if not result or result.get("s") != "ok":
        raise HTTPException(400, f"Alert deletion failed: {result}")
    return result


@router.post("/{alert_id}/toggle")
def toggle_alert(alert_id: str):
    result = client.toggle_alert(alert_id)
    if not result or result.get("s") != "ok":
        raise HTTPException(400, f"Alert toggle failed: {result}")
    return result


@router.get("/list")
def list_alerts(archive: int = 0):
    result = client.get_alerts(archive)
    data = result.get("data", {}) if result else {}
    if isinstance(data, list):
        return data
    return [{"alert_id": alert_id, "symbol": v.get("symbol"), **v.get("alert", {})}
            for alert_id, v in data.items()]
