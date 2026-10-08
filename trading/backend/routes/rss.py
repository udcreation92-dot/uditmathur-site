from typing import Optional
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
import rss_watcher
import strategy_db as db
import gemini_client
import news_summarize

router = APIRouter(prefix="/rss", tags=["rss"])


@router.get("/status")
def status():
    return rss_watcher.get_status()


@router.get("/sources")
def sources():
    return rss_watcher.get_feeds_with_status()


class AddSourceRequest(BaseModel):
    name: str
    url: str


@router.post("/sources")
def add_source(req: AddSourceRequest):
    name, url = req.name.strip(), req.url.strip()
    if not name or not url:
        raise HTTPException(400, "name and url are required")
    try:
        rss_watcher.add_feed(name, url)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return rss_watcher.get_feeds_with_status()


@router.delete("/sources/{name}")
def delete_source(name: str):
    try:
        rss_watcher.remove_feed(name)
    except ValueError as e:
        raise HTTPException(404, str(e))
    return rss_watcher.get_feeds_with_status()


@router.post("/check-now")
def check_now():
    return rss_watcher.check_now()


@router.get("/feed")
def feed(limit: int = 50, source: Optional[str] = None, max_age_hours: float = 24):
    """Recent items across all configured feeds, newest first, limited to the last
    max_age_hours (default 24h) — powers the live sidebar."""
    return rss_watcher.get_feed(limit=limit, source=source, max_age_hours=max_age_hours)


@router.get("/brief")
def brief_status():
    """Last manually generated brief (text + timestamp) without triggering a new one."""
    return rss_watcher.get_brief_status()


@router.post("/brief")
def generate_brief():
    """Manually generates a brief covering feed items since the LAST manual brief, capped at
    the past 2 hours. Never runs automatically — each brief is one deliberate LLM call."""
    return rss_watcher.generate_brief()


class SummarizeRequest(BaseModel):
    url: str
    title: Optional[str] = None
    fallback_text: Optional[str] = None  # RSS excerpt, used when the live fetch is blocked


@router.post("/summarize")
def summarize(req: SummarizeRequest):
    """Fetch a headline's article server-side and return a Claude (subscription) summary — the mobile
    swipe-to-summarize equivalent of the Drag-to-Summarize browser extension. One deliberate
    LLM call per request; the frontend gates it behind an explicit swipe/tap.

    Many publishers (Bloomberg, WSJ, …) return 403 to anonymous server-side requests because
    the server carries none of the user's subscription cookies. When the live fetch fails or
    yields too little text, we fall back to the RSS excerpt the frontend already holds so the
    user still gets a summary instead of a hard error."""
    res = news_summarize.summarize_article(req.url, req.title or "", req.fallback_text or "")
    if not res["ok"]:
        raise HTTPException(res.get("status", 502), res["error"])
    return {"title": res["title"], "url": res["url"], "summary": res["summary"], "source": res["source"]}


@router.get("/alerts")
def alerts(symbol: str):
    return rss_watcher.find_relevant(symbol)


@router.get("/for-open-strategies")
def for_open_strategies():
    """Cross-references every leg of every OPEN strategy against all monitored feeds, so you
    can see upcoming corporate actions / news / margin changes affecting positions you're
    already holding, without checking each symbol one at a time."""
    out = []
    for s in db.list_strategies():
        if s["status"] != "OPEN":
            continue
        seen_roots = set()
        for leg in s["legs"]:
            root = rss_watcher.extract_root(leg["symbol"])
            if root in seen_roots:
                continue
            seen_roots.add(root)
            matches = rss_watcher.find_relevant(leg["symbol"])
            if matches:
                out.append({
                    "strategy_id": s["id"],
                    "strategy_name": s["name"],
                    "symbol": leg["symbol"],
                    "root": root,
                    "matches": matches,
                })
    return out
