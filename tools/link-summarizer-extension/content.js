// Drag-to-Summarize — content script.
// Shows a "drop link to summarize" target at the top of the page during a link
// drag, and renders the returned summary in a floating panel. All UI lives in a
// shadow root so the host page's CSS can't break it (and vice versa).
(() => {
  if (window.__dtsInjected) return;
  window.__dtsInjected = true;

  const host = document.createElement('div');
  host.id = 'dts-host';
  const shadow = host.attachShadow({ mode: 'open' });
  document.documentElement.appendChild(host);

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      .zone {
        position: fixed; top: 0; left: 0; right: 0; height: 64px;
        display: none; align-items: center; justify-content: center;
        background: linear-gradient(180deg, rgba(37,99,235,.96), rgba(37,99,235,.75));
        color: #fff; font-size: 15px; font-weight: 600; letter-spacing: .3px;
        z-index: 2147483647; pointer-events: none;
      }
      .zone.show { display: flex; }
      .zone.over { background: linear-gradient(180deg, rgba(22,163,74,.97), rgba(22,163,74,.8)); }
      .zone .inner { pointer-events: auto; padding: 8px 18px; border: 2px dashed rgba(255,255,255,.7); border-radius: 10px; }

      .panel {
        position: fixed; top: 16px; right: 16px; width: 380px; max-width: calc(100vw - 32px);
        max-height: calc(100vh - 32px); display: none; flex-direction: column;
        background: #0f172a; color: #e2e8f0; border: 1px solid #1e293b;
        border-radius: 14px; box-shadow: 0 20px 50px rgba(0,0,0,.5);
        z-index: 2147483647; overflow: hidden;
      }
      .panel.show { display: flex; }
      .hd { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #1e293b; }
      .hd .t { font-size: 13px; font-weight: 700; color: #93c5fd; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .hd button { all: unset; cursor: pointer; color: #94a3b8; font-size: 18px; line-height: 1; padding: 2px 6px; border-radius: 6px; }
      .hd button:hover { background: #1e293b; color: #e2e8f0; }
      .bd { padding: 14px; overflow: auto; font-size: 13.5px; line-height: 1.55; }
      .bd h3 { font-size: 14px; margin: 10px 0 6px; color: #f8fafc; }
      .bd ul { padding-left: 18px; margin: 6px 0; }
      .bd li { margin: 4px 0; }
      .bd p { margin: 8px 0; }
      .bd strong { color: #fff; }
      .bd code { background: #1e293b; padding: 1px 5px; border-radius: 4px; font-size: 12px; }
      .spin { display: flex; align-items: center; gap: 10px; color: #94a3b8; font-size: 13px; }
      .dot { width: 12px; height: 12px; border-radius: 50%; border: 2px solid #334155; border-top-color: #60a5fa; animation: sp .8s linear infinite; }
      @keyframes sp { to { transform: rotate(360deg); } }
      .err { color: #fca5a5; font-size: 13px; }
      .src { font-size: 11px; color: #64748b; margin-top: 12px; word-break: break-all; }
      .qa { margin-top: 12px; padding-top: 10px; border-top: 1px solid #1e293b; display: flex; flex-direction: column; gap: 8px; }
      .msg { max-width: 90%; padding: 7px 10px; border-radius: 10px; font-size: 13px; line-height: 1.5; }
      .msg.u { align-self: flex-end; background: #2563eb; color: #fff; }
      .msg.a { align-self: flex-start; background: #1e293b; color: #e2e8f0; }
      .msg.a h3 { font-size: 13px; margin: 6px 0 4px; }
      .msg.a ul { padding-left: 16px; margin: 4px 0; }
      .ask { padding: 8px 12px; border-top: 1px solid #1e293b; display: none; gap: 6px; }
      .ask.show { display: flex; }
      .ask input { flex: 1; background: #0b1220; color: #e2e8f0; border: 1px solid #334155; border-radius: 8px; padding: 7px 10px; font-size: 13px; }
      .ask input:focus { outline: none; border-color: #60a5fa; }
      .ask button { all: unset; cursor: pointer; color: #93c5fd; font-size: 13px; font-weight: 600; padding: 0 8px; }
      .ft { padding: 8px 14px; border-top: 1px solid #1e293b; display: flex; gap: 6px; }
      .ft button { all: unset; cursor: pointer; font-size: 12px; color: #93c5fd; padding: 4px 8px; border-radius: 6px; }
      .ft button:hover { background: #1e293b; }
    </style>
    <div class="zone" id="zone"><div class="inner">&#11015; Drop link to summarize</div></div>
    <div class="panel" id="panel">
      <div class="hd"><div class="t" id="ptitle">Summary</div><button id="close" title="Close">&times;</button></div>
      <div class="bd" id="body"></div>
      <div class="ask" id="ask">
        <input id="q" type="text" placeholder="Ask a question about this article…" />
        <button id="send">Ask</button>
      </div>
      <div class="ft"><button id="copy">Copy</button><button id="open">Open link &#8599;</button></div>
    </div>
  `;

  const zone = shadow.getElementById('zone');
  const panel = shadow.getElementById('panel');
  const bodyEl = shadow.getElementById('body');
  const titleEl = shadow.getElementById('ptitle');
  const askRow = shadow.getElementById('ask');
  const qInput = shadow.getElementById('q');
  let lastUrl = '';
  let lastSummary = '';
  let lastArticle = null; // { title, text } — context for follow-up questions
  let qaHistory = []; // [{ role, content }] running Q&A turns

  shadow.getElementById('close').onclick = () => panel.classList.remove('show');
  shadow.getElementById('copy').onclick = () => navigator.clipboard.writeText(lastSummary || '').catch(() => {});
  shadow.getElementById('open').onclick = () => lastUrl && window.open(lastUrl, '_blank');
  shadow.getElementById('send').onclick = ask;
  qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') ask(); });

  // ---- drag detection ----
  let dragUrl = '';
  const hasUri = (dt) => dt && Array.from(dt.types || []).includes('text/uri-list');

  document.addEventListener('dragstart', (e) => {
    const a = e.target?.closest?.('a[href]');
    if (a && /^https?:/i.test(a.href)) { dragUrl = a.href; zone.classList.add('show'); }
  }, true);

  document.addEventListener('dragover', (e) => {
    if (hasUri(e.dataTransfer) || dragUrl) zone.classList.add('show');
  }, true);

  document.addEventListener('dragend', () => { zone.classList.remove('show', 'over'); dragUrl = ''; }, true);

  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    const dt = e.dataTransfer;
    const fromList = (dt.getData('text/uri-list') || '').split('\n').find((l) => l && !l.startsWith('#'));
    let url = (fromList || dt.getData('text/plain') || dragUrl || '').trim();
    zone.classList.remove('show', 'over');
    dragUrl = '';
    if (/^https?:/i.test(url)) summarize(url);
  });

  // ---- summarize flow ----
  function summarize(url) {
    lastUrl = url;
    lastSummary = '';
    lastArticle = null;
    qaHistory = [];
    askRow.classList.remove('show');
    titleEl.textContent = 'Summarizing…';
    bodyEl.innerHTML = '<div class="spin"><span class="dot"></span> Fetching &amp; summarizing…</div>';
    panel.classList.add('show');
    chrome.runtime.sendMessage({ type: 'summarize', url }, (res) => {
      if (chrome.runtime.lastError) return showError(chrome.runtime.lastError.message);
      if (!res?.ok) return showError(res?.error || 'Failed.');
      lastSummary = res.summary;
      lastArticle = { title: res.title || '', text: res.text || '' };
      titleEl.textContent = res.title || 'Summary';
      bodyEl.innerHTML =
        mdToHtml(res.summary) + `<div class="src">${escapeHtml(url)}</div><div class="qa" id="qa"></div>`;
      askRow.classList.add('show');
    });
  }

  // ---- follow-up Q&A ----
  function ask() {
    const q = qInput.value.trim();
    if (!q || !lastArticle) return;
    qInput.value = '';
    const log = shadow.getElementById('qa');
    addBubble(log, 'u', escapeHtml(q));
    const thinking = addBubble(log, 'a', '<span class="spin"><span class="dot"></span></span>');
    chrome.runtime.sendMessage(
      { type: 'ask', article: lastArticle, history: qaHistory, question: q },
      (res) => {
        if (chrome.runtime.lastError) { thinking.innerHTML = `<span class="err">${escapeHtml(chrome.runtime.lastError.message)}</span>`; return; }
        if (!res?.ok) { thinking.innerHTML = `<span class="err">${escapeHtml(res?.error || 'Failed.')}</span>`; return; }
        thinking.innerHTML = mdToHtml(res.answer);
        qaHistory.push({ role: 'user', content: q }, { role: 'assistant', content: res.answer });
        bodyEl.scrollTop = bodyEl.scrollHeight;
      }
    );
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  function addBubble(log, kind, html) {
    const el = document.createElement('div');
    el.className = `msg ${kind}`;
    el.innerHTML = html;
    log.appendChild(el);
    bodyEl.scrollTop = bodyEl.scrollHeight;
    return el;
  }

  function showError(msg) {
    titleEl.textContent = 'Error';
    askRow.classList.remove('show');
    bodyEl.innerHTML = `<div class="err">${escapeHtml(msg)}</div>`;
  }

  // ---- minimal markdown -> html (headings, bold, code, bullets) ----
  function mdToHtml(md) {
    const lines = escapeHtml(md).split('\n');
    let html = '';
    let inUl = false;
    for (const ln of lines) {
      let m;
      if ((m = ln.match(/^\s*[-*]\s+(.*)/))) {
        if (!inUl) { html += '<ul>'; inUl = true; }
        html += `<li>${inline(m[1])}</li>`;
        continue;
      }
      if (inUl) { html += '</ul>'; inUl = false; }
      if ((m = ln.match(/^#{1,6}\s+(.*)/))) { html += `<h3>${inline(m[1])}</h3>`; continue; }
      if (ln.trim() === '') continue;
      html += `<p>${inline(ln)}</p>`;
    }
    if (inUl) html += '</ul>';
    return html;
  }
  function inline(s) {
    return s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/`(.+?)`/g, '<code>$1</code>');
  }
  function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
})();
