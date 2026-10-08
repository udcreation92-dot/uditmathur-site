"""Per-symbol purchase lots for holdings — an equity/ETF/bond can be bought in several tranches
on different days at different prices, so tranche-level ROI needs each buy recorded separately
(the broker only reports the blended average). Keyed by bare symbol; each lot is {id, date, qty,
price}. Independent of the single-date tbill_purchases store."""
import json
import datetime
from pathlib import Path
import state_paths

STORE_FILE = state_paths.state_path(".holding_lots.json")


def _load() -> dict:
    # Tolerate an empty/corrupt store (e.g. a write interrupted by a backend restart left a
    # 0-byte file) — start fresh rather than crashing every caller with a JSON decode error.
    if STORE_FILE.exists():
        try:
            return json.loads(STORE_FILE.read_text())
        except (json.JSONDecodeError, OSError):
            return {}
    return {}


def _save(data: dict):
    STORE_FILE.write_text(json.dumps(data))


def get_all() -> dict:
    """{ bare_symbol: [ {id, date, qty, price}, ... ] }"""
    return _load()


def add_lot(symbol: str, date: str, qty: int, price: float) -> dict:
    data = _load()
    lots = data.setdefault(symbol, [])
    lot = {
        "id": f"{int(datetime.datetime.utcnow().timestamp() * 1000)}",
        "date": date, "qty": int(qty), "price": float(price),
    }
    lots.append(lot)
    lots.sort(key=lambda l: l["date"])
    _save(data)
    return lot


def delete_lot(symbol: str, lot_id: str):
    data = _load()
    if symbol in data:
        data[symbol] = [l for l in data[symbol] if l["id"] != lot_id]
        if not data[symbol]:
            del data[symbol]
        _save(data)
