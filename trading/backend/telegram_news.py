"""Telegram news bot for the trading dashboard.

Pushes market-relevant headlines to subscribed Telegram chats as they arrive, each with two inline
buttons: "✦ Summarize" (runs the DeepSeek summarizer and replies with a TL;DR) and "📰 Read
article" (opens the source URL). Designed for use on the move.

Transport: long-polling (getUpdates) — the bot reaches out to Telegram, so it needs NO public
webhook and works fine from a Tailscale-only box. The bot token comes from the TELEGRAM_NEWS_BOT_TOKEN
env var; if it's unset the whole module is inert (never blocks the feed).

Subscribe by opening the bot in Telegram and pressing Start (/start). Multiple chats can subscribe.
"""
import os
import json
import time
import html
import hashlib
import threading

import requests

import news_summarize
import state_paths

_TOKEN = os.environ.get("TELEGRAM_NEWS_BOT_TOKEN", "").strip()
_API = f"https://api.telegram.org/bot{_TOKEN}" if _TOKEN else None

_STATE_FILE = str(state_paths.state_path(".telegram_news_state.json"))
_lock = threading.Lock()
_state = {"chat_ids": [], "offset": 0, "tokens": {}, "pushed": [], "categories": {},
          "read_later": {}, "rl_view": {}, "batches": {}}

# Digest categories (the routine tags each story with one of these). `categories` in _state maps a
# chat_id -> the list it wants to receive; absent = all enabled.
CATEGORIES = ["Market", "Economy", "Geopolitical", "Corporate", "Entertainment", "Sports", "Other"]
CATEGORY_EMOJI = {
    "Market": "📈", "Economy": "🏦", "Geopolitical": "🌐", "Corporate": "🏢",
    "Entertainment": "🎬", "Sports": "🏅", "Other": "📰",
}

_MAX_TOKENS = 600      # article-link map, bounded
_MAX_PUSHED = 1000     # dedupe ring of already-sent links
_PUSH_MAX_AGE = 45 * 60  # only push items published within the last 45 min (avoid backlog floods)
# Now that ALL headlines are pushed (no relevance filter), raise the per-cycle cap so bursts aren't
# dropped. Still bounded so one cycle can't fire hundreds of messages. Env-tunable.
_PUSH_PER_CYCLE = int(os.environ.get("TELEGRAM_PUSH_PER_CYCLE", "30"))

_thread = None
_stop = threading.Event()


# ── state persistence ────────────────────────────────────────────────
def _load():
    global _state
    try:
        with open(_STATE_FILE, "r", encoding="utf-8") as f:
            _state = {**_state, **json.load(f)}
    except Exception:
        pass


def _save():
    try:
        with open(_STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(_state, f)
    except Exception:
        pass


# ── Telegram API helper ──────────────────────────────────────────────
def _api(method: str, req_timeout: int = 30, **params):
    # req_timeout is the HTTP client timeout; Telegram's own long-poll `timeout` is a normal param.
    if not _API:
        return None
    try:
        r = requests.post(f"{_API}/{method}", json=params, timeout=req_timeout)
        return r.json()
    except Exception:
        return None


def _md_to_tg_html(md: str) -> str:
    """Minimal, safe Markdown → Telegram HTML: escape first, then only re-introduce <b> and bullet
    markers. Telegram's HTML parse_mode allows <b>/<i>/<a> — never raw model HTML."""
    out = html.escape(md or "")
    import re
    out = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", out)
    out = re.sub(r"^\s*[-*]\s+", "• ", out, flags=re.M)
    return out


# ── outbound: push a headline ────────────────────────────────────────
def _token_for(item: dict) -> str:
    link = item.get("link") or item.get("title", "")
    tok = hashlib.sha1(link.encode("utf-8")).hexdigest()[:14]
    with _lock:
        _state["tokens"][tok] = {
            "link": item.get("link"),
            "title": item.get("title", ""),
            "excerpt": item.get("body") or item.get("summary") or "",
        }
        # bound the token map (drop oldest insertions)
        if len(_state["tokens"]) > _MAX_TOKENS:
            for k in list(_state["tokens"])[:-_MAX_TOKENS]:
                _state["tokens"].pop(k, None)
    return tok


def _headline_text(item: dict) -> str:
    title = html.escape(item.get("title", "(untitled)"))
    src = html.escape(" + ".join(item.get("sources", []) or []))
    when = ""
    if item.get("pubdate"):
        try:
            from datetime import datetime
            dt = datetime.fromisoformat(item["pubdate"])
            when = dt.astimezone().strftime("%d %b, %H:%M")
        except Exception:
            when = ""
    meta = " · ".join(x for x in (src, when) if x)
    return f"<b>{title}</b>\n<i>{meta}</i>" if meta else f"<b>{title}</b>"


def _send_headline(chat_id, item: dict):
    tok = _token_for(item)
    header = _headline_text(item)
    # Stash the rendered header so the Summarize tap can rebuild the message and append the summary
    # to it in place (edit), rather than sending a separate reply.
    with _lock:
        if tok in _state["tokens"]:
            _state["tokens"][tok]["header"] = header
    buttons = [[{"text": "✦ Summarize", "callback_data": f"s:{tok}"}]]
    if item.get("link"):
        buttons.append([{"text": "📰 Read article", "url": item["link"]}])
    _api("sendMessage", chat_id=chat_id, text=header,
         parse_mode="HTML", disable_web_page_preview=True,
         reply_markup={"inline_keyboard": buttons})


def push_new(items: list[dict]):
    """Called from the RSS cycle. Sends market-relevant, recent, not-yet-pushed headlines to every
    subscribed chat. No-op if the bot isn't configured or nobody has subscribed."""
    if not _API:
        return
    with _lock:
        chat_ids = list(_state["chat_ids"])
        pushed = set(_state["pushed"])
    if not chat_ids:
        return  # nobody subscribed — don't consume items, they'll flow once someone /starts

    now = time.time()
    fresh = []
    for it in items:
        link = it.get("link")
        if not link or link in pushed:
            continue
        # No relevance filter — every headline is pushed (per user request).
        # recency guard so enabling the bot doesn't dump the whole 24h backlog at once
        pub = it.get("pubdate")
        if pub:
            try:
                from datetime import datetime, timezone
                dt = datetime.fromisoformat(pub)
                if not dt.tzinfo:
                    dt = dt.replace(tzinfo=timezone.utc)
                if now - dt.timestamp() > _PUSH_MAX_AGE:
                    continue
            except Exception:
                pass
        fresh.append(it)

    fresh = fresh[:_PUSH_PER_CYCLE]
    if not fresh:
        return

    for it in fresh:
        for cid in chat_ids:
            _send_headline(cid, it)
    with _lock:
        _state["pushed"].extend(it["link"] for it in fresh)
        _state["pushed"] = _state["pushed"][-_MAX_PUSHED:]
        _save()


# ── outbound: categorized 30-min digest ──────────────────────────────
def _allowed_categories(chat_id) -> set:
    with _lock:
        chosen = _state.get("categories", {}).get(str(chat_id))
    return set(chosen) if chosen is not None else set(CATEGORIES)


def _digest_markup(tok, link, members, expanded):
    """Inline keyboard for a digest item: Summarize, Read later, Read, and — when the story was
    merged from 2+ headlines — a fold/unfold toggle for the related headlines."""
    rows = [[{"text": "✦ Summarize", "callback_data": f"s:{tok}"},
             {"text": "🔖 Read later", "callback_data": f"rl:{tok}"}]]
    if link:
        rows.append([{"text": "📰 Read article", "url": link}])
    if members and len(members) > 1:
        if expanded:
            rows.append([{"text": f"▴ Hide {len(members)} related", "callback_data": f"dc:{tok}"}])
        else:
            rows.append([{"text": f"▾ Show {len(members)} related", "callback_data": f"dx:{tok}"}])
    return {"inline_keyboard": rows}


def _related_html(members):
    lines = []
    for m in members:
        t = html.escape(m.get("title", "")); src = html.escape(m.get("source", "")); ln = m.get("link", "")
        label = f'<a href="{html.escape(ln)}">{t}</a>' if ln else t
        lines.append(f"• {label}" + (f" — <i>{src}</i>" if src else ""))
    return "\n".join(lines)


def _send_digest_item(chat_id, cluster: dict):
    cat = cluster.get("category") or "Other"
    members = cluster.get("members") or []
    item = {
        "title": cluster.get("headline", ""),
        "link": cluster.get("link", ""),
        "sources": cluster.get("sources", []),
        "body": cluster.get("note", ""),
    }
    tok = _token_for(item)
    emoji = CATEGORY_EMOJI.get(cat, "📰")
    title = html.escape(item["title"] or "(untitled)")
    src = html.escape(" + ".join(item["sources"] or []))   # all outlets that carried the story
    detail = ("\n" + html.escape(cluster["detail"])) if cluster.get("detail") else ""
    note = ("\n" + html.escape(cluster["note"])) if cluster.get("note") else ""
    header = (f"{emoji} <b>{html.escape(cat)}</b>\n<b>{title}</b>"
              + detail + (f"\n<i>{src}</i>" if src else "") + note)
    with _lock:
        if tok in _state["tokens"]:
            _state["tokens"][tok]["header"] = header
            _state["tokens"][tok]["members"] = members
            _state["tokens"][tok]["source"] = " + ".join(item["sources"] or [])  # for Read Later
    _api("sendMessage", chat_id=chat_id, text=header[:4096], parse_mode="HTML",
         disable_web_page_preview=True,
         reply_markup=_digest_markup(tok, item["link"], members, expanded=False))


# ── consolidated digest: ONE message per run, numbered list + 🔖/✦ button banks ──────
_MAX_PER_MSG = int(os.environ.get("TELEGRAM_DIGEST_PER_MSG", "20"))  # keep under 4096 chars / 100 btns
_MAX_BATCHES = 60
_NEWS_APP_URL = os.environ.get("NEWS_APP_URL", "https://uditmathur.uk")


def _rel_time(pubdate: str) -> str:
    from datetime import datetime, timezone
    try:
        dt = datetime.fromisoformat(pubdate)
        if not dt.tzinfo:
            dt = dt.replace(tzinfo=timezone.utc)
        secs = (datetime.now(timezone.utc) - dt).total_seconds()
        if secs < 60:
            return "just now"
        if secs < 3600:
            return f"{int(secs // 60)}m ago"
        if secs < 86400:
            return f"{int(secs // 3600)}h ago"
        return f"{int(secs // 86400)}d ago"
    except Exception:
        return ""


def _batch_keyboard(batch_id: str, n: int, saved: set) -> dict:
    def chunk(btns, size=6):
        return [btns[i:i + size] for i in range(0, len(btns), size)]
    save_btns = [{"text": f"{'✅' if i in saved else '🔖'}{i}", "callback_data": f"rln:{batch_id}:{i}"}
                 for i in range(1, n + 1)]
    sum_btns = [{"text": f"✦{i}", "callback_data": f"sn:{batch_id}:{i}"} for i in range(1, n + 1)]
    rows = chunk(save_btns) + chunk(sum_btns)
    rows.append([{"text": "🗂 Open News Coverage", "url": _NEWS_APP_URL}])
    return {"inline_keyboard": rows}


def _send_consolidated_digest(chat_id, items: list[dict]):
    """Send ONE digest message for `items` (already category-sorted): numbered, linked headlines
    with source + relative time, plus 🔖n (save to Read Later) and ✦n (summarize) button banks.
    Stores a batch so the numbered buttons resolve later."""
    toks = []
    lines = [f"🗞 <b>News</b> — {len(items)} new\n<i>🔖 n = save · ✦ n = summarize · tap a headline to read</i>"]
    last_cat = None
    for idx, c in enumerate(items, 1):
        cat = c.get("category") or "Other"
        title = c.get("headline", "") or "(untitled)"
        link = c.get("link", "")
        srcs = c.get("sources") or []
        item = {"title": title, "link": link, "sources": srcs,
                "body": c.get("detail") or c.get("note") or ""}
        tok = _token_for(item)
        with _lock:
            if tok in _state["tokens"]:
                _state["tokens"][tok]["header"] = f"<b>{html.escape(title)}</b>"
                _state["tokens"][tok]["members"] = c.get("members") or []
                _state["tokens"][tok]["source"] = " + ".join(srcs)
        toks.append(tok)
        if cat != last_cat:
            lines.append(f"\n{CATEGORY_EMOJI.get(cat, '📰')} <b>{html.escape(cat)}</b>")
            last_cat = cat
        meta = " · ".join(x for x in (html.escape(" + ".join(srcs)), _rel_time(c.get("pubdate", ""))) if x)
        t = html.escape(title)
        label = f'<a href="{html.escape(link)}">{t}</a>' if link else t
        lines.append(f"{idx}. {label}" + (f" — <i>{meta}</i>" if meta else ""))

    batch_id = hashlib.sha1(f"{chat_id}{time.time()}".encode("utf-8")).hexdigest()[:10]
    with _lock:
        _state["batches"][batch_id] = {"toks": toks, "saved": []}
        if len(_state["batches"]) > _MAX_BATCHES:
            for k in list(_state["batches"])[:-_MAX_BATCHES]:
                _state["batches"].pop(k, None)
        _save()
    _api("sendMessage", chat_id=chat_id, text="\n".join(lines)[:4096], parse_mode="HTML",
         disable_web_page_preview=True, reply_markup=_batch_keyboard(batch_id, len(items), set()))


def push_digest(clusters: list[dict]) -> int:
    """Push ONE consolidated digest message per subscribed chat per run (respecting the per-chat
    category filter): a numbered headline list with 🔖/✦ button banks. Long runs are split into
    pages of _MAX_PER_MSG. Returns the number of messages sent. Called by /news/digest-ingest."""
    if not _API:
        return 0
    with _lock:
        chat_ids = list(_state["chat_ids"])
    if not chat_ids:
        return 0
    cat_order = {c: i for i, c in enumerate(CATEGORIES)}
    sent = 0
    for cid in chat_ids:
        allowed = _allowed_categories(cid)
        items = [c for c in clusters if (c.get("category") or "Other") in allowed]
        if not items:
            continue
        items.sort(key=lambda c: cat_order.get(c.get("category") or "Other", 99))
        for page in range(0, len(items), _MAX_PER_MSG):
            _send_consolidated_digest(cid, items[page:page + _MAX_PER_MSG])
            sent += 1
    return sent


def send_alert(text: str) -> int:
    """Send a plain operational alert (no buttons, ignores category filters) to every subscribed
    chat. Used to notify about routine failures (e.g. Claude login revoked). Works independently of
    the Claude CLI, so it still fires when the digest routine itself can't authenticate."""
    if not _API:
        return 0
    with _lock:
        chat_ids = list(_state["chat_ids"])
    sent = 0
    for cid in chat_ids:
        if _api("sendMessage", chat_id=cid, text=text[:4096], parse_mode="HTML",
                disable_web_page_preview=True):
            sent += 1
    return sent


# ── /categories: per-chat category filter ────────────────────────────
def _categories_keyboard(chat_id):
    allowed = _allowed_categories(chat_id)
    rows = [[{"text": f"{'✅' if c in allowed else '⬜'} {CATEGORY_EMOJI[c]} {c}",
              "callback_data": f"cat:{c}"}] for c in CATEGORIES]
    return {"inline_keyboard": rows}


def _toggle_category(chat_id, cat):
    if cat not in CATEGORIES:
        return
    with _lock:
        cats = _state.setdefault("categories", {})
        cur = cats.get(str(chat_id))
        if cur is None:
            cur = list(CATEGORIES)
        if cat in cur:
            cur.remove(cat)
        else:
            cur.append(cat)
        cats[str(chat_id)] = cur
        _save()


# ── Read Later: per-chat saved headlines with manual read/unread ─────
def _read_later(chat_id) -> list:
    with _lock:
        return _state.setdefault("read_later", {}).setdefault(str(chat_id), [])


def _add_read_later(chat_id, title, link, source) -> bool:
    with _lock:
        items = _state.setdefault("read_later", {}).setdefault(str(chat_id), [])
        if link and any(i.get("link") == link for i in items):
            return False  # dedup by link
        iid = hashlib.sha1((link or title or str(time.time())).encode("utf-8")).hexdigest()[:8]
        items.append({"id": iid, "title": title or "(untitled)", "link": link or "",
                      "source": source or "", "read": False, "ts": time.time()})
        _save()
    return True


# ── Read Later: public API for the dashboard Read Later tab ──────────
# Viewing/managing moved to the uditmathur.uk dashboard (mobile-friendly); the Telegram 🔖 button
# still saves. These aggregate across chats (single-user setup) and act on items by id.
def readlater_all() -> list:
    """All saved items, newest first, each {id, title, link, source, read, ts}."""
    with _lock:
        out = []
        for items in _state.get("read_later", {}).values():
            out.extend(dict(i) for i in items)
    out.sort(key=lambda x: x.get("ts", 0), reverse=True)
    return out


def readlater_set_read(item_id: str, read: bool = True) -> bool:
    with _lock:
        for items in _state.get("read_later", {}).values():
            for i in items:
                if i.get("id") == item_id:
                    i["read"] = bool(read)
                    _save()
                    return True
    return False


def readlater_delete(item_id: str) -> bool:
    with _lock:
        for items in _state.get("read_later", {}).values():
            for idx, i in enumerate(items):
                if i.get("id") == item_id:
                    items.pop(idx)
                    _save()
                    return True
    return False


def readlater_clear_read() -> int:
    """Remove all items marked read across chats. Returns how many were removed."""
    removed = 0
    with _lock:
        for cid, items in _state.get("read_later", {}).items():
            keep = [i for i in items if not i.get("read")]
            removed += len(items) - len(keep)
            _state["read_later"][cid] = keep
        if removed:
            _save()
    return removed


# ── inbound: updates (commands + button taps) ────────────────────────
_WELCOME = (
    "✅ <b>Subscribed to trading news.</b>\n\n"
    "A deduped, categorized news digest arrives here every ~30 minutes. On each headline:\n"
    "• <b>✦ Summarize</b> — an AI TL;DR of the article\n"
    "• <b>📰 Read article</b> — opens the source\n\n"
    "Tap <b>🔖 Read later</b> on any headline to save it — view &amp; manage your saved list "
    "(read/unread) on the dashboard's <b>Read Later</b> tab.\n"
    "Use <b>/categories</b> to choose which categories you receive (Market, Economy, Corporate, "
    "Geopolitical, Entertainment, Sports…).\n"
    "Commands: /categories, /stop to unsubscribe, /help."
)


def _register_chat(chat_id):
    with _lock:
        if chat_id not in _state["chat_ids"]:
            _state["chat_ids"].append(chat_id)
            _save()


def _unregister_chat(chat_id):
    with _lock:
        if chat_id in _state["chat_ids"]:
            _state["chat_ids"].remove(chat_id)
            _save()


def _handle_summarize(cb):
    """Worker: run the summarizer for a tapped headline and reply into the chat."""
    data = cb.get("data", "")
    tok = data.split(":", 1)[1] if ":" in data else ""
    msg = cb.get("message", {})
    chat_id = msg.get("chat", {}).get("id")
    with _lock:
        art = _state["tokens"].get(tok)
    if not art or not chat_id:
        _api("answerCallbackQuery", callback_query_id=cb["id"], text="Sorry, this headline expired.", show_alert=True)
        return
    _api("answerCallbackQuery", callback_query_id=cb["id"], text="Summarizing…")
    res = news_summarize.summarize_article(art.get("link", ""), art.get("title", ""), art.get("excerpt", ""))
    if not res["ok"]:
        # Leave the headline untouched; surface the reason as a transient popup.
        _api("answerCallbackQuery", callback_query_id=cb["id"], text="⚠️ " + res["error"][:190], show_alert=True)
        return

    # Rebuild the message: original headline header + the summary appended in place.
    header = art.get("header") or msg.get("text") or ("<b>" + html.escape(art.get("title", "")) + "</b>")
    note = "\n\n<i>(summarized from the news-feed excerpt — full article was blocked)</i>" if res["source"] == "feed" else ""
    new_text = f"{header}\n\n<b>✦ Summary</b>\n{_md_to_tg_html(res['summary'])}{note}"[:4096]
    # After summarizing, drop the Summarize button (job done); keep Read article if present.
    buttons = [[{"text": "📰 Read article", "url": art["link"]}]] if art.get("link") else []
    _api("editMessageText", chat_id=chat_id, message_id=msg.get("message_id"),
         text=new_text, parse_mode="HTML", disable_web_page_preview=True,
         reply_markup={"inline_keyboard": buttons})


def _handle_fold(cb, expand: bool):
    """Fold/unfold the related headlines under a merged digest item, in place."""
    tok = (cb.get("data") or "").split(":", 1)[1]
    msg = cb.get("message", {})
    chat_id = msg.get("chat", {}).get("id")
    with _lock:
        art = _state["tokens"].get(tok)
    if not art or not chat_id:
        _api("answerCallbackQuery", callback_query_id=cb["id"], text="This item expired.")
        return
    header = art.get("header") or msg.get("text") or ""
    members = art.get("members") or []
    text = header if not expand else f"{header}\n\n<b>Related headlines:</b>\n{_related_html(members)}"
    _api("answerCallbackQuery", callback_query_id=cb["id"])
    _api("editMessageText", chat_id=chat_id, message_id=msg.get("message_id"),
         text=text[:4096], parse_mode="HTML", disable_web_page_preview=True,
         reply_markup=_digest_markup(tok, art.get("link"), members, expanded=expand))


def _handle_save_read_later(cb):
    tok = (cb.get("data") or "").split(":", 1)[1]
    chat_id = cb.get("message", {}).get("chat", {}).get("id")
    with _lock:
        art = _state["tokens"].get(tok)
    if not art or not chat_id:
        _api("answerCallbackQuery", callback_query_id=cb["id"], text="This item expired.")
        return
    added = _add_read_later(chat_id, art.get("title", ""), art.get("link", ""), art.get("source", ""))
    _api("answerCallbackQuery", callback_query_id=cb["id"],
         text="🔖 Saved to Read Later — view it on the dashboard." if added else "Already in Read Later.")


def _resolve_batch_item(cb):
    """(chat_id, msg, batch, n, art) for a 'rln:<batch>:<n>' / 'sn:<batch>:<n>' tap, or None."""
    parts = (cb.get("data") or "").split(":")
    if len(parts) != 3:
        return None
    batch_id, n = parts[1], parts[2]
    if not n.isdigit():
        return None
    n = int(n)
    msg = cb.get("message", {})
    chat_id = msg.get("chat", {}).get("id")
    with _lock:
        batch = _state.get("batches", {}).get(batch_id)
        art = _state["tokens"].get(batch["toks"][n - 1]) if (batch and 1 <= n <= len(batch["toks"])) else None
    if not batch or not art or not chat_id:
        _api("answerCallbackQuery", callback_query_id=cb["id"], text="This digest expired — open News Coverage.")
        return None
    return chat_id, msg, batch_id, batch, n, art


def _handle_batch_read_later(cb):
    r = _resolve_batch_item(cb)
    if not r:
        return
    chat_id, msg, batch_id, batch, n, art = r
    added = _add_read_later(chat_id, art.get("title", ""), art.get("link", ""), art.get("source", ""))
    with _lock:
        saved = set(batch.get("saved", [])); saved.add(n)
        batch["saved"] = sorted(saved)
        _save()
    _api("editMessageReplyMarkup", chat_id=chat_id, message_id=msg.get("message_id"),
         reply_markup=_batch_keyboard(batch_id, len(batch["toks"]), set(batch["saved"])))
    _api("answerCallbackQuery", callback_query_id=cb["id"],
         text=f"🔖 Saved #{n} to Read Later." if added else f"#{n} already saved.")


def _handle_batch_summarize(cb):
    r = _resolve_batch_item(cb)
    if not r:
        return
    chat_id, msg, batch_id, batch, n, art = r
    _api("answerCallbackQuery", callback_query_id=cb["id"], text=f"Summarizing #{n}…")
    res = news_summarize.summarize_article(art.get("link", ""), art.get("title", ""), art.get("excerpt", ""))
    title = html.escape(art.get("title", ""))
    if not res["ok"]:
        _api("sendMessage", chat_id=chat_id, reply_to_message_id=msg.get("message_id"),
             text=f"✦ <b>#{n}</b> {title}\n⚠️ {html.escape(res['error'][:300])}",
             parse_mode="HTML", disable_web_page_preview=True)
        return
    note = "\n<i>(from the feed excerpt — full article was blocked)</i>" if res["source"] == "feed" else ""
    body = _md_to_tg_html(res["summary"])
    _api("sendMessage", chat_id=chat_id, reply_to_message_id=msg.get("message_id"),
         text=f"✦ <b>#{n} Summary</b> — {title}\n{body}{note}"[:4096],
         parse_mode="HTML", disable_web_page_preview=True)


def _handle_update(update: dict):
    if "callback_query" in update:
        cb = update["callback_query"]
        data = cb.get("data") or ""
        if data.startswith("rln:"):
            _handle_batch_read_later(cb)
        elif data.startswith("sn:"):
            threading.Thread(target=_handle_batch_summarize, args=(cb,), daemon=True).start()
        elif data.startswith("s:"):
            threading.Thread(target=_handle_summarize, args=(cb,), daemon=True).start()
        elif data.startswith("dx:") or data.startswith("dc:"):
            _handle_fold(cb, expand=data.startswith("dx:"))
        elif data.startswith("rl:"):
            _handle_save_read_later(cb)
        elif data.startswith("cat:"):
            msg = cb.get("message", {})
            chat_id = msg.get("chat", {}).get("id")
            _toggle_category(chat_id, data.split(":", 1)[1])
            _api("answerCallbackQuery", callback_query_id=cb["id"])
            _api("editMessageReplyMarkup", chat_id=chat_id, message_id=msg.get("message_id"),
                 reply_markup=_categories_keyboard(chat_id))
        else:
            _api("answerCallbackQuery", callback_query_id=cb["id"])
        return

    msg = update.get("message") or update.get("channel_post")
    if not msg:
        return
    chat_id = msg.get("chat", {}).get("id")
    text = (msg.get("text") or "").strip()
    if not chat_id:
        return
    if text.startswith("/start"):
        _register_chat(chat_id)
        _api("sendMessage", chat_id=chat_id, text=_WELCOME, parse_mode="HTML")
    elif text.startswith("/stop"):
        _unregister_chat(chat_id)
        _api("sendMessage", chat_id=chat_id, text="🔕 Unsubscribed. Send /start to resume.")
    elif text.startswith("/categories"):
        _api("sendMessage", chat_id=chat_id,
             text="🗂 <b>Choose which categories to receive.</b>\nTap to toggle — ✅ on, ⬜ off.",
             parse_mode="HTML", reply_markup=_categories_keyboard(chat_id))
    elif text.startswith("/help"):
        _api("sendMessage", chat_id=chat_id, text=_WELCOME, parse_mode="HTML")


# ── long-poll loop ───────────────────────────────────────────────────
def _poll_loop():
    while not _stop.is_set():
        with _lock:
            offset = _state["offset"]
        # Telegram long-poll: hold the connection up to 30s server-side (`timeout`); give the HTTP
        # client a bit longer (`req_timeout`) so it doesn't cut the poll short.
        resp = _api("getUpdates", req_timeout=40, offset=offset + 1, timeout=30)
        if not resp or not resp.get("ok"):
            _stop.wait(3)
            continue
        updates = resp.get("result", [])
        for up in updates:
            try:
                _handle_update(up)
            except Exception:
                pass
            with _lock:
                _state["offset"] = max(_state["offset"], up["update_id"])
        if updates:
            with _lock:
                _save()


def ensure_started():
    global _thread
    if not _TOKEN:
        return  # bot disabled — no token configured
    _load()
    if _thread is None or not _thread.is_alive():
        _stop.clear()
        _thread = threading.Thread(target=_poll_loop, daemon=True)
        _thread.start()
        # Populate the in-app command menu (the "/" button) for a cleaner mobile UX.
        _api("setMyCommands", commands=[
            {"command": "start", "description": "Subscribe to trading news"},
            {"command": "categories", "description": "Choose which news categories to receive"},
            {"command": "stop", "description": "Unsubscribe"},
            {"command": "help", "description": "How this bot works"},
        ])
