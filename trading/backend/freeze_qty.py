"""
NSE freeze quantity per underlying — the max qty a SINGLE F&O order may carry. Orders above it are
rejected ("Check Freeze qty ... Set:N"), so large orders must be split into chunks <= this.

Values change ~quarterly. KNOWN holds the common indices; a persisted cache LEARNS the exact value
from broker rejections (so any instrument self-corrects after one reject); unknown instruments fall
back to a conservative DEFAULT. All quantities are in units (not lots).
"""
import json
import re
import threading

import state_paths

_FILE = state_paths.state_path(".freeze_qty.json")
_lock = threading.Lock()

# NSE freeze quantities (units). Update when NSE revises; the learned cache overrides these.
KNOWN = {
    "NIFTY": 1800, "BANKNIFTY": 900, "FINNIFTY": 1800,
    "MIDCPNIFTY": 4200, "NIFTYNXT50": 1200,
}
DEFAULT = 900  # conservative fallback for an unknown stock; the real value is learned on first reject


def _cache() -> dict:
    try:
        return json.loads(_FILE.read_text())
    except Exception:
        return {}


def get_freeze_qty(root: str) -> int:
    root = (root or "").upper()
    c = _cache()
    if root in c:
        return int(c[root])
    return KNOWN.get(root, DEFAULT)


def learn(root: str, freeze_qty: int) -> None:
    root = (root or "").upper()
    with _lock:
        c = _cache()
        c[root] = int(freeze_qty)
        _FILE.write_text(json.dumps(c))


def parse_reject(msg: str):
    """From a broker reject like '...Current:2795 Set:1801:NFO...' return the max allowed qty (1800).
    'Set:N' is the freeze trigger, so the allowed max is N-1. Returns None if not a freeze reject."""
    m = re.search(r"Set:\s*(\d+)", msg or "")
    if not m or "freeze" not in (msg or "").lower():
        return None
    return max(int(m.group(1)) - 1, 1)


def max_qty(root: str, lot_size: int) -> int:
    """Largest lot-aligned qty allowed in one order for this instrument."""
    return max((get_freeze_qty(root) // lot_size) * lot_size, lot_size)


def chunks(total_qty: int, max_per_order: int) -> list[int]:
    """Split total_qty into lot-aligned chunks each <= max_per_order (largest-first, fewest orders)."""
    out = []
    remaining = total_qty
    while remaining > 0:
        c = min(remaining, max_per_order)
        out.append(c)
        remaining -= c
    return out
