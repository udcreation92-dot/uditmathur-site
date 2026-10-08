import re
from typing import List, Optional
from fastapi import APIRouter
from pydantic import BaseModel
import news_digest
import telegram_news
import macro_suggestions
import events_db
import rss_watcher

router = APIRouter(prefix="/news", tags=["news"])


# ── code-only digest (no Claude) ─────────────────────────────────────
# Lightweight keyword categorizer — a free stand-in for the AI's category tag. First match wins.
_CATEGORY_KEYWORDS = [
    ("Economy", ["inflation", "cpi", "wpi", "gdp", " rbi", "fed ", "repo rate", "interest rate",
                 "monetary policy", "fiscal", "budget", "gst", "deficit", "unemployment", "imf"]),
    ("Market", ["sensex", "nifty", "stock", "share", "shares", "index", "ipo", "commodity",
                "gold", "crude", "oil price", "rupee", "currency", "bond", "yield", "fii", "fpi",
                "market", "bourses", "equities"]),
    ("Corporate", ["earnings", "profit", "revenue", "results", " q1", " q2", " q3", " q4",
                   "merger", "acquisition", "ceo", "stake", "dividend", "buyback"]),
    ("Geopolitical", ["war", "ukraine", "russia", "china", "israel", "gaza", "trump", "tariff",
                      "election", "summit", "sanction", "diplomat", "border"]),
]


def _plain_category(text: str) -> str:
    t = (text or "").lower()
    for cat, kws in _CATEGORY_KEYWORDS:
        if any(k in t for k in kws):
            return cat
    return "Other"


def _plain_detail(summary: str) -> str:
    """Strip HTML and clip the RSS excerpt to a short one-liner for the detail line."""
    s = re.sub(r"<[^>]+>", "", summary or "")
    s = " ".join(s.split())
    return (s[:220] + "…") if len(s) > 220 else s


def _to_english(text: str) -> str:
    """Translate to English if the text is still in Hindi. Belt-and-suspenders on top of the poll
    cycle's translation: catches Hindi from feeds not in HINDI_FEED_NAMES, or cycles where the
    translator failed — so NO Hindi headline reaches Telegram. Uses the free Google endpoint
    (cached), so it costs nothing against the Claude/Gemini limits."""
    if not text or not rss_watcher._is_hindi(text):
        return text
    try:
        en = rss_watcher._translate_to_english(text)
        return en if en and en != text else text
    except Exception:
        return text


@router.post("/digest-run-plain")
def digest_run_plain():
    """Code-only digest: no Claude. Takes the already code-deduped headlines from digest_scan
    (window re-reports + exact-title batch dupes removed), tags each with a keyword category, uses
    the RSS excerpt as the detail line, pushes to Telegram, records covered + dedup stats, and
    advances the cursor. Each headline is its own message (no cross-outlet semantic merging — that
    was the only part that needed the AI)."""
    scan = news_digest.digest_scan(limit=80)
    items = scan.get("new_headlines", [])
    clusters = []
    for it in items:
        title = _to_english(it.get("title", ""))          # translate Hindi → English before sending
        detail_src = _to_english(it.get("summary", ""))
        srcs = it.get("sources") or []
        clusters.append({
            "category": _plain_category(title + " " + detail_src),
            "headline": title,
            "detail": _plain_detail(detail_src),
            "link": it.get("link", ""),
            "sources": srcs,
            "pubdate": it.get("pubdate", ""),
            "members": [{"title": title, "source": (srcs[0] if srcs else ""), "link": it.get("link", "")}],
            "note": "",
        })
    pushed = telegram_news.push_digest(clusters)
    news_digest.record_covered([c["headline"] for c in clusters])
    news_digest.record_dedup(len(clusters), 0)   # no AI merging in code-only mode
    if scan.get("scanned_through"):
        news_digest.set_cursor(scan["scanned_through"])
    return {"posted": pushed, "clusters": len(clusters), "more_pending": scan.get("more_pending"),
            "dropped_window_dupes": scan.get("dropped_window_dupes", 0)}


class Alert(BaseModel):
    text: str


@router.post("/alert")
def alert(req: Alert):
    """Send an operational alert to the Telegram subscribers (used by the digest routine to report
    its own failures, e.g. a revoked Claude login). Independent of the Claude CLI."""
    sent = telegram_news.send_alert(req.text)
    return {"sent": sent}


class ReadLaterAction(BaseModel):
    id: str
    read: bool = True


@router.get("/readlater")
def readlater_list():
    """All saved Read Later items (newest first) for the dashboard tab."""
    return telegram_news.readlater_all()


@router.post("/readlater/read")
def readlater_read(req: ReadLaterAction):
    """Mark a saved item read/unread."""
    return {"ok": telegram_news.readlater_set_read(req.id, req.read)}


@router.post("/readlater/delete")
def readlater_delete(req: ReadLaterAction):
    """Remove a saved item."""
    return {"ok": telegram_news.readlater_delete(req.id)}


@router.post("/readlater/clear-read")
def readlater_clear_read():
    """Remove all items already marked read."""
    return {"removed": telegram_news.readlater_clear_read()}


@router.get("/dedup-stats")
def dedup_stats():
    """Cumulative dedup tally since instrumentation began: how many duplicate/re-reported headlines
    the AI removed (window re-reports + within-batch dupes + cross-outlet merges) vs how many
    stories were actually delivered — so the user can judge whether the dedup is worth it."""
    return news_digest.dedup_stats()


@router.get("/digest-scan")
def digest_scan():
    """New headlines since the cursor + the last 4h of already-pushed titles (for cross-window
    dedup). Idempotent — reading does NOT advance the cursor."""
    return news_digest.digest_scan()


class Member(BaseModel):
    title: str = ""
    source: str = ""
    link: str = ""


class Cluster(BaseModel):
    category: str = "Other"           # Market | Economy | Geopolitical | Corporate | Entertainment | Sports | Other
    headline: str                     # ORIGINAL headline text, verbatim (not shortened)
    detail: str = ""                  # one-sentence context line under the headline
    link: str = ""
    sources: List[str] = []           # ALL outlets that carried this story
    members: List[Member] = []        # the individual merged headlines (for fold/unfold in Telegram)
    note: str = ""                    # optional "developing"/context line


class DigestEvent(BaseModel):
    name: str
    date: str                         # YYYY-MM-DD
    category: str = "Macro"
    source_title: str = ""
    source_link: str = ""


class DigestIngest(BaseModel):
    clusters: List[Cluster] = []      # deduped, categorized stories to push to Telegram
    events: List[DigestEvent] = []    # calendar events detected in the same pass
    scanned_through: Optional[str] = None


@router.post("/digest-ingest")
def digest_ingest(req: DigestIngest):
    """Push the categorized digest to Telegram (per-chat category filter applies), file calendar
    events as pending suggestions, remember the pushed story titles (dedup memory), and advance the
    cursor. Advancing only here — on success — so a failed run just re-scans next time."""
    clusters = [c.dict() for c in req.clusters]
    pushed = telegram_news.push_digest(clusters)
    news_digest.record_covered([c["headline"] for c in clusters])

    # Dedup accounting: extra outlet headlines folded into a story = sum(members)-clusters.
    merged = sum(max(len(c.get("members") or []), 1) for c in clusters) - len(clusters)
    news_digest.record_dedup(len(clusters), merged)

    events_added = 0
    for ev in req.events:
        if macro_suggestions.add_suggestion(ev.name, ev.date, ev.category or "Macro",
                                            source_title=ev.source_title, source_link=ev.source_link):
            events_added += 1
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

    # Advance the cursor to what the scan actually served (remembered server-side), NOT to whatever
    # the routine echoed back — Haiku sometimes omits scanned_through, which would freeze the cursor
    # and re-serve the same window every run. Fall back to the routine's value only if we have no
    # server-side record.
    advance_to = news_digest.get_pending() or req.scanned_through
    if advance_to:
        news_digest.set_cursor(advance_to)

    return {"clusters": len(clusters), "pushed_messages": pushed, "events_added": events_added,
            "cursor_advanced_to": advance_to}
