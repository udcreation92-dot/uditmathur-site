"""Shared article-summarization used by both the web /rss/summarize route and the Telegram news
bot. Fetches the article server-side, extracts readable text (JSON-LD articleBody first, then main
content), and summarizes via the Claude Pro subscription (claude_cli, headless `claude -p` on
Haiku — no API cost). Falls back to the RSS excerpt when the live fetch is blocked (403 paywalls),
so the caller still gets something rather than a hard error."""
import json
import requests
from bs4 import BeautifulSoup
import claude_cli

# Browser-like UA so publishers serve the full article rather than a bot stub.
_ARTICLE_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)


def extract_article(html: str) -> str:
    """Best-effort readable-text extraction: JSON-LD articleBody first (often the full text even
    when visually paywalled), then the main content container, then the longest run of paragraphs."""
    soup = BeautifulSoup(html, "html.parser")

    best = ""
    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        try:
            data = json.loads(tag.string or "")
        except Exception:
            continue
        stack = [data]
        while stack:
            node = stack.pop()
            if isinstance(node, dict):
                body = node.get("articleBody")
                if isinstance(body, str) and len(body) > len(best):
                    best = body
                stack.extend(node.values())
            elif isinstance(node, list):
                stack.extend(node)
    if len(best) > 400:
        return " ".join(best.split())[:12000]

    root = None
    for sel in ["article", "[role=main]", "main", "#content", ".article-body", ".post-content"]:
        root = soup.select_one(sel)
        if root:
            break
    root = root or soup.body or soup

    parts = []
    for el in root.find_all(["p", "h2", "h3", "li"]):
        t = " ".join(el.get_text().split())
        if len(t) > 40:
            parts.append(t)
    text = "\n".join(parts)
    if len(text) < 200:
        text = " ".join(soup.get_text().split())
    return text[:12000]


def summarize_article(url: str, title: str = "", fallback_text: str = "") -> dict:
    """Returns {ok, summary, source, title, url} on success, or {ok: False, status, error}.
    `source` is "article" (full page) or "feed" (RSS excerpt fallback)."""
    url = (url or "").strip()
    if not url.startswith(("http://", "https://")):
        return {"ok": False, "status": 400, "error": "A valid article URL is required."}
    if not claude_cli.is_configured():
        return {"ok": False, "status": 503, "error": "Claude CLI not available for summarization."}

    text, fetch_error = "", None
    try:
        resp = requests.get(url, headers={"User-Agent": _ARTICLE_UA}, timeout=15)
        resp.raise_for_status()
        text = extract_article(resp.text)
    except Exception as e:
        fetch_error = str(e)

    source = "article"
    if len(text) < 200:
        fallback = (fallback_text or "").strip()
        if len(fallback) >= 120:
            text, source = fallback, "feed"
        else:
            hint = " (the site blocked the server-side request)" if fetch_error else ""
            return {"ok": False, "status": 422,
                    "error": f"Couldn't read the full article{hint}, and the feed excerpt was too "
                             "short to summarize. Open the full article to read it in your logged-in session."}

    title = (title or "").strip()
    if source == "feed":
        instruction = (
            "The text below is a SHORT news excerpt (not the full article). Summarize only what "
            "it actually states — do not infer or invent additional detail. Write a one-line "
            "**TL;DR**, then up to 3 bullet points if the excerpt supports them."
        )
    else:
        instruction = (
            "Summarize the news article below for a trader. Write a one-line **TL;DR**, then "
            "4-5 key bullet points. Never invent facts not in the text."
        )

    summary = claude_cli.run(
        prompt=f"{instruction} Output GitHub-flavored Markdown.\n\nTITLE: {title}\n\nTEXT:\n{text}",
        system="You summarize financial-news articles accurately and concisely.",
    )
    if not summary:
        return {"ok": False, "status": 502, "error": "The summarization model did not return a result."}
    return {"ok": True, "summary": summary, "source": source, "title": title, "url": url}
