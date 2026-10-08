import json
import datetime
from pathlib import Path
import state_paths

STORE_FILE = state_paths.state_path(".tbill_purchases.json")


def _load() -> dict:
    # Tolerate an empty/corrupt store (interrupted write) — start fresh rather than crash.
    if STORE_FILE.exists():
        try:
            return json.loads(STORE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save(data: dict):
    STORE_FILE.write_text(json.dumps(data))


def record_purchase(symbol: str, when: str = None):
    """Records the earliest known buy date for a T-Bill symbol (bare, no exchange prefix).
    Only covers purchases made through this app going forward — historical holdings bought
    before this tracker existed won't have a recorded date, since Kite's API doesn't expose
    a holding's original purchase date."""
    when = when or datetime.date.today().isoformat()
    data = _load()
    if symbol not in data or when < data[symbol]:
        data[symbol] = when
        _save(data)


def set_purchase_date(symbol: str, when: str):
    """Manual override — used when the user knows the actual purchase date for a holding
    bought before this tracker existed (or wants to correct an auto-recorded one)."""
    data = _load()
    data[symbol] = when
    _save(data)


def get_purchase_date(symbol: str) -> str | None:
    return _load().get(symbol)


def get_all_purchases() -> dict:
    return _load()
