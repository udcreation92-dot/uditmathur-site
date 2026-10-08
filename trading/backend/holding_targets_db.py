"""Per-holding auto-exit: arm a broker holding (equity, ETF, bond — anything in the Holdings tab,
not just cash-segment scalps) with an optional target and/or stop-loss price. Neither is mandatory
— arm with a target only, a stop only, or both. The watcher (holding_target_watcher.py) sells the
FULL current holding qty the instant either level is touched, as a marketable LIMIT at the live bid.

Keyed by (broker, the broker's OWN tradingsymbol — the exact string that broker's holdings endpoint
returns), so the exit order can be placed with zero symbol-format conversion. fyers_symbol is only
the canonical form used to poll a live quote (Fyers is the sole market-data source)."""
import datetime
import sqlite3
from pathlib import Path
import state_paths

DB_FILE = state_paths.state_path(".holding_targets.db")


def _conn():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS holding_targets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                broker TEXT NOT NULL,
                symbol TEXT NOT NULL,          -- broker's own tradingsymbol, e.g. zerodha "HDFCBANK"
                fyers_symbol TEXT,             -- resolved canonical symbol, for live quotes only
                target_price REAL,
                sl_price REAL,
                auto_enabled INTEGER NOT NULL DEFAULT 1,
                status TEXT NOT NULL DEFAULT 'ARMED',   -- ARMED | FIRED
                exit_order_id TEXT,
                exit_reason TEXT,               -- TARGET | SL
                created_at TEXT NOT NULL,
                fired_at TEXT,
                UNIQUE(broker, symbol)
            )
        """)


def arm(broker: str, symbol: str, fyers_symbol: str | None, target_price: float | None = None,
        sl_price: float | None = None) -> dict:
    """Arm (or re-arm) a holding. Re-arming clears any prior FIRED state."""
    now = datetime.datetime.utcnow().isoformat()
    with _conn() as conn:
        conn.execute("""
            INSERT INTO holding_targets
                (broker, symbol, fyers_symbol, target_price, sl_price, auto_enabled, status, created_at)
            VALUES (?, ?, ?, ?, ?, 1, 'ARMED', ?)
            ON CONFLICT(broker, symbol) DO UPDATE SET
                fyers_symbol=excluded.fyers_symbol, target_price=excluded.target_price,
                sl_price=excluded.sl_price, auto_enabled=1, status='ARMED',
                exit_order_id=NULL, exit_reason=NULL, fired_at=NULL
        """, (broker, symbol, fyers_symbol, target_price, sl_price, now))
    return get(broker, symbol)


def disarm(broker: str, symbol: str):
    with _conn() as conn:
        conn.execute("DELETE FROM holding_targets WHERE broker=? AND symbol=?", (broker, symbol))


def set_auto(broker: str, symbol: str, on: bool) -> dict | None:
    with _conn() as conn:
        conn.execute("UPDATE holding_targets SET auto_enabled=? WHERE broker=? AND symbol=?",
                     (1 if on else 0, broker, symbol))
    return get(broker, symbol)


def get(broker: str, symbol: str) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM holding_targets WHERE broker=? AND symbol=?",
                            (broker, symbol)).fetchone()
        return dict(row) if row else None


def list_all() -> list[dict]:
    with _conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM holding_targets ORDER BY id")]


def list_armed() -> list[dict]:
    with _conn() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM holding_targets WHERE auto_enabled=1 AND status='ARMED'")]


def mark_fired(broker: str, symbol: str, order_id: str, reason: str):
    with _conn() as conn:
        conn.execute("""
            UPDATE holding_targets SET status='FIRED', exit_order_id=?, exit_reason=?, fired_at=?
            WHERE broker=? AND symbol=?
        """, (str(order_id), reason, datetime.datetime.utcnow().isoformat(), broker, symbol))


init_db()
