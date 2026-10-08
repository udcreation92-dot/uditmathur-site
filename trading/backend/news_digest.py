"""Scan cursor + duplicate-detection memory for the 30-min news-digest Claude routine.

The routine periodically calls GET /news/digest-scan (new headlines since the cursor, plus the
titles of stories already pushed in the last few hours), dedupes + categorizes them, and POSTs the
result to /news/digest-ingest — which pushes a category-tagged digest to Telegram, files calendar
events, records what was pushed (so it isn't re-sent), and advances the cursor.

Both the cursor and the "recently covered" memory live here on the backend, so the routine stays
stateless. The cursor advances only on a successful ingest, so a skipped run just catches up."""
import json
import os
import re
import threading
from datetime import datetime, timezone, timedelta
from pathlib import Path

import rss_watcher
import state_paths

_CURSOR_FILE = state_paths.state_path(".news_digest_cursor.json")
_PENDING_FILE = state_paths.state_path(".news_digest_pending.json")
_COVERED_FILE = state_paths.state_path(".news_covered.json")
_lock = threading.Lock()

_FIRST_RUN_LOOKBACK = timedelta(minutes=35)   # ~one cycle back on first run
_COVERED_WINDOW = timedelta(hours=12)         # dedup memory horizon (widened to catch developing
                                              # stories re-reported over many hours)


# ── cursor ───────────────────────────────────────────────────────────
def get_cursor() -> str:
    with _lock:
        try:
            return json.loads(_CURSOR_FILE.read_text())["cursor"]
        except Exception:
            return (datetime.now(timezone.utc) - _FIRST_RUN_LOOKBACK).isoformat()


def set_pending(scanned_through_iso: str):
    """Remember the scanned_through the backend just served to a scan. The ingest advances the
    cursor to THIS value rather than trusting the Claude routine to echo scanned_through back —
    the routine sometimes omits it, which would freeze the cursor and re-serve the same window."""
    with _lock:
        try:
            _PENDING_FILE.write_text(json.dumps({"pending": scanned_through_iso}))
        except Exception:
            pass


def get_pending() -> str | None:
    with _lock:
        try:
            return json.loads(_PENDING_FILE.read_text())["pending"]
        except Exception:
            return None


# ── dedup accounting ("was it worth it") ─────────────────────────────
_SCANSTATS_FILE = state_paths.state_path(".news_scan_last.json")
_STATS_FILE = state_paths.state_path(".news_dedup_stats.json")


def _stash_scan_stats(posted: int, dropped_window: int, dropped_batch: int):
    with _lock:
        try:
            _SCANSTATS_FILE.write_text(json.dumps(
                {"posted": posted, "dw": dropped_window, "db": dropped_batch}))
        except Exception:
            pass


def _get_scan_stats() -> dict:
    with _lock:
        try:
            return json.loads(_SCANSTATS_FILE.read_text())
        except Exception:
            return {"posted": 0, "dw": 0, "db": 0}


def record_dedup(posted_clusters: int, merged_headlines: int):
    """Called once per successful ingest. Folds the last scan's duplicate-drop counts together with
    this run's cluster/merge counts into a cumulative, persistent tally so the user can see the real
    dedup rate over time. merged_headlines = (sum of members across clusters) - clusters, i.e. the
    extra outlet headlines collapsed into an existing story."""
    s = _get_scan_stats()
    with _lock:
        try:
            tot = json.loads(_STATS_FILE.read_text())
        except Exception:
            tot = {"since": datetime.now(timezone.utc).isoformat(),
                   "runs": 0, "posted_stories": 0,
                   "dropped_window_dupes": 0, "dropped_batch_dupes": 0, "merged_headlines": 0}
        tot["runs"] += 1
        tot["posted_stories"] += posted_clusters
        tot["dropped_window_dupes"] += s.get("dw", 0)
        tot["dropped_batch_dupes"] += s.get("db", 0)
        tot["merged_headlines"] += max(merged_headlines, 0)
        try:
            _STATS_FILE.write_text(json.dumps(tot))
        except Exception:
            pass


def dedup_stats() -> dict:
    with _lock:
        try:
            tot = dict(json.loads(_STATS_FILE.read_text()))
        except Exception:
            return {"since": None, "runs": 0, "posted_stories": 0, "dropped_window_dupes": 0,
                    "dropped_batch_dupes": 0, "merged_headlines": 0}
    dups = tot.get("dropped_window_dupes", 0) + tot.get("dropped_batch_dupes", 0) + tot.get("merged_headlines", 0)
    raw = tot.get("posted_stories", 0) + dups
    tot["total_duplicates_removed"] = dups
    tot["total_headlines_seen"] = raw
    tot["dedup_rate_pct"] = round(100 * dups / raw, 1) if raw else 0.0
    return tot


def set_cursor(cursor_iso: str):
    with _lock:
        try:
            _CURSOR_FILE.write_text(json.dumps({"cursor": cursor_iso}))
        except Exception:
            pass


# ── recently-covered memory (last 4h of pushed story titles) ─────────
def _normalize(title: str) -> str:
    return re.sub(r"[^a-z0-9 ]", "", (title or "").lower()).strip()


def _load_covered() -> list[dict]:
    try:
        return json.loads(_COVERED_FILE.read_text())
    except Exception:
        return []


def _save_covered(items: list[dict]):
    try:
        _COVERED_FILE.write_text(json.dumps(items))
    except Exception:
        pass


def _prune(items: list[dict], now: datetime) -> list[dict]:
    cutoff = (now - _COVERED_WINDOW).timestamp()
    return [i for i in items if i.get("ts", 0) >= cutoff]


def record_covered(titles: list[str]):
    """Remember these story titles as pushed, so the next scans treat re-reports as duplicates."""
    now = datetime.now(timezone.utc)
    with _lock:
        items = _prune(_load_covered(), now)
        seen = {i["sig"] for i in items}
        for t in titles:
            sig = _normalize(t)
            if sig and sig not in seen:
                items.append({"sig": sig, "title": t, "ts": now.timestamp()})
                seen.add(sig)
        _save_covered(items)


def recently_covered_titles() -> list[str]:
    now = datetime.now(timezone.utc)
    with _lock:
        items = _prune(_load_covered(), now)
        _save_covered(items)  # opportunistic prune
        return [i["title"] for i in items]


# ── scan ─────────────────────────────────────────────────────────────
def _as_dt(iso: str):
    try:
        dt = datetime.fromisoformat(iso)
        return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
    except Exception:
        return None


_MAX_PER_RUN = int(os.environ.get("NEWS_DIGEST_MAX_PER_RUN", "40"))


def digest_scan(limit: int = _MAX_PER_RUN) -> dict:
    """New headlines since the cursor (newest first), plus the last 4h of already-pushed titles for
    cross-window dedup, plus a `scanned_through` timestamp the routine echoes back on ingest."""
    cursor = get_cursor()
    cutoff = _as_dt(cursor)
    now = datetime.now(timezone.utc)
    feed = rss_watcher.get_feed(limit=600, max_age_hours=24)

    # Deterministic dedup guard: never even hand Haiku a headline whose normalized signature was
    # already pushed in the covered window. Haiku is still asked to merge/drop re-reports, but this
    # guarantees exact/near-exact re-reports can't slip through if the model misses them.
    covered_sigs = {_normalize(t) for t in recently_covered_titles()}

    # Collect everything newer than the cursor, OLDEST first. Processing oldest-first lets us cap
    # each run at `limit` headlines while still advancing the cursor safely: scanned_through becomes
    # the newest item in THIS bounded batch, so the rest are picked up on the next run rather than
    # skipped. This keeps a single Haiku call small and reliable even if a backlog builds up (a
    # hung/missed run no longer snowballs into an impossible 100+ headline mega-run).
    eligible = []
    for it in feed:
        dt = _as_dt(it.get("pubdate", ""))
        if not dt or (cutoff and dt <= cutoff):
            continue
        # Skip FUTURE-dated items: some feeds mislabel timezones (e.g. IST stamped as +00:00),
        # producing pubdates hours ahead. Left unchecked, advancing the cursor to such a stamp
        # freezes the digest until the wall clock catches up. They reappear once real time passes.
        if dt > now:
            continue
        eligible.append((dt, it))
    eligible.sort(key=lambda x: x[0])   # oldest first

    out, newest, seen_sigs = [], None, set()
    dropped_window, dropped_batch = 0, 0   # dedup accounting for the "was it worth it" stats
    for dt, it in eligible:
        if len(out) >= limit:
            break
        sig = _normalize(it.get("title", ""))
        if sig and (sig in covered_sigs or sig in seen_sigs):
            # already pushed recently, or a duplicate title within this same scan — advance past it
            if sig in covered_sigs:
                dropped_window += 1     # re-report already sent within the covered window
            else:
                dropped_batch += 1      # duplicate title within this same batch
            newest = dt if newest is None or dt > newest else newest
            continue
        if sig:
            seen_sigs.add(sig)
        out.append({
            "title": it.get("title"),
            "link": it.get("link"),
            "summary": it.get("summary", ""),
            "pubdate": it.get("pubdate"),
            "sources": it.get("sources", []),
        })
        newest = dt if newest is None or dt > newest else newest

    # Tell the routine whether more remain past this batch, so it can run again immediately instead
    # of waiting a full 30 min to drain a backlog.
    more_pending = bool(out) and len(out) >= limit

    # Never advance the cursor into the future, and don't move it at all when nothing new arrived.
    if newest:
        scanned_through = min(newest, now).isoformat()
    else:
        scanned_through = (cutoff or now).isoformat()
    # Remember what we served, so the ingest can advance the cursor even if the routine forgets to
    # echo scanned_through back in its POST.
    set_pending(scanned_through)
    # Stash this scan's dedup counts so the ingest (once per run) can fold them into cumulative stats.
    _stash_scan_stats(len(out), dropped_window, dropped_batch)
    return {
        "cursor": cursor,
        "scanned_through": scanned_through,
        "count": len(out),
        "new_headlines": out,
        "recently_covered": recently_covered_titles(),
        "more_pending": more_pending,
        "dropped_window_dupes": dropped_window,
        "dropped_batch_dupes": dropped_batch,
    }
