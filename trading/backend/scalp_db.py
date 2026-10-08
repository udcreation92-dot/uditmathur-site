"""Cash-segment scalping ledger. Each scalp is one equity trade tracked by its ORDERS (entry +
exit), mirroring how strategies are tracked. States: WAITING (armed for the entry trigger) ->
ENTERING (entry limit order resting) -> OPEN (entry filled) -> EXITING (exit limit resting) ->
CLOSED. CNC scalps carry forward; MIS are intraday. A single global flag arms/disarms auto-trading.
"""
import datetime
import sqlite3
import threading
from pathlib import Path
import state_paths

_DB = state_paths.state_path(".scalps.db")
_lock = threading.Lock()


def _conn():
    c = sqlite3.connect(_DB)
    c.row_factory = sqlite3.Row
    return c


def init():
    with _lock, _conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS scalps (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol TEXT NOT NULL,          -- Fyers equity, e.g. NSE:RELIANCE-EQ
                name TEXT,
                side TEXT NOT NULL,            -- BUY | SELL (the ENTRY direction)
                entry_price REAL NOT NULL,
                sl_price REAL NOT NULL,
                target_price REAL NOT NULL,
                max_loss REAL NOT NULL,
                qty INTEGER NOT NULL,
                trade_type TEXT NOT NULL,      -- MIS | CNC
                broker TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'WAITING',  -- WAITING|ENTERING|OPEN|EXITING|CLOSED|CANCELLED
                entry_order_id TEXT, entry_fill_price REAL, entered_at TEXT,
                exit_order_id TEXT, exit_fill_price REAL, exit_reason TEXT, closed_at TEXT,
                realized_pnl REAL,
                note TEXT,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS scalp_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                auto_enabled INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.execute("INSERT OR IGNORE INTO scalp_settings (id, auto_enabled) VALUES (1, 0)")
        # Per-scalp pause (added later): hold off auto-entry/exit on a single scalp (e.g. around an
        # event) without touching the others or the global switch.
        try:
            conn.execute("ALTER TABLE scalps ADD COLUMN paused INTEGER NOT NULL DEFAULT 0")
        except Exception:
            pass
        # Entry-arming guard (added later). Two-tier, protects against a gap firing the entry
        # instantly at open / auto-on:
        #   • arm_state: 'ARMED' | 'INACTIVE' — the snapshot decision, or NULL = not yet evaluated.
        #   • armed_date: the IST date arm_state applies to. A new day (or an auto-trade re-toggle,
        #     which clears both) makes arm_state stale → a fresh snapshot is taken, so yesterday's
        #     decision never carries into today's gap.
        for ddl in (
            "ALTER TABLE scalps ADD COLUMN armed_date TEXT",
            "ALTER TABLE scalps ADD COLUMN arm_state TEXT",
        ):
            try:
                conn.execute(ddl)
            except Exception:
                pass


def auto_enabled() -> bool:
    with _lock, _conn() as conn:
        r = conn.execute("SELECT auto_enabled FROM scalp_settings WHERE id=1").fetchone()
        return bool(r["auto_enabled"]) if r else False


def set_auto_enabled(on: bool):
    with _lock, _conn() as conn:
        conn.execute("UPDATE scalp_settings SET auto_enabled=? WHERE id=1", (1 if on else 0,))


def create_scalp(**f) -> int:
    f["created_at"] = datetime.datetime.utcnow().isoformat()
    cols = ",".join(f)
    with _lock, _conn() as conn:
        cur = conn.execute(f"INSERT INTO scalps ({cols}) VALUES ({','.join('?' for _ in f)})", tuple(f.values()))
        return cur.lastrowid


def get(scalp_id: int) -> dict | None:
    with _lock, _conn() as conn:
        r = conn.execute("SELECT * FROM scalps WHERE id=?", (scalp_id,)).fetchone()
        return dict(r) if r else None


def list_scalps(statuses: tuple = None) -> list[dict]:
    q = "SELECT * FROM scalps"
    vals = ()
    if statuses:
        q += " WHERE status IN (%s)" % ",".join("?" * len(statuses)); vals = statuses
    q += " ORDER BY id DESC"
    with _lock, _conn() as conn:
        return [dict(r) for r in conn.execute(q, vals).fetchall()]


def update(scalp_id: int, **fields):
    if not fields:
        return
    sets = ", ".join(f"{k}=?" for k in fields)
    with _lock, _conn() as conn:
        conn.execute(f"UPDATE scalps SET {sets} WHERE id=?", (*fields.values(), scalp_id))


def clear_arming_waiting():
    """Reset the arming snapshot for every WAITING scalp — called when auto-trade is switched ON so
    each scalp is freshly re-evaluated (arm vs inactive) against the current price rather than
    carrying an earlier decision into a gap."""
    with _lock, _conn() as conn:
        conn.execute("UPDATE scalps SET armed_date=NULL, arm_state=NULL WHERE status='WAITING'")


def delete(scalp_id: int):
    with _lock, _conn() as conn:
        conn.execute("DELETE FROM scalps WHERE id=?", (scalp_id,))


init()
