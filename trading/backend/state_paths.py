"""Central location for the backend's small state / cache / db files, kept OUTSIDE the
OneDrive-synced project folder.

Why: these files are written frequently. Living inside the OneDrive-synced project directory,
every write made OneDrive re-upload them (constant disk/CPU churn that got worse as files grew),
and — worse — OneDrive occasionally served a stale copy or locked a file mid-write, which silently
dropped writes (e.g. the news-digest cursor failing to advance). Moving them to a local, un-synced
directory removes both problems.

Override the location with the TRADING_STATE_DIR env var. On first access each file is migrated
from its old in-project location so nothing (tokens, cursors, caches, sqlite DBs) is lost."""
import os
import shutil
from pathlib import Path

_LEGACY_DIR = Path(__file__).parent   # old location: the OneDrive-synced backend folder


def _default_dir() -> Path:
    # IMPORTANT: do NOT key off %LOCALAPPDATA%. The backend is launched by the "TradingBackend"
    # scheduled task with highest privileges "at logon"; in that context %LOCALAPPDATA% can be
    # empty or point at a different profile, so it resolved to an unwritable/other directory and
    # the backend silently stopped persisting state AND lost the Telegram chat_ids (empty state) —
    # i.e. news died. Use a FIXED, absolute, non-OneDrive path the task can always write, derived
    # from the profile ROOT (%USERPROFILE% is reliable for an at-logon task where LOCALAPPDATA is
    # not), with a hard-coded fallback for this box.
    for base in (os.environ.get("USERPROFILE"), r"C:\Users\udcre"):
        if base and os.path.isdir(base):
            return Path(base) / "bin" / "trading-state"
    return Path(os.environ.get("TEMP") or str(Path.home())) / "trading-state"


STATE_DIR = Path(os.environ.get("TRADING_STATE_DIR") or _default_dir())
try:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    # Prove writability now; if this raises we fall back rather than silently failing every write.
    _probe = STATE_DIR / ".write_probe"
    _probe.write_text("ok")
    _probe.unlink()
except Exception:
    # Fall back to the legacy dir if the chosen dir can't be created/written, so the backend still runs.
    STATE_DIR = _LEGACY_DIR


def state_path(name: str) -> Path:
    """Return the local-dir path for a state file, migrating an existing copy out of the old
    OneDrive location on first use. For sqlite DBs the sidecar -wal/-shm files are migrated too."""
    dest = STATE_DIR / name
    if STATE_DIR != _LEGACY_DIR and not dest.exists():
        legacy = _LEGACY_DIR / name
        if legacy.exists():
            for suffix in ("", "-wal", "-shm"):
                src = _LEGACY_DIR / (name + suffix)
                if src.exists():
                    try:
                        shutil.copy2(src, STATE_DIR / (name + suffix))
                    except Exception:
                        pass
    return dest
