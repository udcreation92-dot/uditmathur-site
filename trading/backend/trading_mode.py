"""Global trading mode for the AI order path (Phase 3). Persisted so it survives restarts.

  dry_run  — place_order SIMULATES + logs, never hits a broker (DEFAULT / safe).
  live     — place_order places real orders.
  killed   — kill switch: ALL order placement is refused.

Deterministic guardrail state — the LLM can read/flip it via set_trading_mode, but the backend is
what actually enforces it on every place_order. Defaults to dry_run if the file is missing/corrupt."""
import json
import threading

import state_paths

_FILE = state_paths.state_path(".trading_mode.json")
_lock = threading.Lock()
VALID = ("dry_run", "live", "killed")
DEFAULT = "dry_run"


def get_mode() -> str:
    try:
        m = json.loads(_FILE.read_text()).get("mode")
        return m if m in VALID else DEFAULT
    except Exception:
        return DEFAULT


def set_mode(mode: str) -> str:
    if mode not in VALID:
        raise ValueError(f"mode must be one of {VALID}")
    with _lock:
        _FILE.write_text(json.dumps({"mode": mode}))
    return mode
