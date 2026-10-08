import os
import json
import threading
import time
from datetime import date, datetime, timezone
from pathlib import Path
import requests
import state_paths

GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
DEFAULT_MODEL = "gemini-2.5-flash"

# The free tier for this key is capped at 5 requests/min AND 20 requests/DAY for gemini-2.5-flash
# — both observed directly from the API's 429 responses (RPM and RPD quota violations), not
# guesses. The daily cap is the binding one for a live news feed; once it's spent, every further
# call would just be a wasted 429 round-trip, so a local budget tracker refuses calls before
# making them rather than discovering the day's quota is gone one HTTP request at a time.
_RATE_LIMIT_PER_MIN = 5
_DAILY_LIMIT = int(os.environ.get("GEMINI_DAILY_REQUEST_LIMIT", "20"))
_BUDGET_FILE = state_paths.state_path(".gemini_daily_budget.json")

_rate_lock = threading.Lock()
_call_times: list[float] = []
_budget_lock = threading.Lock()
_budget = {"date": None, "count": 0}


def _today() -> str:
    return datetime.now(timezone.utc).date().isoformat()


def _load_budget():
    if _budget["date"] == _today():
        return
    if _BUDGET_FILE.exists():
        try:
            saved = json.loads(_BUDGET_FILE.read_text())
            if saved.get("date") == _today():
                _budget.update(saved)
                return
        except Exception:
            pass
    _budget["date"] = _today()
    _budget["count"] = 0


def _consume_budget() -> bool:
    """Returns False without making a network call if today's request budget is exhausted."""
    with _budget_lock:
        _load_budget()
        if _budget["count"] >= _DAILY_LIMIT:
            return False
        _budget["count"] += 1
        try:
            _BUDGET_FILE.write_text(json.dumps(_budget))
        except Exception:
            pass
        return True


def _wait_for_slot():
    while True:
        with _rate_lock:
            now = time.time()
            while _call_times and now - _call_times[0] > 60:
                _call_times.pop(0)
            if len(_call_times) < _RATE_LIMIT_PER_MIN:
                _call_times.append(now)
                return
            sleep_for = 60 - (now - _call_times[0]) + 0.5
        time.sleep(max(sleep_for, 0.1))


def _api_key() -> str | None:
    return os.environ.get("GEMINI_API_KEY")


def generate_json(prompt: str, schema: dict, model: str = DEFAULT_MODEL, timeout: int = 30):
    """Calls Gemini with structured-output constraints (responseSchema) so the reply is
    guaranteed valid JSON matching `schema`, rather than free text that needs fragile parsing.
    Returns the parsed JSON, or None if the key is missing, today's request budget is spent, or
    the call fails — callers should treat AI enrichment as best-effort and fall back to the
    un-enriched item, and must NOT cache a None result as if it were a real classification (see
    news_intel.py)."""
    api_key = _api_key()
    if not api_key:
        return None
    if not _consume_budget():
        return None
    _wait_for_slot()
    url = GEMINI_API_URL.format(model=model)
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {
            "responseMimeType": "application/json",
            "responseSchema": schema,
            "temperature": 0.1,
        },
    }
    try:
        resp = requests.post(
            url, json=body, timeout=timeout,
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        )
        resp.raise_for_status()
        data = resp.json()
        text = data["candidates"][0]["content"]["parts"][0]["text"]
        return json.loads(text)
    except Exception:
        return None


def generate_text(prompt: str, system: str = None, model: str = DEFAULT_MODEL, timeout: int = 30):
    """Plain free-text generation (no JSON constraint) — used as the fallback for the ask/chat
    assistant when no DeepSeek key is set. Subject to the same daily/RPM budget as generate_json."""
    api_key = _api_key()
    if not api_key:
        return None
    if not _consume_budget():
        return None
    _wait_for_slot()
    url = GEMINI_API_URL.format(model=model)
    body = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3},
    }
    if system:
        body["systemInstruction"] = {"parts": [{"text": system}]}
    try:
        resp = requests.post(
            url, json=body, timeout=timeout,
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        )
        resp.raise_for_status()
        return resp.json()["candidates"][0]["content"]["parts"][0]["text"]
    except Exception:
        return None


def get_budget_status() -> dict:
    with _budget_lock:
        _load_budget()
        return {"date": _budget["date"], "used": _budget["count"], "limit": _DAILY_LIMIT}
