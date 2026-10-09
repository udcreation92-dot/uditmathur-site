"""Fyers live market-data WebSocket — the low-latency price feed for the intraday system.

Instead of REST-polling quotes every 1-2s (~270ms/call), this keeps a persistent Fyers data socket
open and maintains an in-memory cache of the latest tick per symbol (ltp / bid / ask). Reads are
instant (dict lookup, no broker round-trip), and updates arrive in ~10-50ms as the market moves.

Singleton, thread-safe. The socket needs the Fyers access token (post-login), so it starts lazily:
`ensure_started()` connects if a token exists (retried by a startup hook), and any subscribe call
kicks it off. The SDK handles auto-reconnect; on (re)connect we replay the tracked subscription set.
"""
import json
import threading
import time

from fyers_apiv3.FyersWebsocket import data_ws
from fyers_client import client as _fyers_client, TOKEN_FILE

_lock = threading.Lock()
_cache: dict[str, dict] = {}      # symbol -> {ltp, bid, ask, ts (epoch), ...}
_subscribed: set[str] = set()     # symbols we want streamed (replayed on reconnect)
_socket: "data_ws.FyersDataSocket | None" = None
_connected = False
_last_error: str | None = None
_started = False
_token_used: str | None = None      # the token the CURRENT socket was built with (for refresh detection)
_last_restart = 0.0                 # cooldown so the watchdog can't thrash-restart
_watchdog_started = False

# Per-tick listeners: called (outside the cache lock) with the ticked symbol on every update, so
# consumers like the T-Bill auto-buy can react the instant an ask moves instead of polling. Keep
# callbacks trivial and non-blocking (they run on the socket thread) — e.g. set a wake event.
_tick_listeners: list = []


def add_tick_listener(fn):
    """Register fn(symbol) to be invoked on every incoming tick. Idempotent."""
    if fn not in _tick_listeners:
        _tick_listeners.append(fn)


def _access_token() -> str | None:
    """Fyers socket token = 'APP_ID:JWT'. Reuses the same cached token the REST client uses."""
    try:
        tok = json.loads(TOKEN_FILE.read_text())["access_token"]
        return f"{_fyers_client.client_id}:{tok}"
    except Exception:
        return None


def _on_message(msg: dict):
    # SymbolUpdate ticks carry symbol/ltp/bid_price/ask_price. Ignore SDK status frames.
    if not isinstance(msg, dict):
        return
    sym = msg.get("symbol")
    if not sym or "ltp" not in msg:
        return
    with _lock:
        cur = _cache.get(sym, {})
        cur.update(
            ltp=msg.get("ltp"),
            bid=msg.get("bid_price", cur.get("bid")),
            ask=msg.get("ask_price", cur.get("ask")),
            bid_qty=msg.get("bid_size", cur.get("bid_qty")),
            ask_qty=msg.get("ask_size", cur.get("ask_qty")),
            prev_close=msg.get("prev_close_price", cur.get("prev_close")),
            open=msg.get("open_price", cur.get("open")),
            high=msg.get("high_price", cur.get("high")),
            low=msg.get("low_price", cur.get("low")),
            ts=time.time(),
        )
        _cache[sym] = cur

    # Notify listeners OUTSIDE the lock so a slow/reentrant callback can't stall the socket thread.
    for fn in _tick_listeners:
        try:
            fn(sym)
        except Exception:
            pass


def quote_shaped(symbol: str, max_age: float = 15.0) -> dict | None:
    """A fresh cached tick rebuilt into the Fyers REST /quotes response shape (d[0].v with lp/ch/chp/
    bid/ask/…), so callers of that endpoint can be served from the socket transparently. None if not
    fresh in cache."""
    q = fresh_quotes([symbol], max_age).get(symbol)
    if not q or q.get("ltp") is None:
        return None
    lp, pc = q["ltp"], q.get("prev_close")
    ch = round(lp - pc, 2) if pc else None
    chp = round((ch / pc) * 100, 2) if pc else None
    v = {"lp": lp, "bid": q.get("bid"), "ask": q.get("ask"), "prev_close_price": pc,
         "ch": ch, "chp": chp, "open_price": q.get("open"),
         "high_price": q.get("high"), "low_price": q.get("low")}
    return {"s": "ok", "d": [{"n": symbol, "s": "ok", "v": v}]}


def _on_connect():
    global _connected, _last_error
    _connected = True
    _last_error = None
    # Replay the tracked subscriptions on (re)connect so a drop self-heals.
    with _lock:
        syms = sorted(_subscribed)
    if syms and _socket is not None:
        try:
            _socket.subscribe(symbols=syms, data_type="SymbolUpdate")
        except Exception as e:
            _last_error = f"resubscribe failed: {e}"


def _on_error(msg):
    global _last_error
    _last_error = str(msg)


def _on_close(msg):
    global _connected
    _connected = False


def _run_socket():
    """Construct AND connect the socket entirely in this background thread. The FyersDataSocket
    constructor and connect() can each make blocking network calls, so they must NEVER run on the
    request/startup path — otherwise a slow/refused Fyers handshake would wedge the whole backend."""
    global _socket, _started, _last_error, _token_used
    token = _access_token()
    if not token:
        with _lock:
            _started = False
        return
    try:
        sock = data_ws.FyersDataSocket(
            access_token=token, litemode=False, reconnect=True,
            on_message=_on_message, on_connect=_on_connect,
            on_error=_on_error, on_close=_on_close,
        )
        with _lock:
            _socket = sock
            _token_used = token   # remember which token this socket runs on, for refresh detection
        sock.connect()  # blocks in THIS thread only (SDK runs its keep-alive loop here)
    except Exception as e:
        _last_error = str(e)
        with _lock:
            _started = False  # allow a later call to retry


def ensure_started() -> bool:
    """Kick off the socket in the background if a token exists. Returns immediately — NEVER blocks
    the caller (startup hook / request handler). No-op once started."""
    global _started
    _ensure_watchdog()   # self-heals a token refresh / dead feed (daily broker re-login breaks the SDK's own reconnect)
    with _lock:
        if _started:
            return True
        if not _access_token():
            return False  # not logged in yet — a later call (startup retry / subscribe) will connect
        _started = True
    threading.Thread(target=_run_socket, daemon=True).start()
    return True


def _close_socket():
    """Tear down the current socket so a fresh one can be built with a new token. The SDK's own
    reconnect reuses the token it was constructed with, so a token refresh needs a full rebuild."""
    global _socket, _connected
    with _lock:
        sock, _socket = _socket, None
        _connected = False
    if sock is not None:
        try:
            if hasattr(sock, "keep_running"):
                sock.keep_running = False   # stop the SDK's auto-reconnect loop
        except Exception:
            pass
        try:
            sock.close_connection()
        except Exception:
            pass


def restart(reason: str = "") -> dict:
    """Rebuild the socket with the CURRENT access token and replay subscriptions. Call this after the
    daily broker re-login refreshes the Fyers token — otherwise the SDK keeps reconnecting with the
    stale token ('Please provide valid token') and the whole live feed silently dies at market open."""
    global _started, _last_error, _last_restart
    _close_socket()
    with _lock:
        _started = False
        _last_restart = time.time()
        _last_error = f"restarted: {reason}" if reason else "restarted"
    ensure_started()
    return status()


def _is_market_hours() -> bool:
    import datetime
    ist = datetime.datetime.utcnow() + datetime.timedelta(hours=5, minutes=30)
    if ist.weekday() >= 5:   # Sat/Sun
        return False
    mins = ist.hour * 60 + ist.minute
    return 9 * 60 + 15 <= mins <= 15 * 60 + 30


def _watchdog():
    """Every 45s: if the on-disk token no longer matches the socket's token (daily re-login), or the
    feed has gone stale/invalid-token during market hours, rebuild the socket with the fresh token."""
    while True:
        time.sleep(45)
        try:
            cur = _access_token()
            if cur and _token_used and cur != _token_used:
                restart("token refreshed")
                continue
            if not _is_market_hours() or not _started:
                continue
            if time.time() - _last_restart < 120:   # cooldown
                continue
            st = status()
            stale = (st["newest_tick_age_s"] is not None and st["newest_tick_age_s"] > 90
                     and len(_subscribed) > 0)
            bad_token = st.get("last_error") and "valid token" in str(st["last_error"]).lower()
            if stale or bad_token:
                restart("stale feed" if stale else "invalid token")
        except Exception:
            pass


def _ensure_watchdog():
    global _watchdog_started
    with _lock:
        if _watchdog_started:
            return
        _watchdog_started = True
    threading.Thread(target=_watchdog, daemon=True).start()


def subscribe(symbols: list[str]) -> dict:
    """Add symbols to the live feed (idempotent). Non-blocking: the actual socket subscribe (which
    does a symbol→token HTTP conversion inside the SDK) is fired on a background thread so it can
    never slow the caller (compute_strategies runs this every poll)."""
    if not symbols:
        return status()
    ensure_started()
    with _lock:
        new = [s for s in symbols if s not in _subscribed]
        _subscribed.update(symbols)
    if new and _socket is not None and _connected:
        def _do():
            try:
                _socket.subscribe(symbols=new, data_type="SymbolUpdate")
            except Exception as e:
                globals()["_last_error"] = str(e)
        threading.Thread(target=_do, daemon=True).start()
    return status()


def unsubscribe(symbols: list[str]) -> dict:
    with _lock:
        drop = [s for s in symbols if s in _subscribed]
        _subscribed.difference_update(symbols)
        for s in symbols:
            _cache.pop(s, None)
    if drop and _socket is not None and _connected:
        try:
            _socket.unsubscribe(symbols=drop, data_type="SymbolUpdate")
        except Exception:
            pass
    return status()


def get_quotes(symbols: list[str]) -> dict[str, dict]:
    """Latest cached tick per symbol — instant, no broker call. Missing symbols are omitted."""
    with _lock:
        return {s: dict(_cache[s]) for s in symbols if s in _cache}


def fresh_quotes(symbols: list[str], max_age: float = 15.0) -> dict[str, dict]:
    """Cached ticks that are no older than max_age seconds — so a disconnected/stale socket never
    serves old prices to the existing features; anything stale/missing is left for the REST fallback."""
    now = time.time()
    with _lock:
        return {s: dict(_cache[s]) for s in symbols
                if s in _cache and _cache[s].get("ts") and (now - _cache[s]["ts"]) <= max_age}


def status() -> dict:
    with _lock:
        now = time.time()
        freshest = min((now - v["ts"] for v in _cache.values() if v.get("ts")), default=None)
        return {
            "started": _started, "connected": _connected,
            "subscribed": len(_subscribed), "cached": len(_cache),
            "newest_tick_age_s": round(freshest, 3) if freshest is not None else None,
            "last_error": _last_error,
        }
