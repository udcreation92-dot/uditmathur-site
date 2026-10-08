import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../api";

const REFRESH_MS = 90 * 1000; // dashboard re-pull cadence (backend now polls feeds ~every 60s)
const FETCH_LIMIT = 500; // comfortably above 24h volume even with many feeds added
const PAGE_SIZE = 60; // rendered incrementally as the user scrolls, to keep the DOM light

// Open a link in a BACKGROUND tab so focus stays on the dashboard. Browsers only background a
// new tab on a ctrl/cmd-click, and JS can't force it via window.open — so we intercept a plain
// left-click and re-dispatch it as a synthetic ctrl-click (cmd on macOS). Modifier clicks and
// middle-clicks are left alone to behave as the user expects.
function openInBackgroundTab(e, url) {
  if (!url || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
  const a = document.createElement("a");
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.dispatchEvent(new MouseEvent("click", {
    bubbles: false, cancelable: true, ctrlKey: !isMac, metaKey: isMac,
  }));
}

function ManageSourcesPanel({ sources, onChanged, onClose }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState(null);
  const [removingName, setRemovingName] = useState(null);

  async function submit() {
    if (!name.trim() || !url.trim()) return;
    setAdding(true); setError(null);
    try {
      await api.addRssSource(name.trim(), url.trim());
      setName(""); setUrl("");
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setAdding(false);
    }
  }

  async function remove(sourceName) {
    setRemovingName(sourceName); setError(null);
    try {
      await api.deleteRssSource(sourceName);
      onChanged();
    } catch (err) {
      setError(err.message);
    } finally {
      setRemovingName(null);
    }
  }

  return (
    <div className="p-3 border-b border-gray-800 space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold text-gray-300">Manage Feeds</h4>
        <button onClick={onClose} className="text-[10px] text-gray-500 hover:text-gray-300">Close</button>
      </div>

      <div className="space-y-1.5">
        {sources.map(s => (
          <div key={s.name} className="flex items-center gap-2 text-xs">
            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${s.ok ? "bg-green-500" : "bg-red-500"}`} title={s.error || "OK"} />
            <span className="text-gray-300 truncate flex-1" title={s.url}>{s.name}</span>
            <button onClick={() => remove(s.name)} disabled={removingName === s.name}
              className="text-[10px] text-gray-500 hover:text-red-400 disabled:opacity-50">
              {removingName === s.name ? "…" : "Remove"}
            </button>
          </div>
        ))}
      </div>

      <div className="space-y-1.5 pt-1 border-t border-gray-800">
        <input value={name} onChange={e => setName(e.target.value)} placeholder="Feed name"
          className="input-field text-xs w-full" />
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="RSS feed URL"
          className="input-field text-xs w-full" />
        <button onClick={submit} disabled={adding || !name.trim() || !url.trim()}
          className="w-full py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded text-xs font-medium">
          {adding ? "Validating…" : "Add Feed"}
        </button>
        {error && <p className="text-red-400 text-[10px]">{error}</p>}
      </div>
    </div>
  );
}

// Manual-only brief: never generated automatically — each click summarizes the feed items
// published since the LAST brief (capped at the past 2 hours by the backend).
function MarketBrief() {
  const [state, setState] = useState({ brief: null, generated_at: null });
  const [message, setMessage] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // On mount only fetch the last generated brief (no LLM call).
  useEffect(() => {
    api.getRssBrief().then(setState).catch(() => {});
  }, []);

  async function generate() {
    setLoading(true); setError(null); setMessage(null);
    try {
      const res = await api.generateRssBrief();
      setState({ brief: res.brief, generated_at: res.generated_at });
      if (res.message) setMessage(res.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-3 border-b border-gray-800 bg-blue-950/20">
      <div className="flex items-center justify-between mb-1">
        <h4 className="text-[10px] font-semibold text-blue-300 uppercase tracking-wide">
          Market Brief
          {state.generated_at && (
            <span className="ml-1.5 text-gray-500 normal-case font-normal">
              {new Date(state.generated_at * 1000).toLocaleTimeString()}
            </span>
          )}
        </h4>
        <button onClick={generate} disabled={loading}
          className="text-[10px] text-gray-300 hover:text-white border border-gray-700 rounded px-2 py-0.5 disabled:opacity-50">
          {loading ? "Summarizing…" : "Brief me"}
        </button>
      </div>
      {error && <p className="text-red-400 text-[10px]">{error}</p>}
      {message && <p className="text-yellow-400 text-[10px]">{message}</p>}
      {state.brief
        ? <p className="text-xs text-gray-300 leading-snug">{state.brief}</p>
        : !loading && !message && <p className="text-[10px] text-gray-500">Click "Brief me" for a summary of news since your last brief (max last 2h).</p>}
    </div>
  );
}

// One headline row. On touch devices it can be swiped LEFT to summarize the article (revealing an
// "✦ Summarize" affordance) — the mobile equivalent of the Drag-to-Summarize extension. A genuine
// tap still opens the article; a horizontal drag is treated as a swipe, not a tap, and a vertical
// drag is left to scroll the list. A "Summarize" button covers non-touch (desktop) clicks.
function NewsItem({ item, isNew, isUnviewed, onMarkViewed, onSummarize }) {
  const [dx, setDx] = useState(0);
  // dxRef mirrors the live offset synchronously — onTouchEnd decides off the ref, not the async
  // `dx` state (which may not have flushed by the time the gesture ends).
  const startX = useRef(0), startY = useRef(0), moved = useRef(false), horiz = useRef(false), dxRef = useRef(0);
  const THRESHOLD = 70; // px past which release triggers the summary

  function onTouchStart(e) {
    const t = e.touches[0];
    startX.current = t.clientX; startY.current = t.clientY;
    moved.current = false; horiz.current = false; dxRef.current = 0;
  }
  function onTouchMove(e) {
    const t = e.touches[0];
    const dX = t.clientX - startX.current, dY = t.clientY - startY.current;
    if (!horiz.current) {
      // Lock the gesture: horizontal (swipe) vs vertical (scroll). Vertical passes through.
      if (Math.abs(dX) > 8 && Math.abs(dX) > Math.abs(dY)) horiz.current = true;
      else return;
    }
    moved.current = true;
    const clamped = Math.max(Math.min(dX, 0), -140); // left only, clamped
    dxRef.current = clamped;
    setDx(clamped);
    if (e.cancelable) e.preventDefault();    // stop the list scrolling while swiping sideways
  }
  function onTouchEnd() {
    if (horiz.current && dxRef.current <= -THRESHOLD) {
      onMarkViewed(item.link);
      onSummarize(item);
    }
    dxRef.current = 0;
    setDx(0);
    horiz.current = false;
    setTimeout(() => { moved.current = false; }, 60); // let the trailing click see it was a swipe
  }
  function onClick(e) {
    if (moved.current) { e.preventDefault(); e.stopPropagation(); return; } // swipe, not a tap
    onMarkViewed(item.link);
    openInBackgroundTab(e, item.link);
  }

  const revealOpacity = Math.min(Math.abs(dx) / THRESHOLD, 1);

  return (
    <div className="relative overflow-hidden">
      {/* Revealed behind the card as it slides left (mobile swipe-to-summarize). */}
      <div className="absolute inset-y-0 right-0 flex items-center gap-1 pr-3 text-blue-300 text-[11px] font-semibold pointer-events-none"
        style={{ opacity: revealOpacity }} aria-hidden="true">✦ Summarize</div>
      <a href={item.link} target="_blank" rel="noopener noreferrer"
        onMouseEnter={() => onMarkViewed(item.link)}
        onClick={onClick}
        onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dx ? "none" : "transform .2s ease", touchAction: "pan-y" }}
        className={`relative block bg-gray-900 border-b pb-2 hover:bg-gray-800/40 rounded px-1.5 -mx-1.5 ${
          isNew ? "border-l-2 border-l-green-500 bg-green-900/10 border-gray-800/50" : "border-gray-800/50"
        }`}>
        <p className={`text-[13px] sm:text-xs leading-snug flex items-start gap-1.5 ${isUnviewed ? "text-white font-medium" : "text-gray-400"}`}>
          {isUnviewed && <span className="w-1.5 h-1.5 rounded-full bg-blue-500 mt-1 flex-shrink-0" title="Not yet viewed" />}
          <span>
            {item.title}
            {isNew && <span className="ml-1.5 text-[9px] text-green-400 font-semibold align-middle">NEW</span>}
          </span>
        </p>
        <p className="text-[10px] text-gray-500 mt-1 flex items-center gap-2">
          <span className="min-w-0 truncate">
            {item.sources.join(" + ")} · {item.pubdate ? new Date(item.pubdate).toLocaleString() : ""}
          </span>
          <button
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onMarkViewed(item.link); onSummarize(item); }}
            className="ml-auto flex-shrink-0 text-[10px] text-blue-300 hover:text-white border border-blue-800/60 rounded px-1.5 py-0.5">
            ✦ Summarize
          </button>
        </p>
        {item.bulletin?.is_corporate_action && (
          <p className="text-[9px] text-purple-300 mt-1 border-l-2 border-purple-700 pl-1.5">
            {item.bulletin.action_type}
            {item.bulletin.symbols?.length > 0 && ` · ${item.bulletin.symbols.join(", ")}`}
            {item.bulletin.effective_date && ` · eff. ${item.bulletin.effective_date}`}
          </p>
        )}
      </a>
    </div>
  );
}

// Minimal, safe Markdown → HTML for the DeepSeek summary: escape first, then only re-introduce
// our own <strong> and bullet markers. No raw HTML from the model ever reaches the DOM.
function renderSummaryHtml(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc(md || "")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^\s*[-*]\s+/gm, "• ");
}

// Bottom-sheet summary of one headline, produced server-side via DeepSeek (the mobile
// equivalent of the Drag-to-Summarize extension). Fetches once per opened item.
function SummarySheet({ item, onClose }) {
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState(null);
  const [source, setSource] = useState(null); // "article" | "feed"
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true); setSummary(null); setSource(null); setError(null);
    api.summarizeRss(item.link, item.title, item.body || item.summary)
      .then(res => { if (alive) { setSummary(res.summary); setSource(res.source); } })
      .catch(err => { if (alive) setError(err.message || "Failed to summarize."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [item.link, item.title]);

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
      onClick={onClose}>
      <div className="absolute inset-0 bg-black/60" />
      <div onClick={e => e.stopPropagation()}
        className="relative w-full sm:max-w-lg max-h-[80vh] flex flex-col bg-gray-900 border border-gray-800 rounded-t-2xl sm:rounded-2xl shadow-2xl">
        <div className="flex items-start gap-2 p-3 border-b border-gray-800">
          <div className="min-w-0 flex-1">
            <p className="text-[10px] text-blue-300 font-semibold uppercase tracking-wide">✦ AI Summary</p>
            <p className="text-sm text-gray-100 mt-0.5 leading-snug">{item.title}</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-lg leading-none px-1">×</button>
        </div>

        <div className="p-3 overflow-y-auto">
          {loading && <p className="text-xs text-gray-400">Reading the article and summarizing…</p>}
          {error && <p className="text-xs text-red-400">{error}</p>}
          {summary && (
            <>
              {source === "feed" && (
                <p className="text-[10px] text-yellow-400/90 mb-2 border-l-2 border-yellow-700 pl-2">
                  Full article was blocked (subscription/paywall lives in your browser, not the
                  server) — summarized from the news feed excerpt. Open the full article to read it
                  in your logged-in session.
                </p>
              )}
              <div className="text-[13px] text-gray-200 leading-relaxed whitespace-pre-wrap"
                dangerouslySetInnerHTML={{ __html: renderSummaryHtml(summary) }} />
            </>
          )}
        </div>

        <div className="p-3 border-t border-gray-800 flex justify-end">
          <a href={item.link} target="_blank" rel="noopener noreferrer"
            className="text-xs text-gray-300 hover:text-white border border-gray-700 rounded px-3 py-1.5">
            Open full article ↗
          </a>
        </div>
      </div>
    </div>
  );
}

export default function NewsSidebar({ fullPage = false }) {
  const [allItems, setAllItems] = useState([]);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [sources, setSources] = useState([]);
  const [sourceFilter, setSourceFilter] = useState("");
  const [showManage, setShowManage] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [error, setError] = useState(null);
  const [summaryItem, setSummaryItem] = useState(null); // headline currently being summarized
  const [refreshing, setRefreshing] = useState(false);
  const [recentLinks, setRecentLinks] = useState(new Set());
  const [viewedLinks, setViewedLinks] = useState(new Set());
  // Unread-only filters against this snapshot, not live viewedLinks — otherwise hovering an
  // item (which marks it viewed) would make it vanish from under the cursor mid-read. The
  // snapshot refreshes on each poll/toggle, so viewed items clear out on the next refresh.
  const [unreadSnapshot, setUnreadSnapshot] = useState(new Set());
  const viewedRef = useRef(viewedLinks);
  viewedRef.current = viewedLinks;
  const prevLinksRef = useRef(null); // null = no poll yet, so first load never marks everything "new"
  const listRef = useRef(null);
  const sentinelRef = useRef(null);
  const filteredLenRef = useRef(0); // read inside the IntersectionObserver callback

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    try {
      const [feed, srcs] = await Promise.all([
        api.getRssFeed(FETCH_LIMIT, sourceFilter || undefined),
        api.getRssSources(),
      ]);
      const newItems = Array.isArray(feed) ? feed : [];
      const newLinks = new Set(newItems.map(i => i.link));
      if (prevLinksRef.current) {
        const justArrived = new Set([...newLinks].filter(l => !prevLinksRef.current.has(l)));
        setRecentLinks(justArrived);
      }
      prevLinksRef.current = newLinks;
      setAllItems(newItems);
      setSources(Array.isArray(srcs) ? srcs : []);
      setUnreadSnapshot(new Set(viewedRef.current));
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      if (manual) setRefreshing(false);
    }
  }, [sourceFilter]);

  useEffect(() => {
    setVisibleCount(PAGE_SIZE); // switching sources starts the incremental render over
    load();
    const interval = setInterval(load, REFRESH_MS);
    return () => clearInterval(interval);
  }, [load]);

  // Gentle auto-scroll: while the cursor is inside the feed area, creep the list downward so
  // headlines drift past on their own. Fractional accumulator keeps it smooth (sub-pixel per
  // frame). A manual wheel scroll pauses it briefly so it never fights the user. As content
  // scrolls under the stationary cursor, items' mouseenter fires and marks them viewed.
  // Native mouseenter/leave listeners (not React's synthetic props) so hover tracking is
  // reliable and directly testable.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const TICK_MS = 40;
    const STEP_PX = 0.6; // ~15px/sec at 40ms — slow, readable drift
    let acc = 0, pausedUntil = 0, hovering = false;

    // setInterval rather than requestAnimationFrame: rAF is fully paused in background/hidden
    // tabs, so the drift would stall whenever the dashboard isn't the foreground tab.
    const id = setInterval(() => {
      if (!hovering || performance.now() < pausedUntil) return;
      acc += STEP_PX;
      if (acc < 1) return;
      const whole = Math.floor(acc);
      acc -= whole;
      // Drive whichever element actually scrolls: the inner list when it's the scroll container
      // (desktop sidebar / wide full-page), otherwise the page itself (mobile / narrow full-page,
      // where the container is h-auto and the window scrolls). Previously this only ever moved the
      // inner list, so drift silently did nothing on narrow windows.
      if (el.scrollHeight - el.clientHeight > 4) {
        if (el.scrollTop + el.clientHeight < el.scrollHeight - 1) el.scrollTop += whole;
      } else {
        const doc = document.scrollingElement || document.documentElement;
        if (doc.scrollTop + doc.clientHeight < doc.scrollHeight - 1) window.scrollBy(0, whole);
      }
    }, TICK_MS);

    const onEnter = () => { hovering = true; };
    const onLeave = () => { hovering = false; };
    const onWheel = () => { pausedUntil = performance.now() + 2000; };
    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
    el.addEventListener("wheel", onWheel, { passive: true });
    // A page-level wheel also counts as the user taking over when the window is the scroller.
    window.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      clearInterval(id);
      el.removeEventListener("mouseenter", onEnter);
      el.removeEventListener("mouseleave", onLeave);
      el.removeEventListener("wheel", onWheel);
      window.removeEventListener("wheel", onWheel);
    };
  }, []);

  function markViewed(link) {
    setViewedLinks(prev => (prev.has(link) ? prev : new Set(prev).add(link)));
  }

  function handleScroll() {
    const el = listRef.current;
    if (!el) return;
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
      setVisibleCount(c => Math.min(c + PAGE_SIZE, filteredItems.length));
    }
  }

  // Load-more that works whether the inner list scrolls (desktop) or the whole page scrolls
  // (mobile full-page). A sentinel at the bottom of the list triggers the next page as it nears
  // the viewport — independent of which element is the scroll container.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting) {
        setVisibleCount(c => (c < filteredLenRef.current ? Math.min(c + PAGE_SIZE, filteredLenRef.current) : c));
      }
    }, { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // No relevance filter — show every headline. Only the unread-only toggle narrows the list.
  let filteredItems = allItems;
  if (unreadOnly) filteredItems = filteredItems.filter(i => !unreadSnapshot.has(i.link));
  filteredLenRef.current = filteredItems.length;
  const items = filteredItems.slice(0, visibleCount);
  const brokenSources = sources.filter(s => !s.ok);

  return (
    <>
    <div className={`flex flex-col bg-gray-900 border border-gray-800 rounded-lg overflow-hidden ${
      fullPage
        ? "w-full h-auto lg:h-[calc(100vh-9rem)]"
        : "w-full h-[75vh] xl:sticky xl:top-4 xl:h-[calc(100vh-2rem)] xl:w-[340px]"
    }`}>
      <div className="p-3 border-b border-gray-800">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-200">Market News & Bulletins</h3>
          <div className="flex items-center gap-1.5">
            <button onClick={() => load(true)} disabled={refreshing}
              className="text-[10px] text-gray-400 hover:text-white border border-gray-700 rounded px-2 py-0.5 disabled:opacity-50">
              {refreshing ? "…" : "Refresh"}
            </button>
            <button onClick={() => setShowManage(m => !m)} className="text-[10px] text-gray-400 hover:text-white border border-gray-700 rounded px-2 py-0.5">
              {showManage ? "Hide" : "Manage"}
            </button>
          </div>
        </div>
        <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)}
          className="w-full bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-300">
          <option value="">All sources</option>
          {sources.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
        </select>
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          <label className="flex items-center gap-1.5 text-[10px] text-gray-400 cursor-pointer ml-auto">
            <input type="checkbox" checked={unreadOnly} onChange={e => {
              setUnreadOnly(e.target.checked);
              setUnreadSnapshot(new Set(viewedRef.current));
              setVisibleCount(PAGE_SIZE);
            }} />
            Unread only
          </label>
        </div>
        {brokenSources.length > 0 && (
          <p className="text-[10px] text-yellow-400 mt-2">
            ⚠ {brokenSources.length} feed{brokenSources.length > 1 ? "s" : ""} not responding: {brokenSources.map(s => s.name).join(", ")}
          </p>
        )}
      </div>

      {showManage && (
        <ManageSourcesPanel sources={sources} onChanged={load} onClose={() => setShowManage(false)} />
      )}

      <MarketBrief />

      <div ref={listRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-3 space-y-3">
        {error && <p className="text-red-400 text-xs">{error}</p>}
        {items.length === 0 && !error && (
          <p className="text-gray-500 text-xs">
            {allItems.length === 0 ? "Loading feed…"
              : unreadOnly ? "All caught up — no unread items here."
              : "No headlines yet."}
          </p>
        )}
        {items.length > 0 && (
          <p className="sm:hidden text-[10px] text-gray-600 text-center pb-1">← swipe a headline to summarize it</p>
        )}
        {items.map((item, i) => (
          <NewsItem key={item.link || i} item={item} isNew={recentLinks.has(item.link)}
            isUnviewed={!viewedLinks.has(item.link)}
            onMarkViewed={markViewed} onSummarize={setSummaryItem} />
        ))}
        {visibleCount < filteredItems.length && (
          <p className="text-center text-[10px] text-gray-600 py-1">
            Showing {visibleCount} of {filteredItems.length} · scroll for more
          </p>
        )}
        <div ref={sentinelRef} aria-hidden="true" className="h-px" />
      </div>
    </div>

    {summaryItem && <SummarySheet item={summaryItem} onClose={() => setSummaryItem(null)} />}
    </>
  );
}
