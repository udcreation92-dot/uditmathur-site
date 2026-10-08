from fastapi import APIRouter
from typing import Optional
from fyers_client import client

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/ledger")
def ledger_history(from_date: Optional[str] = None, to_date: Optional[str] = None):
    params = {}
    if from_date: params["from_date"] = from_date
    if to_date: params["to_date"] = to_date
    result = client.get_ledger_history(**params)
    return result.get("data", []) if result else []


@router.get("/realised-pnl")
def realised_profit_history(from_date: Optional[str] = None, to_date: Optional[str] = None):
    params = {}
    if from_date: params["from_date"] = from_date
    if to_date: params["to_date"] = to_date
    result = client.get_realised_profit_history(**params)
    return result.get("data", []) if result else []


@router.get("/tax-pnl")
def tax_pnl_history(from_date: Optional[str] = None, to_date: Optional[str] = None):
    params = {}
    if from_date: params["from_date"] = from_date
    if to_date: params["to_date"] = to_date
    result = client.get_tax_pnl_history(**params)
    return result.get("data", []) if result else []


@router.get("/charges")
def charges_history(from_date: Optional[str] = None, to_date: Optional[str] = None,
                    report_type: str = "1"):
    params = {"report_type": report_type}
    if from_date: params["from_date"] = from_date
    if to_date: params["to_date"] = to_date
    result = client.get_charges_history(**params)
    return result.get("data", []) if result else []
