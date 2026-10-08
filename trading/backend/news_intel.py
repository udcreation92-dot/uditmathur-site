"""LLM-powered enrichment layer (DeepSeek preferred, Gemini fallback — see llm_client) on top
of rss_watcher's plain-text feed items: relevance classification, sentiment/impact tagging,
entity extraction, a daily market brief, AI duplicate-clubbing, and structured parsing of
Zerodha bulletin / NSE-circular style items. Every call is best-effort — if no key is
configured or a call fails, items simply keep flowing through unenriched rather than the whole
news pipeline breaking.

AI only ever looks at items published AFTER the go-live timestamp (recorded on this module's
first run) — the historical backlog stays untouched, both to save tokens and because tagging
week-old headlines has no trading value."""
import json
import os
import re
import threading
import time
from datetime import datetime, timezone, date
from pathlib import Path

import requests

import llm_client
import claude_cli
import macro_suggestions
import events_db
import state_paths

CACHE_FILE = state_paths.state_path(".news_intel_cache.json")
GOLIVE_FILE = state_paths.state_path(".news_intel_golive.txt")
# The ~1500-token classification instruction is re-sent on every call, so it dominates cost at
# small batch sizes. Batching 20 headlines per call amortizes that fixed prompt across 20 items
# (~4x fewer requests and ~half the tokens/headline vs. the old size of 5) while still capping
# each cycle so we never send the full 700-900 item backlog at once. Tunable via env.
BATCH_SIZE = int(os.environ.get("NEWS_BATCH_SIZE", "20"))
MAX_BATCHES_PER_CYCLE = int(os.environ.get("NEWS_MAX_BATCHES_PER_CYCLE", "2"))

# Bulletin-style sources: dense circulars (margin changes, corporate actions) worth structured
# extraction, as opposed to ordinary news articles.
BULLETIN_SOURCE_NAMES = {"Zerodha Bulletin", "Pulse by Zerodha"}

_cache_lock = threading.Lock()
_cache: dict[str, dict] = {}
_brief_lock = threading.Lock()
_brief_state = {"text": None, "generated_at": None}


ITEM_SCHEMA = {
    "type": "object",
    "properties": {
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "index": {"type": "integer"},
                    # Two-way triage: relevant=true for anything a trader cares about, false for
                    # entertainment/sports/celebrity/local human-interest noise. (Macro-event
                    # detection was moved OFF DeepSeek to a local Claude routine — see calendar
                    # /macro-scan + /macro-ingest — so this call only triages relevance now.)
                    "relevant": {"type": "boolean"},
                },
                "required": ["index", "relevant"],
            },
        },
    },
    "required": ["results"],
}

BULLETIN_SCHEMA = {
    "type": "object",
    "properties": {
        "is_corporate_action": {"type": "boolean"},
        "action_type": {"type": "string"},
        "symbols": {"type": "array", "items": {"type": "string"}},
        "effective_date": {"type": "string"},
        "direction": {"type": "string", "enum": ["positive", "negative", "neutral"]},
        "summary": {"type": "string"},
    },
    "required": ["is_corporate_action", "action_type", "symbols", "effective_date", "direction", "summary"],
}

BRIEF_SCHEMA = {
    "type": "object",
    "properties": {"brief": {"type": "string"}},
    "required": ["brief"],
}


# Only bulletin extractions are still consumed (the relevance classifier that filled the rest of
# this cache was removed). Keeping the whole dict made the file grow to ~35MB / 130k entries, and
# since it's rewritten in full on every new bulletin (and lives in OneDrive), that write got slower
# and slower over time. So we now keep ONLY bulletin: keys and cap how many we retain.
_MAX_BULLETINS_CACHED = int(os.environ.get("NEWS_INTEL_CACHE_MAX", "4000"))


def _prune_cache_locked():
    """Drop dead (non-bulletin) entries and cap bulletin entries. Caller holds _cache_lock."""
    stale = [k for k in _cache if not k.startswith("bulletin:")]
    for k in stale:
        _cache.pop(k, None)
    if len(_cache) > _MAX_BULLETINS_CACHED:
        # No per-entry timestamps, so trim oldest-inserted (dict preserves insertion order).
        for k in list(_cache)[: len(_cache) - _MAX_BULLETINS_CACHED]:
            _cache.pop(k, None)


def _load_cache():
    with _cache_lock:
        if _cache:
            return
        if CACHE_FILE.exists():
            try:
                _cache.update(json.loads(CACHE_FILE.read_text()))
            except Exception:
                pass
        _prune_cache_locked()


def _save_cache():
    with _cache_lock:
        _prune_cache_locked()
        try:
            CACHE_FILE.write_text(json.dumps(_cache))
        except Exception:
            pass


def _cache_key(item: dict) -> str:
    return item.get("link") or item["title"]


def _golive() -> datetime:
    """AI go-live timestamp, recorded the first time this module runs on a machine — items
    published before it are never sent to the LLM."""
    if not GOLIVE_FILE.exists():
        now = datetime.now(timezone.utc)
        try:
            GOLIVE_FILE.write_text(now.isoformat())
        except Exception:
            pass
        return now
    try:
        return datetime.fromisoformat(GOLIVE_FILE.read_text().strip())
    except Exception:
        return datetime.now(timezone.utc)


def _item_dt(item: dict) -> datetime | None:
    if not item.get("pubdate"):
        return None
    try:
        dt = datetime.fromisoformat(item["pubdate"])
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _after_golive(item: dict) -> bool:
    dt = _item_dt(item)
    return dt is not None and dt >= _golive()


def _classify_batch(batch: list[dict]) -> dict[int, dict]:
    numbered = "\n".join(
        f'{i}. [{it["source"] if "source" in it else "/".join(it.get("sources", []))}] '
        f'{it["title"]} — {it.get("summary", "")[:200]}'
        for i, it in enumerate(batch)
    )
    prompt = (
        "You are a market-news triage assistant for an Indian equities/derivatives trader. "
        "For each numbered headline below, decide:\n"
        "- relevant: true if it concerns markets, companies, sectors, the economy, macro data, "
        "rates, regulation, commodities, currencies, earnings, corporate actions, or "
        "geopolitics/policy that could move markets (Indian or global). false for pure "
        "entertainment, sports, celebrity, crime, local human-interest or lifestyle noise.\n\n"
        f"{numbered}\n\n"
        "Return one result object per item, in the same order, with the matching index."
    )
    result = llm_client.generate_json(prompt, ITEM_SCHEMA)
    if not result:
        return {}
    return {r["index"]: r for r in result.get("results", []) if "index" in r}


def enrich_items(items: list[dict]) -> list[dict]:
    """Mutates each item in place with a `relevant` flag, using a
    disk-backed cache keyed by link so a headline already seen in a prior poll cycle isn't
    re-sent to the LLM. Only post-go-live items are ever classified, in small batches of
    BATCH_SIZE, at most MAX_BATCHES_PER_CYCLE batches per cycle — anything left over is picked
    up on later cycles as new items trickle in."""
    _load_cache()
    to_classify = []
    for item in items:
        # "enr2:" prefix versions the enrichment cache: v1 entries were poisoned by an early
        # fail-open bug that tagged the entire backlog relevant=True — they're ignored, and
        # post-go-live items get properly re-classified with the new category field.
        cached = _cache.get("enr2:" + _cache_key(item))
        if cached:
            item.update(cached)
        elif _after_golive(item):
            to_classify.append(item)

    if not to_classify:
        return items

    batches = [to_classify[start:start + BATCH_SIZE] for start in range(0, len(to_classify), BATCH_SIZE)]
    batches = batches[:MAX_BATCHES_PER_CYCLE]

    dirty = False
    for batch in batches:
        results = _classify_batch(batch)
        for i, item in enumerate(batch):
            tag = results.get(i)
            if tag is None:
                # Don't cache a failure (e.g. rate-limited) as if it were a real classification
                # — leave the item unclassified so it's retried on a later cycle instead of
                # being permanently stuck with a guessed fallback.
                continue
            enrichment = {"relevant": bool(tag.get("relevant"))}
            item.update(enrichment)
            _cache["enr2:" + _cache_key(item)] = enrichment
            dirty = True

    if dirty:
        _save_cache()
    return items


DUP_SCHEMA = {
    "type": "object",
    "properties": {
        "groups": {
            "type": "array",
            "items": {"type": "array", "items": {"type": "integer"}},
        },
    },
    "required": ["groups"],
}

MAX_DUP_ITEMS_PER_CYCLE = 30  # titles-only prompt, so one small call covers a whole cycle's news


def club_duplicates(items: list[dict]) -> list[dict]:
    """AI-assisted second pass after difflib's dedup: catches paraphrased duplicates whose
    titles aren't textually similar enough for SequenceMatcher (e.g. "RBI cuts repo by 25bps"
    vs "Home loans set to get cheaper after policy move"). Each post-go-live item gets one
    verdict, cached as dup:<link> -> canonical link, so it's asked about exactly once; the
    merge itself is then a pure cache lookup on every cycle. Items the AI hasn't seen yet
    pass through unmerged."""
    _load_cache()
    fresh = [i for i in items if _after_golive(i)]
    unmapped = [i for i in fresh if ("dup:" + _cache_key(i)) not in _cache][:MAX_DUP_ITEMS_PER_CYCLE]

    if len(unmapped) >= 2:
        numbered = "\n".join(f"{i}. {it['title']}" for i, it in enumerate(unmapped))
        prompt = (
            "These are news headlines from different outlets. Group together the ones that "
            "report the SAME underlying story/event (paraphrased duplicates). Only group "
            "headlines you are confident describe the same event — different stories about the "
            "same company are NOT duplicates. Return groups of 2+ indices; leave singletons out.\n\n"
            f"{numbered}"
        )
        result = llm_client.generate_json(prompt, DUP_SCHEMA)
        if result:
            grouped: dict[int, str] = {}
            for group in result.get("groups", []):
                valid = [g for g in group if isinstance(g, int) and 0 <= g < len(unmapped)]
                if len(valid) < 2:
                    continue
                canonical = _cache_key(unmapped[valid[0]])
                for g in valid:
                    grouped[g] = canonical
            with _cache_lock:
                for i, item in enumerate(unmapped):
                    _cache["dup:" + _cache_key(item)] = grouped.get(i, _cache_key(item))
            _save_cache()

    # Apply the cached mapping: fold items sharing a canonical link into one merged entry.
    # The first item of a group encountered in feed order (newest first) becomes the shown
    # entry regardless of which one the AI happened to pick as canonical.
    by_canonical: dict[str, dict] = {}
    out = []
    for item in items:
        canonical = _cache.get("dup:" + _cache_key(item))
        if canonical is None:
            out.append(item)  # not yet seen by the AI — passes through unmerged
            continue
        target = by_canonical.get(canonical)
        if target is None:
            by_canonical[canonical] = item
            out.append(item)
            continue
        # Merge into the group's shown entry: credit sources, keep the longest title/summary.
        for s in item.get("sources", [item.get("source")]):
            if s and s not in target.setdefault("sources", []):
                target["sources"].append(s)
        if len(item.get("title", "")) > len(target.get("title", "")):
            target["title"] = item["title"]
        if len(item.get("summary", "")) > len(target.get("summary", "")):
            target["summary"] = item["summary"]
        target["body"] = f'{target.get("body", "")} {item.get("body", "")}'.strip()
    return out


MAX_BULLETINS_PER_CYCLE = 5  # cap new Claude-CLI bulletin extractions per cycle (rest cached)


def parse_bulletins(items: list[dict]):
    """Runs parse_bulletin over bulletin-source items, newest first, capped per cycle so it
    doesn't compete unboundedly with headline classification for the shared rate limit — any
    left over just get parsed on a later cycle once cached-and-done items stop needing calls."""
    candidates = [
        i for i in items
        if _after_golive(i)
        and (i.get("source") in BULLETIN_SOURCE_NAMES or any(s in BULLETIN_SOURCE_NAMES for s in i.get("sources", [])))
    ]
    parsed_count = 0
    for item in candidates:
        if parsed_count >= MAX_BULLETINS_PER_CYCLE:
            break
        key = "bulletin:" + _cache_key(item)
        _load_cache()
        with _cache_lock:
            already_cached = key in _cache
        bulletin = parse_bulletin(item)
        if bulletin:
            item["bulletin"] = bulletin
        if not already_cached:
            parsed_count += 1


def parse_bulletin(item: dict) -> dict | None:
    """Structured extraction for dense circular/bulletin text — what changed, which symbols,
    effective date, direction — cached by link since bulletins don't change after publication."""
    if item.get("source") not in BULLETIN_SOURCE_NAMES and not any(
        s in BULLETIN_SOURCE_NAMES for s in item.get("sources", [])
    ):
        return None
    _load_cache()
    key = "bulletin:" + _cache_key(item)
    with _cache_lock:
        cached = _cache.get(key)
    if cached:
        return cached
    prompt = (
        "Extract structured info from this exchange bulletin/circular. If it's not a corporate "
        "action or margin/rule circular (just generic commentary), set is_corporate_action to false.\n\n"
        f"Title: {item['title']}\n\nBody: {item.get('body', item.get('summary', ''))[:3000]}"
    )
    result = claude_cli.generate_json(prompt, BULLETIN_SCHEMA)
    if not result:
        return None
    with _cache_lock:
        _cache[key] = result
    _save_cache()
    return result


BRIEF_STATE_FILE = state_paths.state_path(".news_brief_state.json")
BRIEF_MAX_WINDOW_SECONDS = 2 * 3600  # never look back further than 2 hours


def _load_brief_state():
    """Persisted so 'news since the last brief' survives backend restarts."""
    with _brief_lock:
        if _brief_state["generated_at"] is not None or _brief_state["text"] is not None:
            return
        if BRIEF_STATE_FILE.exists():
            try:
                _brief_state.update(json.loads(BRIEF_STATE_FILE.read_text()))
            except Exception:
                pass


def get_brief_status() -> dict:
    _load_brief_state()
    with _brief_lock:
        return {"brief": _brief_state["text"], "generated_at": _brief_state["generated_at"]}


def generate_brief(items: list[dict]) -> dict:
    """Manual, on-demand brief covering feed items published since the LAST manual brief —
    capped at the past 2 hours if the last one is older than that (or there's never been one),
    so a brief after a long gap doesn't try to summarize half a day of headlines."""
    _load_brief_state()
    now = time.time()
    with _brief_lock:
        last = _brief_state["generated_at"]
    window_start = max(last or 0, now - BRIEF_MAX_WINDOW_SECONDS)
    window_start_dt = datetime.fromtimestamp(window_start, tz=timezone.utc)

    windowed = [i for i in items if (dt := _item_dt(i)) and dt >= window_start_dt]
    if not windowed:
        return {**get_brief_status(), "item_count": 0,
                "message": "No new feed items since the last brief."}

    # High-impact first if enrichment tags exist, then cap the prompt size.
    top_items = sorted(
        windowed, key=lambda i: {"high": 0, "medium": 1, "low": 2}.get(i.get("impact", "low"), 2)
    )[:60]
    minutes = int((now - window_start) / 60)
    headlines = "\n".join(f"- {i['title']}" for i in top_items)
    prompt = (
        f"You are writing a short market brief for an Indian equities/derivatives trader, "
        f"covering ONLY the news headlines from the last {minutes} minutes, listed below. "
        "Summarize only what actually matters for markets — key moves, policy/macro news, major "
        "corporate actions, notable earnings. Skip entertainment/sports/local noise. Be concise "
        "(3-6 sentences), factual, no bullet points, no preamble.\n\n"
        f"{headlines}"
    )
    result = llm_client.generate_json(prompt, BRIEF_SCHEMA)
    text = result.get("brief") if result else None
    if not text:
        return {**get_brief_status(), "item_count": len(windowed),
                "message": "Brief generation failed — try again."}

    with _brief_lock:
        _brief_state["text"] = text
        _brief_state["generated_at"] = now
        try:
            BRIEF_STATE_FILE.write_text(json.dumps(_brief_state))
        except Exception:
            pass
    return {"brief": text, "generated_at": now, "item_count": len(windowed), "message": None}
