import sqlite3
import datetime
from pathlib import Path
import state_paths

DB_FILE = state_paths.state_path(".tbill_watch.db")

MAX_ACTIVE_WATCHES = 2  # run at most this many independent auto-buys at once


def _conn():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _conn() as conn:
        # Multi-watch table: each row is one independent auto-buy with its own target/budget/broker.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tbill_watches (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                label TEXT,
                target_roi REAL NOT NULL,
                budget_total REAL NOT NULL,
                budget_remaining REAL NOT NULL,
                active INTEGER NOT NULL DEFAULT 0,
                broker TEXT NOT NULL DEFAULT 'fyers',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS tbill_watch_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                watch_id INTEGER,
                symbol TEXT NOT NULL,
                qty INTEGER NOT NULL,
                price REAL NOT NULL,
                cost REAL NOT NULL,
                order_id TEXT,
                status TEXT NOT NULL,      -- placed | traded | cancelled | rejected | error | skipped
                message TEXT,
                created_at TEXT NOT NULL,
                broker TEXT,               -- placing broker, so reconciliation hits the right order book
                filled_qty INTEGER,        -- resolved from the broker order book after placement
                avg_price REAL,
                resolved_at TEXT
            )
        """)
        # Migration: add watch_id to a pre-existing log table.
        log_cols = {r["name"] for r in conn.execute("PRAGMA table_info(tbill_watch_log)")}
        if "watch_id" not in log_cols:
            conn.execute("ALTER TABLE tbill_watch_log ADD COLUMN watch_id INTEGER")
        # Migration: add fill-resolution columns to a pre-existing log table.
        for col, decl in (("broker", "TEXT"), ("filled_qty", "INTEGER"), ("avg_price", "REAL"), ("resolved_at", "TEXT")):
            if col not in log_cols:
                conn.execute(f"ALTER TABLE tbill_watch_log ADD COLUMN {col} {decl}")

        # Migration: fold the old single-row `tbill_watch` table into the new multi-watch table,
        # once, so an in-progress watch survives the upgrade.
        has_old = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='tbill_watch'"
        ).fetchone()
        migrated = conn.execute("SELECT COUNT(*) c FROM tbill_watches").fetchone()["c"]
        if has_old and migrated == 0:
            old = conn.execute("SELECT * FROM tbill_watch WHERE id = 1").fetchone()
            if old:
                now = datetime.datetime.utcnow().isoformat()
                conn.execute("""
                    INSERT INTO tbill_watches
                        (label, target_roi, budget_total, budget_remaining, active, broker, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, ("Watch 1", old["target_roi"], old["budget_total"], old["budget_remaining"],
                      old["active"], old["broker"] if "broker" in old.keys() else "fyers",
                      old["created_at"], now))


def list_watches(active_only: bool = False) -> list[dict]:
    with _conn() as conn:
        q = "SELECT * FROM tbill_watches"
        if active_only:
            q += " WHERE active = 1"
        q += " ORDER BY id"
        return [dict(r) for r in conn.execute(q).fetchall()]


def get_watch(watch_id: int) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM tbill_watches WHERE id = ?", (watch_id,)).fetchone()
        return dict(row) if row else None


def active_count() -> int:
    with _conn() as conn:
        return conn.execute("SELECT COUNT(*) c FROM tbill_watches WHERE active = 1").fetchone()["c"]


def create_watch(target_roi: float, budget_total: float, broker: str = "fyers", label: str = None) -> dict:
    now = datetime.datetime.utcnow().isoformat()
    with _conn() as conn:
        cur = conn.execute("""
            INSERT INTO tbill_watches
                (label, target_roi, budget_total, budget_remaining, active, broker, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        """, (label, target_roi, budget_total, budget_total, broker, now, now))
        row = conn.execute("SELECT * FROM tbill_watches WHERE id = ?", (cur.lastrowid,)).fetchone()
        return dict(row)


def stop_watch(watch_id: int):
    with _conn() as conn:
        conn.execute(
            "UPDATE tbill_watches SET active = 0, updated_at = ? WHERE id = ?",
            (datetime.datetime.utcnow().isoformat(), watch_id),
        )


def delete_watch(watch_id: int):
    with _conn() as conn:
        conn.execute("DELETE FROM tbill_watches WHERE id = ?", (watch_id,))


def deduct_budget(watch_id: int, amount: float):
    with _conn() as conn:
        conn.execute(
            "UPDATE tbill_watches SET budget_remaining = budget_remaining - ?, updated_at = ? WHERE id = ?",
            (amount, datetime.datetime.utcnow().isoformat(), watch_id),
        )


def log_buy(symbol: str, qty: int, price: float, cost: float, order_id: str | None,
            status: str, message: str = "", watch_id: int | None = None,
            broker: str | None = None):
    with _conn() as conn:
        conn.execute("""
            INSERT INTO tbill_watch_log
                (watch_id, symbol, qty, price, cost, order_id, status, message, created_at, broker)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (watch_id, symbol, qty, price, cost, order_id, status, message,
              datetime.datetime.utcnow().isoformat(), broker))


def list_unresolved_placed(since_iso: str | None = None) -> list[dict]:
    """Placed orders that carry a broker order id but haven't reached a terminal state yet
    (still 'placed'). These are the rows the reconciler re-checks against the broker order book.
    Scoped to `since_iso` (naive-UTC cutoff) so ancient orders whose books are gone aren't chased."""
    with _conn() as conn:
        q = ("SELECT * FROM tbill_watch_log WHERE status = 'placed' "
             "AND order_id IS NOT NULL AND order_id != ''")
        params: list = []
        if since_iso:
            q += " AND created_at >= ?"
            params.append(since_iso)
        return [dict(r) for r in conn.execute(q, params).fetchall()]


def resolve_log(log_id: int, status: str, filled_qty: int | None = None,
                avg_price: float | None = None, message: str | None = None):
    """Move a 'placed' row to its terminal state (traded | cancelled | rejected) once the broker
    order book reports it, recording the real fill qty/price."""
    with _conn() as conn:
        sets = ["status = ?", "resolved_at = ?"]
        params: list = [status, datetime.datetime.utcnow().isoformat()]
        if filled_qty is not None:
            sets.append("filled_qty = ?"); params.append(filled_qty)
        if avg_price is not None:
            sets.append("avg_price = ?"); params.append(avg_price)
        if message is not None:
            sets.append("message = ?"); params.append(message)
        params.append(log_id)
        conn.execute(f"UPDATE tbill_watch_log SET {', '.join(sets)} WHERE id = ?", params)


def get_log(limit: int = 50) -> list[dict]:
    """Only the current (local) day's activity — older history stays in the DB but stale
    failures/orders from previous sessions don't clutter the activity panel. created_at is
    stored as naive UTC, so local midnight is converted to UTC before comparing."""
    local_midnight = datetime.datetime.now().astimezone().replace(hour=0, minute=0, second=0, microsecond=0)
    cutoff = local_midnight.astimezone(datetime.timezone.utc).replace(tzinfo=None).isoformat()
    with _conn() as conn:
        rows = conn.execute(
            "SELECT * FROM tbill_watch_log WHERE created_at >= ? ORDER BY id DESC LIMIT ?",
            (cutoff, limit),
        ).fetchall()
        return [dict(r) for r in rows]


init_db()
