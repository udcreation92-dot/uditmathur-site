"""Strategy registry endpoints — list/get named strategies. Read-only. Consumed by the AI (via MCP)
so it can look up how to run a strategy the user names."""
from fastapi import APIRouter, HTTPException

import strategy_registry

router = APIRouter(prefix="/strategies", tags=["strategies"])


@router.get("")
def list_strategies():
    return {"strategies": strategy_registry.list_all()}


@router.get("/{name}")
def get_strategy(name: str):
    s = strategy_registry.get(name)
    if not s:
        raise HTTPException(404, f"unknown strategy '{name}'")
    return s
