import datetime
import threading
import span_downloader

POLL_INTERVAL = 3600  # 1 hour

_stop_event = threading.Event()
_wake_event = threading.Event()
_thread: threading.Thread | None = None

_state = {"last_checked": None, "last_error": None, "log": []}  # log: newest first, capped
LOG_CAP = 50


def _run_cycle():
    try:
        results = span_downloader.check_and_download()
        _state["last_checked"] = datetime.datetime.utcnow().isoformat()
        _state["last_error"] = None
        for r in results:
            if r["status"] in ("downloaded", "error"):
                _state["log"].insert(0, {**r, "checked_at": _state["last_checked"]})
        _state["log"] = _state["log"][:LOG_CAP]
    except Exception as e:
        _state["last_checked"] = datetime.datetime.utcnow().isoformat()
        _state["last_error"] = str(e)


def _loop():
    while not _stop_event.is_set():
        _run_cycle()
        _wake_event.wait(POLL_INTERVAL)
        _wake_event.clear()


def ensure_started():
    global _thread
    if _thread is None or not _thread.is_alive():
        _stop_event.clear()
        _thread = threading.Thread(target=_loop, daemon=True)
        _thread.start()


def check_now():
    """Runs a check synchronously (blocking) and returns immediately with the result,
    also waking the background loop's timer so its next hourly check re-syncs from now."""
    _run_cycle()
    _wake_event.set()
    return get_status()


def get_status() -> dict:
    return {
        "last_checked": _state["last_checked"],
        "last_error": _state["last_error"],
        "log": _state["log"],
        "local_files": span_downloader.list_local_files(),
    }
