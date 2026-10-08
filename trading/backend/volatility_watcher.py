import threading
import time
import volatility_scanner

_lock = threading.Lock()
_state = {
    "running": False,
    "done": 0,
    "total": 0,
    "data": None,
    "previous": None,           # the scan before the current one, for scan-to-scan comparison
    "previous_finished_at": None,
    "started_at": None,
    "finished_at": None,
    "error": None,
}


def _run(strike_count: int):
    def on_progress(done, total):
        with _lock:
            _state["done"] = done
            _state["total"] = total

    try:
        data = volatility_scanner.scan_fo_volatility(strike_count=strike_count, on_progress=on_progress)
        with _lock:
            # Snapshot the just-superseded scan as "previous" so the UI can show each symbol's
            # change in volatility ratio from the last completed scan to this one.
            _state["previous"] = _state["data"]
            _state["previous_finished_at"] = _state["finished_at"]
            _state["data"] = data
            _state["error"] = None
    except Exception as e:
        with _lock:
            _state["error"] = str(e)
    finally:
        with _lock:
            _state["running"] = False
            _state["finished_at"] = time.time()


def start_scan(strike_count: int = 20) -> dict:
    with _lock:
        if _state["running"]:
            return get_status()
        _state["running"] = True
        _state["done"] = 0
        _state["total"] = 0
        _state["started_at"] = time.time()
        # finished_at is intentionally NOT reset here — it still holds the last scan's finish
        # time, which _run snapshots into previous_finished_at when this scan completes. The UI
        # gates the "As of" label on !running, so a stale timestamp isn't shown mid-scan.
        _state["error"] = None
    thread = threading.Thread(target=_run, args=(strike_count,), daemon=True)
    thread.start()
    return get_status()


def get_status() -> dict:
    with _lock:
        return dict(_state)
