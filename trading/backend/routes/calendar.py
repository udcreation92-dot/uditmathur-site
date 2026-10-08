from typing import List, Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import event_calendar
import corporate_actions
import macro_suggestions
import macro_scan
import events_db

router = APIRouter(prefix="/calendar", tags=["calendar"])


@router.get("/corporate-actions")
def corporate_actions_upcoming(days: int = 30, fo_only: bool = False):
    """Upcoming dividends / splits / bonuses / buybacks by EX-DATE."""
    return corporate_actions.get_upcoming(days=days, fo_only=fo_only)


@router.get("/status")
def status():
    return event_calendar.get_status()


@router.post("/check-now")
def check_now():
    return event_calendar.check_now()


@router.get("/upcoming")
def upcoming(days: int = 14, fo_only: bool = True):
    return event_calendar.get_upcoming(days=days, fo_only=fo_only)


@router.get("/macro")
def macro():
    return event_calendar.get_macro_events()


class MacroEventRequest(BaseModel):
    name: str
    date: str          # YYYY-MM-DD
    category: str = "Macro"


@router.post("/macro")
def add_macro(req: MacroEventRequest):
    if not req.name.strip():
        raise HTTPException(400, "name is required")
    try:
        event_calendar.add_macro_event(req.name.strip(), req.date, req.category.strip() or "Macro")
    except ValueError:
        raise HTTPException(400, "date must be YYYY-MM-DD")
    return event_calendar.get_macro_events()


@router.delete("/macro")
def delete_macro(name: str, date: str):
    event_calendar.delete_macro_event(name, date)
    return event_calendar.get_macro_events()


# ---- AI-detected macro-event suggestions (await user approval) ----
@router.get("/macro-suggestions")
def macro_suggestions_list(status: str = "pending"):
    return macro_suggestions.list_suggestions(status)


@router.post("/macro-suggestions/{suggestion_id}/approve")
def approve_macro_suggestion(suggestion_id: int):
    s = macro_suggestions.approve(suggestion_id)
    if not s:
        raise HTTPException(404, "Suggestion not found")
    return {
        "approved": s,
        "pending": macro_suggestions.list_suggestions("pending"),
        "macro": event_calendar.get_macro_events(),
    }


@router.post("/macro-suggestions/{suggestion_id}/reject")
def reject_macro_suggestion(suggestion_id: int):
    s = macro_suggestions.reject(suggestion_id)
    if not s:
        raise HTTPException(404, "Suggestion not found")
    return {"rejected": s, "pending": macro_suggestions.list_suggestions("pending")}


# ---- Macro-event detection by the local Claude routine (replaces DeepSeek macro tagging) ----
@router.get("/macro-scan")
def macro_scan_feed():
    """Headlines published since the scan cursor, for the local Claude routine to inspect for
    scheduled macro / geopolitical events. Idempotent — reading does NOT advance the cursor."""
    return macro_scan.headlines_since_cursor()


class IngestEvent(BaseModel):
    name: str
    date: str                      # YYYY-MM-DD
    category: str = "Macro"        # RBI | Inflation | Global | Budget | Geopolitical | Macro
    source_title: str = ""
    source_link: str = ""


class MacroIngestRequest(BaseModel):
    events: List[IngestEvent] = []
    scanned_through: Optional[str] = None  # ISO ts the routine processed up to; advances the cursor


@router.post("/macro-ingest")
def macro_ingest(req: MacroIngestRequest):
    """Write Claude-detected events as pending calendar suggestions (dedup handled by
    add_suggestion), fire a Live-Alert per new one, then advance the scan cursor. Advancing only
    here — on a successful POST — means a failed/skipped routine run just re-scans next time."""
    added, skipped = 0, 0
    for ev in req.events:
        ok = macro_suggestions.add_suggestion(
            ev.name, ev.date, ev.category or "Macro",
            source_title=ev.source_title, source_link=ev.source_link,
        )
        if ok:
            added += 1
            try:
                events_db.add_event(
                    "macro_suggestion",
                    f"Possible event: {ev.name} ({ev.date})",
                    body=f"Detected in news{': ' + ev.source_title if ev.source_title else ''}. "
                         "Approve or reject it in the Calendar tab.",
                    dedupe_key=f"macro_suggestion:{ev.name.lower()}:{ev.date}",
                )
            except Exception:
                pass
        else:
            skipped += 1

    if req.scanned_through:
        macro_scan.set_cursor(req.scanned_through)

    return {"added": added, "skipped": skipped,
            "pending": macro_suggestions.list_suggestions("pending")}
