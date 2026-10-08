import sqlite3
import datetime
from pathlib import Path
import state_paths

DB_FILE = state_paths.state_path(".strategies.db")


def _conn():
    conn = sqlite3.connect(DB_FILE)
    conn.row_factory = sqlite3.Row
    return conn


def init_db():
    with _conn() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS strategies (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'OPEN',
                notes TEXT
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS allocations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                strategy_id INTEGER NOT NULL REFERENCES strategies(id),
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,     -- BUY or SELL
                qty INTEGER NOT NULL,   -- always positive
                avg_price REAL,
                broker TEXT NOT NULL DEFAULT 'fyers',
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pending_legs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                strategy_id INTEGER NOT NULL REFERENCES strategies(id),
                broker TEXT NOT NULL,
                symbol TEXT NOT NULL,   -- stored format (Fyers for fyers/shoonya, bare for zerodha)
                side TEXT NOT NULL,     -- BUY or SELL
                qty INTEGER NOT NULL,
                price REAL,
                order_id TEXT,
                created_at TEXT NOT NULL
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS pnl_snapshots (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                strategy_id INTEGER NOT NULL REFERENCES strategies(id),
                ts TEXT NOT NULL,
                pl REAL NOT NULL,
                margin REAL,
                roi_pct REAL
            )
        """)
        cols = [r[1] for r in conn.execute("PRAGMA table_info(allocations)")]
        if "broker" not in cols:
            conn.execute("ALTER TABLE allocations ADD COLUMN broker TEXT NOT NULL DEFAULT 'fyers'")
        # Realized-P&L tracking: closed_qty is how much of this leg has been exited, realized_pl
        # the booked P&L on that closed portion. Open qty = qty - closed_qty; a fully-closed leg
        # (closed_qty == qty) contributes only its realized_pl to the strategy total.
        if "closed_qty" not in cols:
            conn.execute("ALTER TABLE allocations ADD COLUMN closed_qty INTEGER NOT NULL DEFAULT 0")
        if "realized_pl" not in cols:
            conn.execute("ALTER TABLE allocations ADD COLUMN realized_pl REAL NOT NULL DEFAULT 0")
        scols = [r[1] for r in conn.execute("PRAGMA table_info(strategies)")]
        if "notes" not in scols:
            conn.execute("ALTER TABLE strategies ADD COLUMN notes TEXT")

        # --- Order-ledger model -------------------------------------------------------------
        # Each strategy is a ledger of ORDERS (money pot), not a reconciled position set. A
        # symbol's net position within a strategy = sum of signed FILLED qty; realized P&L comes
        # from offsetting buys/sells inside the strategy; the broker's live position is never
        # consulted to define a strategy. Once an order is FILLED here it is a permanent position.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS strategy_orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                strategy_id INTEGER NOT NULL REFERENCES strategies(id),
                broker TEXT NOT NULL,
                symbol TEXT NOT NULL,        -- stored format (Fyers for fyers/shoonya, bare for zerodha)
                side TEXT NOT NULL,          -- BUY or SELL
                qty INTEGER NOT NULL,        -- always positive (raw units, lots x lot_size)
                price REAL,                  -- avg fill price (FILLED) or limit/expected price (PENDING)
                order_id TEXT,               -- broker order id (nullable for manual entries)
                status TEXT NOT NULL DEFAULT 'FILLED',  -- PENDING | FILLED | CANCELLED
                source TEXT NOT NULL DEFAULT 'manual',  -- builder | detected | manual | migrated
                created_at TEXT NOT NULL,
                filled_at TEXT
            )
        """)
        # Auto-exit arming: one target per strategy. When the strategy's live exit ROI (total_pl /
        # margin) reaches target_roi_pct, the auto_exit_watcher places limit exit orders at bid/ask.
        conn.execute("""
            CREATE TABLE IF NOT EXISTS auto_exits (
                strategy_id INTEGER PRIMARY KEY REFERENCES strategies(id),
                target_roi_pct REAL NOT NULL,
                status TEXT NOT NULL DEFAULT 'ARMED',   -- ARMED | FIRED
                created_at TEXT NOT NULL,
                fired_at TEXT,
                note TEXT
            )
        """)
        # Spot-LTP trigger (added later): fire when the underlying's LTP crosses target_spot in
        # spot_dir. trigger_type selects which rule the watcher applies.
        for ddl in (
            "ALTER TABLE auto_exits ADD COLUMN trigger_type TEXT NOT NULL DEFAULT 'roi'",  # 'roi' | 'spot'
            "ALTER TABLE auto_exits ADD COLUMN target_spot REAL",
            "ALTER TABLE auto_exits ADD COLUMN spot_dir TEXT",   # 'above' | 'below'
        ):
            try:
                conn.execute(ddl)
            except Exception:
                pass  # column already exists
        _migrate_allocations_to_orders(conn)


def _migrate_allocations_to_orders(conn):
    """One-time: fold the old allocation/pending_leg model into strategy_orders. Each allocation
    becomes a FILLED order at its full qty; any already-closed portion (closed_qty/realized_pl)
    becomes an offsetting FILLED order at a reconstructed price so average-netting reproduces the
    same realized P&L. pending_legs become PENDING orders. Idempotent via the `migrated` source."""
    already = conn.execute(
        "SELECT COUNT(*) AS n FROM strategy_orders WHERE source = 'migrated'"
    ).fetchone()["n"]
    if already:
        return
    allocs = conn.execute("SELECT * FROM allocations").fetchall()
    for a in allocs:
        broker = a["broker"] or "fyers"
        conn.execute(
            "INSERT INTO strategy_orders (strategy_id, broker, symbol, side, qty, price, order_id, "
            "status, source, created_at, filled_at) VALUES (?,?,?,?,?,?,?, 'FILLED', 'migrated', ?, ?)",
            (a["strategy_id"], broker, a["symbol"], a["side"], a["qty"], a["avg_price"], None,
             a["created_at"], a["created_at"]),
        )
        closed = a["closed_qty"] or 0
        realized = a["realized_pl"] or 0
        if closed > 0:
            # Reconstruct the closing order's price from booked realized (money):
            #   SELL leg closed by BUY:  realized = (avg_sell - buy_px) * closed  -> buy_px = avg_sell - realized/closed
            #   BUY  leg closed by SELL: realized = (sell_px - avg_buy) * closed  -> sell_px = avg_buy + realized/closed
            base = a["avg_price"] or 0
            if a["side"] == "SELL":
                close_side, close_px = "BUY", base - (realized / closed)
            else:
                close_side, close_px = "SELL", base + (realized / closed)
            conn.execute(
                "INSERT INTO strategy_orders (strategy_id, broker, symbol, side, qty, price, order_id, "
                "status, source, created_at, filled_at) VALUES (?,?,?,?,?,?,?, 'FILLED', 'migrated', ?, ?)",
                (a["strategy_id"], broker, a["symbol"], close_side, closed, round(close_px, 4), None,
                 a["created_at"], a["created_at"]),
            )
    pendings = conn.execute("SELECT * FROM pending_legs").fetchall()
    for p in pendings:
        conn.execute(
            "INSERT INTO strategy_orders (strategy_id, broker, symbol, side, qty, price, order_id, "
            "status, source, created_at, filled_at) VALUES (?,?,?,?,?,?,?, 'PENDING', 'migrated', ?, NULL)",
            (p["strategy_id"], p["broker"], p["symbol"], p["side"], p["qty"], p["price"],
             p["order_id"], p["created_at"]),
        )


def create_strategy(name: str, notes: str = None) -> int:
    with _conn() as conn:
        cur = conn.execute(
            "INSERT INTO strategies (name, created_at, status, notes) VALUES (?, ?, 'OPEN', ?)",
            (name, datetime.datetime.utcnow().isoformat(), notes),
        )
        return cur.lastrowid


def set_notes(strategy_id: int, notes: str):
    with _conn() as conn:
        conn.execute("UPDATE strategies SET notes = ? WHERE id = ?", (notes, strategy_id))


def delete_strategy(strategy_id: int):
    """Remove a strategy and all its orders/auto-exit — used to clean up a strategy whose builder
    order was entirely rejected (so it never becomes a phantom empty position)."""
    with _conn() as conn:
        conn.execute("DELETE FROM strategy_orders WHERE strategy_id = ?", (strategy_id,))
        conn.execute("DELETE FROM auto_exits WHERE strategy_id = ?", (strategy_id,))
        conn.execute("DELETE FROM strategies WHERE id = ?", (strategy_id,))


def add_pnl_snapshot(strategy_id: int, pl: float, margin: float = None, roi_pct: float = None):
    with _conn() as conn:
        conn.execute(
            "INSERT INTO pnl_snapshots (strategy_id, ts, pl, margin, roi_pct) VALUES (?, ?, ?, ?, ?)",
            (strategy_id, datetime.datetime.utcnow().isoformat(), pl, margin, roi_pct),
        )


def get_pnl_snapshots(strategy_id: int, limit: int = 500) -> list[dict]:
    with _conn() as conn:
        rows = conn.execute(
            "SELECT ts, pl, margin, roi_pct FROM pnl_snapshots WHERE strategy_id = ? ORDER BY ts DESC LIMIT ?",
            (strategy_id, limit),
        ).fetchall()
    return [dict(r) for r in reversed(rows)]


def add_allocation(strategy_id: int, symbol: str, side: str, qty: int, avg_price: float = None, broker: str = "fyers"):
    with _conn() as conn:
        conn.execute(
            "INSERT INTO allocations (strategy_id, symbol, side, qty, avg_price, broker, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (strategy_id, symbol, side, qty, avg_price, broker, datetime.datetime.utcnow().isoformat()),
        )


def list_strategies() -> list[dict]:
    with _conn() as conn:
        strategies = [dict(r) for r in conn.execute(
            "SELECT * FROM strategies ORDER BY created_at DESC"
        )]
        for s in strategies:
            s["legs"] = [dict(r) for r in conn.execute(
                "SELECT * FROM allocations WHERE strategy_id = ? ORDER BY created_at",
                (s["id"],),
            )]
        return strategies


def get_strategy(strategy_id: int) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM strategies WHERE id = ?", (strategy_id,)).fetchone()
        if not row:
            return None
        s = dict(row)
        s["legs"] = [dict(r) for r in conn.execute(
            "SELECT * FROM allocations WHERE strategy_id = ? ORDER BY created_at",
            (strategy_id,),
        )]
        return s


def close_strategy(strategy_id: int):
    with _conn() as conn:
        conn.execute("UPDATE strategies SET status = 'CLOSED' WHERE id = ?", (strategy_id,))


def get_allocation(allocation_id: int) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM allocations WHERE id = ?", (allocation_id,)).fetchone()
        return dict(row) if row else None


def update_allocation(allocation_id: int, strategy_id: int = None, qty: int = None, side: str = None,
                       avg_price: float = None, created_at: str = None):
    """Edit an allocation's quantity/side/entry price/entry date, and/or move it to a different strategy (reassignment)."""
    fields, values = [], []
    if strategy_id is not None:
        fields.append("strategy_id = ?"); values.append(strategy_id)
    if qty is not None:
        fields.append("qty = ?"); values.append(qty)
    if side is not None:
        fields.append("side = ?"); values.append(side)
    if avg_price is not None:
        fields.append("avg_price = ?"); values.append(avg_price)
    if created_at is not None:
        fields.append("created_at = ?"); values.append(created_at)
    if not fields:
        return
    values.append(allocation_id)
    with _conn() as conn:
        conn.execute(f"UPDATE allocations SET {', '.join(fields)} WHERE id = ?", values)


def delete_allocation(allocation_id: int):
    with _conn() as conn:
        conn.execute("DELETE FROM allocations WHERE id = ?", (allocation_id,))


def get_allocated_signed_qty() -> dict[tuple[str, str], int]:
    """Returns {(broker, symbol): net_signed_OPEN_allocated_qty} across all OPEN strategies —
    open qty = qty - closed_qty, so a leg that's been exited (fully or partly) no longer counts
    as still-tracked. Keyed by broker too since the same symbol string can mean different
    instruments across brokers — e.g. Fyers "NSE:INFY-EQ" vs Zerodha "INFY"."""
    with _conn() as conn:
        rows = conn.execute("""
            SELECT a.symbol, a.side, a.qty, a.closed_qty, a.broker
            FROM allocations a
            JOIN strategies s ON s.id = a.strategy_id
            WHERE s.status = 'OPEN'
        """).fetchall()
    totals: dict[tuple[str, str], int] = {}
    for r in rows:
        open_qty = r["qty"] - (r["closed_qty"] or 0)
        signed = open_qty if r["side"] == "BUY" else -open_qty
        key = (r["broker"], r["symbol"])
        totals[key] = totals.get(key, 0) + signed
    return totals


def book_leg_realized(allocation_id: int, closed_qty: int, realized_pl: float):
    """Records that `closed_qty` more units of this leg have been exited, adding `realized_pl` to
    its booked realized. Clamps closed_qty so it never exceeds the leg's original quantity."""
    with _conn() as conn:
        row = conn.execute("SELECT qty, closed_qty FROM allocations WHERE id = ?", (allocation_id,)).fetchone()
        if not row:
            return
        new_closed = min((row["closed_qty"] or 0) + int(closed_qty), row["qty"])
        conn.execute(
            "UPDATE allocations SET closed_qty = ?, realized_pl = realized_pl + ? WHERE id = ?",
            (new_closed, float(realized_pl), allocation_id),
        )


def add_pending_leg(strategy_id: int, broker: str, symbol: str, side: str, qty: int,
                    price: float, order_id: str) -> int:
    with _conn() as conn:
        cur = conn.execute(
            "INSERT INTO pending_legs (strategy_id, broker, symbol, side, qty, price, order_id, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (strategy_id, broker, symbol, side, qty, price, order_id, datetime.datetime.utcnow().isoformat()),
        )
        return cur.lastrowid


def list_pending_legs(strategy_id: int = None) -> list[dict]:
    with _conn() as conn:
        if strategy_id is None:
            rows = conn.execute("SELECT * FROM pending_legs ORDER BY created_at").fetchall()
        else:
            rows = conn.execute("SELECT * FROM pending_legs WHERE strategy_id = ? ORDER BY created_at", (strategy_id,)).fetchall()
    return [dict(r) for r in rows]


def get_pending_leg(pending_id: int) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM pending_legs WHERE id = ?", (pending_id,)).fetchone()
        return dict(row) if row else None


def delete_pending_leg(pending_id: int):
    with _conn() as conn:
        conn.execute("DELETE FROM pending_legs WHERE id = ?", (pending_id,))


def get_symbol_booked_realized(broker: str, symbol: str) -> float:
    """Total realized already booked across OPEN strategies for a (broker, symbol) — used to
    default the next booking to the broker's reported realized minus what's already recorded."""
    with _conn() as conn:
        row = conn.execute("""
            SELECT COALESCE(SUM(a.realized_pl), 0) AS booked
            FROM allocations a JOIN strategies s ON s.id = a.strategy_id
            WHERE s.status = 'OPEN' AND a.broker = ? AND a.symbol = ?
        """, (broker, symbol)).fetchone()
    return row["booked"] or 0.0


# --- strategy_orders CRUD ----------------------------------------------------------------

def add_order(strategy_id: int, broker: str, symbol: str, side: str, qty: int, price: float,
              order_id: str = None, status: str = "FILLED", source: str = "manual") -> int:
    now = datetime.datetime.utcnow().isoformat()
    with _conn() as conn:
        cur = conn.execute(
            "INSERT INTO strategy_orders (strategy_id, broker, symbol, side, qty, price, order_id, "
            "status, source, created_at, filled_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (strategy_id, broker, symbol, side, qty, price, order_id, status, source, now,
             now if status == "FILLED" else None),
        )
        return cur.lastrowid


def list_orders(strategy_id: int = None, statuses: tuple = None) -> list[dict]:
    q = "SELECT * FROM strategy_orders"
    conds, vals = [], []
    if strategy_id is not None:
        conds.append("strategy_id = ?"); vals.append(strategy_id)
    if statuses:
        conds.append("status IN (%s)" % ",".join("?" * len(statuses))); vals.extend(statuses)
    if conds:
        q += " WHERE " + " AND ".join(conds)
    q += " ORDER BY created_at"
    with _conn() as conn:
        return [dict(r) for r in conn.execute(q, vals).fetchall()]


def get_order(order_row_id: int) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM strategy_orders WHERE id = ?", (order_row_id,)).fetchone()
        return dict(row) if row else None


def move_leg_orders(from_strategy_id: int, symbol: str, to_strategy_id: int) -> int:
    """Re-point EVERY order for one symbol (a whole leg — all buys/sells, filled + pending) from one
    strategy to another. Since a leg IS its orders, this carries entry price, realized-via-netting,
    timestamps and pending state with it. Returns how many order rows moved."""
    with _conn() as conn:
        cur = conn.execute(
            "UPDATE strategy_orders SET strategy_id = ? WHERE strategy_id = ? AND symbol = ?",
            (to_strategy_id, from_strategy_id, symbol),
        )
        return cur.rowcount


def move_all_orders(from_strategy_id: int, to_strategy_id: int) -> int:
    """Merge an ENTIRE strategy into another — move all its orders across. Returns rows moved."""
    with _conn() as conn:
        cur = conn.execute(
            "UPDATE strategy_orders SET strategy_id = ? WHERE strategy_id = ?",
            (to_strategy_id, from_strategy_id),
        )
        return cur.rowcount


def update_order(order_row_id: int, **fields):
    allowed = {"strategy_id", "broker", "symbol", "side", "qty", "price", "order_id", "status", "filled_at"}
    sets, vals = [], []
    for k, v in fields.items():
        if k in allowed and v is not None:
            sets.append(f"{k} = ?"); vals.append(v)
    if not sets:
        return
    vals.append(order_row_id)
    with _conn() as conn:
        conn.execute(f"UPDATE strategy_orders SET {', '.join(sets)} WHERE id = ?", vals)


def mark_order_filled(order_row_id: int, qty: int, price: float):
    with _conn() as conn:
        conn.execute(
            "UPDATE strategy_orders SET status='FILLED', qty=?, price=?, filled_at=? WHERE id=?",
            (qty, price, datetime.datetime.utcnow().isoformat(), order_row_id),
        )


def delete_order(order_row_id: int):
    with _conn() as conn:
        conn.execute("DELETE FROM strategy_orders WHERE id = ?", (order_row_id,))


def migrated_symbols() -> set:
    """(broker, symbol) pairs that came in via migration (source='migrated'). These carry NO broker
    order id, so today's broker fills for the same position can't be matched by order id and would
    otherwise resurface in the unassigned inbox as duplicates — exclude them there."""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT DISTINCT broker, symbol FROM strategy_orders WHERE source = 'migrated'"
        ).fetchall()
    return {(r["broker"], r["symbol"]) for r in rows}


# --- auto-exit arming --------------------------------------------------------------------

def arm_auto_exit(strategy_id: int, trigger_type: str = "roi", target_roi_pct: float = None,
                  target_spot: float = None, spot_dir: str = None):
    """Arm (or re-arm) a strategy's auto-exit. trigger_type 'roi' fires when live ROI decays to <=
    target_roi_pct; 'spot' fires when the underlying's LTP crosses target_spot in spot_dir
    ('above'/'below'). Resets status to ARMED."""
    now = datetime.datetime.utcnow().isoformat()
    roi = target_roi_pct if target_roi_pct is not None else 0.0  # column is NOT NULL; unused for spot
    with _conn() as conn:
        conn.execute(
            "INSERT INTO auto_exits (strategy_id, trigger_type, target_roi_pct, target_spot, spot_dir, status, created_at) "
            "VALUES (?, ?, ?, ?, ?, 'ARMED', ?) "
            "ON CONFLICT(strategy_id) DO UPDATE SET trigger_type=excluded.trigger_type, "
            "target_roi_pct=excluded.target_roi_pct, target_spot=excluded.target_spot, "
            "spot_dir=excluded.spot_dir, status='ARMED', created_at=excluded.created_at, fired_at=NULL, note=NULL",
            (strategy_id, trigger_type, roi, target_spot, spot_dir, now),
        )


def disarm_auto_exit(strategy_id: int):
    with _conn() as conn:
        conn.execute("DELETE FROM auto_exits WHERE strategy_id = ?", (strategy_id,))


def get_auto_exit(strategy_id: int) -> dict | None:
    with _conn() as conn:
        row = conn.execute("SELECT * FROM auto_exits WHERE strategy_id = ?", (strategy_id,)).fetchone()
        return dict(row) if row else None


def list_armed_auto_exits() -> list[dict]:
    with _conn() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM auto_exits WHERE status = 'ARMED'")]


def mark_auto_exit_fired(strategy_id: int, note: str = None):
    with _conn() as conn:
        conn.execute(
            "UPDATE auto_exits SET status='FIRED', fired_at=?, note=? WHERE strategy_id=?",
            (datetime.datetime.utcnow().isoformat(), note, strategy_id),
        )


def known_order_ids() -> set:
    """(broker, order_id) pairs already recorded in any strategy (any status) — so a broker order
    already filed against a strategy is never offered again in the unassigned-orders inbox."""
    with _conn() as conn:
        rows = conn.execute(
            "SELECT broker, order_id FROM strategy_orders WHERE order_id IS NOT NULL AND order_id != ''"
        ).fetchall()
    return {(r["broker"], str(r["order_id"])) for r in rows}


init_db()
