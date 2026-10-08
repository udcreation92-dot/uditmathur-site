"""Strategy registry — named trading strategies the AI can look up and run. Each strategy is an
editable JSON file in ./strategies/ (git-tracked), so new styles are added by dropping in a file,
no code change. The AI reads a strategy's `how_to_run` / `roll_rule` / `guardrails` and orchestrates
it via the ROI-solver + (later) order tools. Read-only here."""
import json
from pathlib import Path

_DIR = Path(__file__).parent / "strategies"


def list_all() -> list[dict]:
    """Lightweight index: name/title/status/summary for every strategy file."""
    out = []
    for f in sorted(_DIR.glob("*.json")):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        out.append({k: d.get(k) for k in ("name", "title", "status", "summary")})
    return out


def get(name: str) -> dict | None:
    """Full strategy definition, or None if unknown. Name is the file stem (no path traversal)."""
    safe = "".join(c for c in name if c.isalnum() or c in ("_", "-"))
    f = _DIR / f"{safe}.json"
    if not f.exists():
        return None
    return json.loads(f.read_text(encoding="utf-8"))
