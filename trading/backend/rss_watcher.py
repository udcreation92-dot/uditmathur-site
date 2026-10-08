import os
import re
import json
import threading
import time
import html
import requests
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor
from difflib import SequenceMatcher
from pathlib import Path
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime

import news_intel
import gemini_client
import state_paths

FEEDS_FILE = state_paths.state_path(".rss_feeds.json")

# Seeded into FEEDS_FILE the first time this runs — editable afterwards via add_feed/remove_feed
# (and the /rss/sources API), so this list is only ever the starting point, not the live config.
DEFAULT_FEEDS = [
    {"name": "Zerodha Bulletin", "url": "https://zerodha.com/marketintel/bulletin/?format=xml"},
    {"name": "Economic Times Markets", "url": "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms"},
    {"name": "Moneycontrol Markets", "url": "https://www.moneycontrol.com/rss/marketreports.xml"},
    {"name": "LiveMint Markets", "url": "https://www.livemint.com/rss/markets"},
    {"name": "Hindu BusinessLine Markets", "url": "https://www.thehindubusinessline.com/markets/feeder/default.rss"},
]
# How often to re-pull every feed. RSS is pull-only (no publisher push), so this is the floor on
# how fresh headlines can be — at 60s a new story reaches the feed/Telegram within ~a minute
# instead of up to 3. Only genuinely new items hit the AI classifier (cached ones skip), so a
# tighter interval costs more feed fetches but not proportionally more tokens. Tunable via env.
POLL_INTERVAL = int(os.environ.get("RSS_POLL_INTERVAL", "60"))
MAX_ITEMS_PER_FEED = 40
REQUEST_HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; TradingDashboardBot/1.0)"}
# Two different outlets covering the same story rarely use identical wording, but wire-copy
# style headlines/ledes are close enough that a plain text-similarity ratio catches most of
# them without needing embeddings/ML — this threshold was picked to catch paraphrases while
# not merging genuinely different stories that happen to share a few words (e.g. "RBI cuts
# rates" vs "RBI holds rates").
DEDUP_SIMILARITY_THRESHOLD = 0.72
DEDUP_WINDOW_HOURS = 20  # only cluster stories reported within this window of each other

_stop_event = threading.Event()
_wake_event = threading.Event()
_thread: threading.Thread | None = None
_lock = threading.Lock()
_feeds_lock = threading.Lock()
_translation_lock = threading.Lock()
_translation_cache: dict[str, str] = {}  # original text -> English translation, across poll cycles

_DEVANAGARI_RE = re.compile(r"[ऀ-ॿ]")  # Hindi (and other Devanagari-script languages)

_state = {
    # [{title, sources: [name,...], link (most recent report's), pubdate (most recent, iso),
    #   summary, body}], newest first. Items from different feeds about the same story are
    # merged into one entry with multiple "sources" — see _dedupe_and_merge.
    "items": [],
    "last_checked": None,
    "errors": {},           # {feed_name: error string}
}

_TAG_RE = re.compile(r"<[^>]+>")
_ROOT_RE = re.compile(r"^([A-Za-z]+)")
# Fyers exchange-segment suffixes seen in this app's symbols — stripped before root
# extraction so they don't get treated as part of the ticker name.
_KNOWN_SUFFIXES = ("-EQ", "-TB")


def _strip_html(text: str) -> str:
    plain = _TAG_RE.sub(" ", html.unescape(text or ""))
    return re.sub(r"\s+", " ", plain).strip()


def _is_hindi(text: str) -> bool:
    if not text:
        return False
    devanagari = len(_DEVANAGARI_RE.findall(text))
    letters = sum(1 for c in text if c.isalpha())
    return letters > 0 and devanagari / letters > 0.3


def _translate_to_english(text: str) -> str:
    """Cached across poll cycles (keyed by the exact original text) so the same headline
    isn't re-translated every 3 minutes — only genuinely new items hit the translator.

    Calls Google's translate endpoint directly with `requests` (same endpoint deep-translator
    wraps) rather than going through that library, so a short, explicit timeout is guaranteed —
    a hanging/slow translation call must not be able to stall the whole poll cycle indefinitely
    with dozens of Hindi-language feeds in the mix."""
    if not text:
        return text
    with _translation_lock:
        cached = _translation_cache.get(text)
    if cached is not None:
        return cached
    # 1) Google's free endpoint (fast). This box is often IP-rate-limited (HTTP 429) on it, so we
    #    fall through to MyMemory below when it fails.
    try:
        resp = requests.get(
            "https://translate.googleapis.com/translate_a/single",
            params={"client": "gtx", "sl": "auto", "tl": "en", "dt": "t", "q": text},
            headers=REQUEST_HEADERS, timeout=5,
        )
        resp.raise_for_status()
        chunks = resp.json()[0]
        translated = "".join(chunk[0] for chunk in chunks if chunk[0])
        if translated and translated != text:
            with _translation_lock:
                _translation_cache[text] = translated
            return translated
    except Exception:
        pass

    # 2) MyMemory free endpoint (no API key). Reliable from this box where Google 429s.
    try:
        resp = requests.get(
            "https://api.mymemory.translated.net/get",
            params={"q": text[:500], "langpair": "hi|en"},
            headers=REQUEST_HEADERS, timeout=8,
        )
        resp.raise_for_status()
        translated = (resp.json().get("responseData") or {}).get("translatedText") or ""
        # MyMemory returns quota/error notices as the "translation" — reject those.
        if translated and translated != text and "MYMEMORY WARNING" not in translated.upper() \
           and "INVALID" not in translated.upper():
            with _translation_lock:
                _translation_cache[text] = translated
            return translated
    except Exception:
        pass

    return text  # both failed — return original WITHOUT caching, so a later cycle retries


def get_feeds() -> list[dict]:
    with _feeds_lock:
        if not FEEDS_FILE.exists():
            FEEDS_FILE.write_text(json.dumps(DEFAULT_FEEDS, indent=2))
            return list(DEFAULT_FEEDS)
        return json.loads(FEEDS_FILE.read_text())


def _save_feeds(feeds: list[dict]):
    with _feeds_lock:
        FEEDS_FILE.write_text(json.dumps(feeds, indent=2))


def add_feed(name: str, url: str):
    """Validates the URL is actually a parseable RSS feed before saving — fails loudly at
    add-time rather than silently sitting broken until the next poll cycle surfaces it."""
    feeds = get_feeds()
    if any(f["name"] == name for f in feeds):
        raise ValueError(f'A feed named "{name}" already exists')
    try:
        _fetch_feed({"name": name, "url": url})
    except Exception as e:
        raise ValueError(f"Couldn't fetch/parse this as an RSS feed: {e}")
    feeds.append({"name": name, "url": url})
    _save_feeds(feeds)
    _wake_event.set()  # pull in the new feed's items immediately instead of waiting for the next cycle


def remove_feed(name: str):
    feeds = get_feeds()
    remaining = [f for f in feeds if f["name"] != name]
    if len(remaining) == len(feeds):
        raise ValueError(f'No feed named "{name}"')
    _save_feeds(remaining)
    with _lock:
        _state["errors"].pop(name, None)
    # Cached items are merged clusters that may credit several sources — rather than trying
    # to surgically strip this source out of each cluster, just trigger an immediate re-poll
    # and let the next cycle rebuild the merged list correctly without it.
    _wake_event.set()


def _fetch_feed(feed: dict) -> list[dict]:
    resp = requests.get(feed["url"], timeout=15, headers=REQUEST_HEADERS)
    resp.raise_for_status()
    root = ET.fromstring(resp.content)
    items = []
    for item in root.findall(".//item")[:MAX_ITEMS_PER_FEED]:
        title = html.unescape((item.findtext("title") or "").strip())
        link = (item.findtext("link") or "").strip()
        pub_raw = (item.findtext("pubDate") or "").strip()
        try:
            pubdate = parsedate_to_datetime(pub_raw).isoformat()
        except Exception:
            pubdate = None
        body = _strip_html(item.findtext("description") or "")
        summary = body[:300]
        items.append({
            "source": feed["name"], "title": title, "link": link,
            "pubdate": pubdate, "summary": summary, "body": body, "translated": False,
        })
    return items


# Translation only runs for items from these feeds (by exact name), rather than scanning
# every item from every configured feed for Hindi text — scoped down per explicit request,
# and cheaper since most feeds are English-only anyway.
HINDI_FEED_NAMES = {"Nai Dunia", "इंदौर | दैनिक भास्कर"}


_TRANSLATE_SCHEMA = {
    "type": "object",
    "properties": {
        "translations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"index": {"type": "integer"}, "en": {"type": "string"}},
                "required": ["index", "en"],
            },
        }
    },
    "required": ["translations"],
}


def _translate_batch_gemini(texts: list[str]) -> dict[str, str]:
    """Translate several Hindi snippets to English in ONE Gemini call (free tier — keeps this off
    DeepSeek's metered billing and avoids Google's rate-limited free endpoint). Returns
    {original: english} for the ones that came back; missing ones are left for the Google fallback."""
    if not texts:
        return {}
    numbered = "\n".join(f"{i}. {t}" for i, t in enumerate(texts))
    prompt = (
        "Translate each numbered Hindi news snippet into natural, concise English. Preserve proper "
        "nouns and numbers. Return one object per input with its matching index.\n\n" + numbered
    )
    res = gemini_client.generate_json(prompt, _TRANSLATE_SCHEMA)
    out: dict[str, str] = {}
    if res:
        for r in res.get("translations", []):
            i, en = r.get("index"), (r.get("en") or "").strip()
            if isinstance(i, int) and 0 <= i < len(texts) and en:
                out[texts[i]] = en
    return out


def _translate_hindi_items(items: list[dict]):
    """Translate title/summary for Hindi items (HINDI_FEED_NAMES) to English in-place, so both the
    dashboard and the Telegram push show readable English. Uncached snippets are batch-translated
    via Gemini in a single call; anything Gemini misses falls back to Google's free endpoint. Only
    successful translations are cached, so a failed cycle retries next time rather than sticking."""
    targets = [
        i for i in items
        if i["source"] in HINDI_FEED_NAMES and (_is_hindi(i["title"]) or _is_hindi(i["summary"]))
    ]
    if not targets:
        return

    # Collect the unique Hindi snippets not already translated in cache.
    need: list[str] = []
    for it in targets:
        for field in ("title", "summary"):
            t = it.get(field)
            if t and _is_hindi(t):
                with _translation_lock:
                    have = t in _translation_cache
                if not have and t not in need:
                    need.append(t)

    if need:
        translated = _translate_batch_gemini(need)
        missing = [t for t in need if t not in translated]
        if missing:  # Gemini unavailable/partial — try the free Google endpoint per item
            with ThreadPoolExecutor(max_workers=10) as pool:
                for t, en in zip(missing, pool.map(_translate_to_english, missing)):
                    if en and en != t:
                        translated[t] = en
        with _translation_lock:
            _translation_cache.update(translated)

    # Apply whatever translations we now have (cache-backed) to the items in place.
    for it in targets:
        changed = False
        for field in ("title", "summary"):
            t = it.get(field)
            if not t:
                continue
            with _translation_lock:
                en = _translation_cache.get(t)
            if en and en != t:
                it[field] = en
                changed = True
        if changed:
            it["translated"] = True


_TITLE_NORM_RE = re.compile(r"[^a-z0-9\s]")


def _normalize_title(title: str) -> str:
    return _TITLE_NORM_RE.sub("", title.lower()).strip()


def _bucket_key(norm_title: str) -> str:
    """First word of the normalized title, used to avoid comparing every item against every
    cluster (which is ~O(n²) SequenceMatcher calls — fine at a couple hundred items, but with
    30+ feeds and 800+ items in a cycle it took over a minute on its own). Two reports of the
    same story virtually always open with the same word(s) (shared subject/wire-copy lede),
    so bucketing on it cuts the comparison set drastically with negligible recall loss."""
    words = norm_title.split()
    return words[0] if words else ""


def _dedupe_and_merge(items: list[dict]) -> list[dict]:
    """Groups items that are exact or near-duplicate reports of the same story — either the
    identical headline from two feeds, or two outlets' own phrasing of the same underlying
    news — into a single entry crediting every source. Greedy single-pass clustering: each
    item joins the first existing cluster it's similar enough to (by title text and being
    reported within DEDUP_WINDOW_HOURS of it), else starts a new one."""
    clusters = []  # [{"items": [...], "signatures": [(norm_title, datetime), ...]}]
    buckets: dict[str, list[int]] = {}
    for item in items:
        norm = _normalize_title(item["title"])
        item_dt = _pubdate_sort_key(item)
        key = _bucket_key(norm)
        placed = False
        for ci in buckets.get(key, []):
            cluster = clusters[ci]
            for other_norm, other_dt in cluster["signatures"]:
                if abs((item_dt - other_dt).total_seconds()) > DEDUP_WINDOW_HOURS * 3600:
                    continue
                if SequenceMatcher(None, norm, other_norm).ratio() >= DEDUP_SIMILARITY_THRESHOLD:
                    cluster["items"].append(item)
                    cluster["signatures"].append((norm, item_dt))
                    placed = True
                    break
            if placed:
                break
        if not placed:
            clusters.append({"items": [item], "signatures": [(norm, item_dt)]})
            buckets.setdefault(key, []).append(len(clusters) - 1)

    merged = []
    for cluster in clusters:
        cluster_items = cluster["items"]
        # The longest headline is usually the most descriptive/least truncated one — use it
        # as the representative title shown for the merged entry.
        rep = max(cluster_items, key=lambda x: len(x["title"]))
        most_recent = max(cluster_items, key=_pubdate_sort_key)
        best_summary_item = max(cluster_items, key=lambda x: len(x["summary"]))
        seen_sources = []
        for x in cluster_items:
            if x["source"] not in seen_sources:
                seen_sources.append(x["source"])
        merged.append({
            "title": rep["title"],
            "sources": seen_sources,
            "link": most_recent["link"],
            "pubdate": most_recent["pubdate"],
            "summary": best_summary_item["summary"],
            "body": " ".join(x["body"] for x in cluster_items),
            "translated": rep.get("translated", False) or best_summary_item.get("translated", False),
        })
    return merged


def _pubdate_sort_key(item: dict) -> datetime:
    """Feeds mix timezone offsets (Indian sources use +05:30, Bloomberg uses +00:00) — sorting
    the raw ISO strings compares digits lexicographically without normalizing timezones, so
    "21:44+05:30" would wrongly rank above "17:56+00:00" even though the latter (23:26 IST) is
    chronologically later. Parse into real datetimes so the comparison is timezone-correct."""
    if not item["pubdate"]:
        return datetime.min.replace(tzinfo=timezone.utc)
    try:
        dt = datetime.fromisoformat(item["pubdate"])
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    # A handful of feeds omit a timezone in their pubDate, which parses to a naive datetime —
    # mixing naive and aware datetimes in the same comparison raises TypeError, so assume UTC.
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _run_cycle():
    feeds = get_feeds()
    all_items = []
    errors = {}
    # Fetch feeds concurrently — with 30+ feeds configured, one slow/unresponsive source (up
    # to its 15s timeout) shouldn't serialize behind every other fetch.
    with ThreadPoolExecutor(max_workers=10) as pool:
        results = pool.map(_fetch_feed, feeds)
        for feed, result_or_exc in zip(feeds, _safe_results(results)):
            if isinstance(result_or_exc, Exception):
                errors[feed["name"]] = str(result_or_exc)
            else:
                all_items.extend(result_or_exc)
    _translate_hindi_items(all_items)
    merged_items = _dedupe_and_merge(all_items)
    merged_items.sort(key=_pubdate_sort_key, reverse=True)
    # No relevance triage and no AI dedup here — the page shows every headline (difflib already
    # merged exact/near-exact dupes above). Semantic dedup + categorization now happen in the 30-min
    # Claude digest routine, not on every poll. We still parse exchange bulletins for the structured
    # corporate-action info shown on the page. Never blocks the feed on failure.
    try:
        news_intel.parse_bulletins(merged_items)
    except Exception:
        pass
    with _lock:
        _state["items"] = merged_items
        _state["last_checked"] = time.time()
        _state["errors"] = errors

    # Telegram delivery is now the 30-min categorized digest (see news_digest / routes/news.py),
    # not a per-poll firehose — so nothing is pushed from here.


def _safe_results(results_iter):
    """pool.map raises on first exception when iterated — wrap each item so one feed's
    failure doesn't abort collection of the rest."""
    it = iter(results_iter)
    while True:
        try:
            yield next(it)
        except StopIteration:
            return
        except Exception as e:
            yield e


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
    _run_cycle()
    return get_status()


def get_status() -> dict:
    with _lock:
        return {
            "last_checked": _state["last_checked"],
            "item_count": len(_state["items"]),
            "feeds": [f["name"] for f in get_feeds()],
            "errors": dict(_state["errors"]),
        }


def get_feeds_with_status() -> list[dict]:
    """Per-feed config plus whether its last poll succeeded — powers the manage-feeds UI and
    the "N feeds not working" alert."""
    with _lock:
        errors = dict(_state["errors"])
        last_checked = _state["last_checked"]
    return [
        {"name": f["name"], "url": f["url"], "ok": f["name"] not in errors,
         "error": errors.get(f["name"]), "last_checked": last_checked}
        for f in get_feeds()
    ]


def get_feed(limit: int = 50, source: str = None, max_age_hours: float = 24) -> list[dict]:
    with _lock:
        items = list(_state["items"])  # already newest-first, see _run_cycle's sort
    if source:
        items = [i for i in items if source in i["sources"]]
    if max_age_hours is not None:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=max_age_hours)
        items = [i for i in items if i["pubdate"] and _pubdate_sort_key(i) >= cutoff]
    return [{k: v for k, v in i.items() if k != "body"} for i in items[:limit]]


def get_brief_status() -> dict:
    return news_intel.get_brief_status()


def generate_brief() -> dict:
    with _lock:
        items = list(_state["items"])
    return news_intel.generate_brief(items)


def extract_root(symbol: str) -> str:
    """Best-effort underlying ticker root from any symbol format (Fyers, Zerodha, options,
    futures, equity) — used to match against feed text, which references plain ticker names
    (e.g. "HINDPETRO", "BAJAJ-AUTO", "NIFTY"). Not exact, just a heuristic.

    Only strips a trailing exchange-segment suffix (-EQ, -TB); everything else is kept as-is
    UNLESS the body contains digits, which means it's an option/future contract with an
    embedded expiry date and strike (e.g. "NIFTY2670724800CE") — there we take the leading
    alphabetic run as the root. A plain ticker with a hyphen in its actual name (BAJAJ-AUTO)
    has no digits, so it passes through untouched instead of being cut at the hyphen."""
    body = symbol.split(":")[-1]
    for suf in _KNOWN_SUFFIXES:
        if body.endswith(suf):
            body = body[: -len(suf)]
            break
    if any(c.isdigit() for c in body):
        m = _ROOT_RE.match(body)
        return (m.group(1) if m else body).upper()
    return body.upper()


def _matches(root: str, text: str) -> bool:
    return re.search(rf"\b{re.escape(root)}\b", text, re.IGNORECASE) is not None


def find_relevant(symbol: str) -> list[dict]:
    root = extract_root(symbol)
    if not root:
        return []
    with _lock:
        items = list(_state["items"])
    # Search full body text, not just the title/truncated summary — a bulletin/article often
    # lists affected scrips in a body table or later paragraph, not in the headline.
    return [
        {k: v for k, v in i.items() if k != "body"}
        for i in items if _matches(root, i["title"]) or _matches(root, i["body"])
    ]
