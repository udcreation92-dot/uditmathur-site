import sqlite3
import datetime
import threading
from pathlib import Path
import state_paths

DB_FILE = state_paths.state_path(".events.db")
_lock = threading.Lock()


def _conn():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts TEXT NOT NULL,
                type TEXT NOT NULL,        -- auto_buy | news_match | expiry_soon | ...
                title TEXT NOT NULL,
                body TEXT,
                dedupe_key TEXT UNIQUE,    -- prevents the same real-world event firing repeatedly
                seen INTEGER NOT NULL DEFAULT 0
            )
        """)


def add_event(type_: str, title: str, body: str = "", dedupe_key: str = None) -> bool:
    """Returns True if inserted, False if suppressed as a duplicate."""
    with _lock, _conn() as conn:
        try:
            conn.execute(
                "INSERT INTO events (ts, type, title, body, dedupe_key) VALUES (?, ?, ?, ?, ?)",
                (datetime.datetime.utcnow().isoformat(), type_, title, body, dedupe_key),
            )
            return True
        except sqlite3.IntegrityError:
            return False


def get_unseen() -> list[dict]:
    with _conn() as conn:
        rows = conn.execute("SELECT id, ts, type, title, body FROM events WHERE seen = 0 ORDER BY ts").fetchall()
    return [dict(r) for r in rows]


def mark_seen(ids: list[int]):
    if not ids:
        return
    with _lock, _conn() as conn:
        conn.executemany("UPDATE events SET seen = 1 WHERE id = ?", [(i,) for i in ids])


def recent(limit: int = 50) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT id, ts, type, title, body, seen FROM events ORDER BY ts DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


init_db()
