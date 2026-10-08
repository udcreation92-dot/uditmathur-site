import shutil
import threading
import time
from datetime import date
from pathlib import Path

BASE = Path(__file__).parent
BACKUP_DIR = BASE / "backups"
# Single-file stores holding real financial records — cheap insurance against corruption
# or an accidental delete, since none of this state is recoverable from the brokers.
STATE_FILES = [
    ".strategies.db", ".events.db", ".tbill_watch.db",
    ".tbill_purchases.json", ".rss_feeds.json",
]
KEEP_DAYS = 14
POLL_INTERVAL = 6 * 3600  # re-check a few times a day; copies only happen once per day

_stop_event = threading.Event()
_thread: threading.Thread | None = None


def _run_backup():
    today = date.today().isoformat()
    BACKUP_DIR.mkdir(exist_ok=True)
    for name in STATE_FILES:
        src = BASE / name
        if not src.exists():
            continue
        dest = BACKUP_DIR / f"{today}_{name.lstrip('.')}"
        if not dest.exists():
            shutil.copy2(src, dest)
    # prune: keep only the newest KEEP_DAYS distinct dates
    dates = sorted({p.name.split("_")[0] for p in BACKUP_DIR.iterdir() if p.is_file()})
    for old_date in dates[:-KEEP_DAYS]:
        for p in BACKUP_DIR.glob(f"{old_date}_*"):
            p.unlink(missing_ok=True)


def _loop():
    while not _stop_event.is_set():
        try:
            _run_backup()
        except Exception:
            pass
        _stop_event.wait(POLL_INTERVAL)


def ensure_started():
    global _thread
    if _thread is None or not _thread.is_alive():
        _stop_event.clear()
        _thread = threading.Thread(target=_loop, daemon=True)
        _thread.start()
