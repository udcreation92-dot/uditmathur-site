// ==UserScript==
// @name         Fyers Chart → Scalp Punch (Cash Segment)
// @namespace    uditmathur.trading
// @description  Alt+A on a Fyers chart opens a step-by-step wizard (symbol → prices → max loss → trade type → broker) that arms a cash-segment scalp directly in the Trading Dashboard backend. No dashboard tab needed.
// @match        https://trade.fyers.in/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      192.168.0.235
// @connect      localhost
// @connect      127.0.0.1
// @version      1.1
// ==/UserScript==
(function () {
  'use strict';

  const LOG = (...a) => console.log('%c[ScalpPunch]', 'color:#818cf8;font-weight:bold', ...a);
  const DEFAULT_BACKEND = 'http://127.0.0.1:8000';
  const backend = () => (GM_getValue('spx_backend', DEFAULT_BACKEND) || DEFAULT_BACKEND).replace(/\/$/, '');

  try {
    GM_registerMenuCommand('Scalp Punch: set backend URL', () => {
      const v = prompt('Trading backend base URL (e.g. http://192.168.0.235:8000)', backend());
      if (v && v.trim()) GM_setValue('spx_backend', v.trim().replace(/\/$/, ''));
    });
  } catch (e) { console.error('[ScalpPunch] menu command registration failed', e); }

  // ---- Reach into same-origin documents (top + any same-origin iframes) --------------------
  const isVisible = (el) => !!el && el.getClientRects().length > 0;
  function docs() {
    const list = [document];
    for (const f of document.querySelectorAll('iframe')) {
      try { if (f.contentDocument) list.push(f.contentDocument); } catch (_) { /* cross-origin */ }
    }
    return list;
  }
  function queryAllDeep(selector) {
    const out = [];
    for (const d of docs()) for (const el of d.querySelectorAll(selector)) if (isVisible(el)) out.push(el);
    return out;
  }

  function isEditableFocused(doc) {
    const el = doc.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  // ---- Read the symbol currently on the chart, for a starting guess (always editable) -------
  function findTvWidget() {
    const looks = (v) => v && typeof v === 'object' &&
      (typeof v.setSymbol === 'function' || typeof v.activeChart === 'function');
    for (const k of ['tvWidget', 'widget', 'TradingViewApi', 'tv']) {
      try { if (looks(window[k])) return window[k]; } catch (_) {}
    }
    for (const k of Object.keys(window)) {
      try { if (looks(window[k])) return window[k]; } catch (_) {}
    }
    return null;
  }
  function detectChartRoot() {
    try {
      const w = findTvWidget();
      if (w && typeof w.activeChart === 'function') {
        const sym = w.activeChart().symbol();
        if (sym) return sym.toUpperCase().replace(/^NSE:|^BSE:/, '').replace(/-EQ$/, '');
      }
    } catch (_) {}
    // Fallback: legend / title text some Fyers builds render outside the TV iframe.
    const legend = queryAllDeep('[data-name="legend-source-item"], .apply-overflow-tooltip')
      .map(e => (e.textContent || '').trim()).find(t => /^[A-Z0-9&]{2,15}$/.test(t));
    return legend || '';
  }

  // ---- Backend calls (GM_xmlhttpRequest bypasses page CORS + mixed-content blocks) ----------
  function gmRequest(method, path) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method,
        url: backend() + path,
        headers: { 'Content-Type': 'application/json' },
        timeout: 8000,
        onload: (res) => {
          let json = null;
          try { json = JSON.parse(res.responseText); } catch (_) {}
          if (res.status >= 200 && res.status < 300) resolve(json);
          else reject(new Error((json && json.detail) || `HTTP ${res.status}`));
        },
        onerror: () => reject(new Error(`Can't reach backend at ${backend()} — check it's running and the URL (menu → Scalp Punch: set backend URL).`)),
        ontimeout: () => reject(new Error('Backend request timed out.')),
      });
    });
  }
  function gmPost(path, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST',
        url: backend() + path,
        headers: { 'Content-Type': 'application/json' },
        data: JSON.stringify(body),
        timeout: 8000,
        onload: (res) => {
          let json = null;
          try { json = JSON.parse(res.responseText); } catch (_) {}
          if (res.status >= 200 && res.status < 300) resolve(json);
          else reject(new Error((json && json.detail) || `HTTP ${res.status}`));
        },
        onerror: () => reject(new Error(`Can't reach backend at ${backend()}.`)),
        ontimeout: () => reject(new Error('Backend request timed out.')),
      });
    });
  }
  async function resolveEquity(root) {
    const results = await gmRequest('GET', `/market/search?q=${encodeURIComponent(root)}&segment=EQUITY`) || [];
    const eq = results.filter(s => s.segment === 'EQUITY');
    const norm = (s) => s.replace('NSE:', '').replace('-EQ', '').toUpperCase();
    return eq.find(s => norm(s.symbol) === root.toUpperCase()) || eq[0] || null;
  }

  // ---- Styling (scoped, self-contained — page has no Tailwind) ------------------------------
  const CSS = `
    .spx-overlay { position: fixed; inset: 0; z-index: 999999; background: rgba(0,0,0,.55);
      display: flex; align-items: center; justify-content: center; font-family: ui-monospace, Menlo, Consolas, monospace; }
    .spx-card { background: #111827; border: 1px solid #1f2937; border-radius: 10px; padding: 20px 22px;
      width: 380px; color: #e5e7eb; box-shadow: 0 10px 40px rgba(0,0,0,.5); }
    .spx-title { font-size: 12px; font-weight: 600; color: #a5b4fc; letter-spacing: .03em; margin-bottom: 2px; }
    .spx-step { font-size: 10px; color: #6b7280; margin-bottom: 14px; }
    .spx-label { font-size: 11px; color: #9ca3af; margin-bottom: 5px; display:block; }
    .spx-input { width: 100%; box-sizing: border-box; background: #1f2937; border: 1px solid #374151; border-radius: 6px;
      color: #f3f4f6; font-size: 15px; padding: 8px 10px; font-family: inherit; outline: none; }
    .spx-input:focus { border-color: #818cf8; }
    .spx-row { display: flex; gap: 8px; margin-bottom: 10px; }
    .spx-row .spx-col { flex: 1; }
    .spx-btnrow { display: flex; gap: 8px; margin-top: 16px; }
    .spx-btn { flex: 1; padding: 9px 0; border-radius: 6px; border: 1px solid #374151; background: #1f2937;
      color: #d1d5db; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
    .spx-btn:hover { background: #273040; }
    .spx-btn.spx-primary { background: #4f46e5; border-color: #4f46e5; color: #fff; }
    .spx-btn.spx-primary:hover { background: #4338ca; }
    .spx-btn.spx-arm { background: #16a34a; border-color: #16a34a; color: #fff; }
    .spx-btn.spx-arm:hover { background: #15803d; }
    .spx-btn.spx-arm:disabled { opacity: .5; cursor: default; }
    .spx-choice { display: flex; gap: 8px; }
    .spx-choice .spx-opt { flex: 1; padding: 10px 0; text-align: center; border-radius: 6px; border: 1px solid #374151;
      background: #1f2937; color: #9ca3af; font-size: 13px; font-weight: 700; cursor: pointer; }
    .spx-opt.sel.buy { background: #14532d; border-color: #16a34a; color: #4ade80; }
    .spx-opt.sel.sell { background: #5c1a1a; border-color: #dc2626; color: #f87171; }
    .spx-opt.sel.neutral { background: #312e81; border-color: #4f46e5; color: #a5b4fc; }
    .spx-err { color: #f87171; font-size: 11px; margin-top: 8px; }
    .spx-ok { color: #4ade80; font-size: 12px; margin-top: 8px; }
    .spx-summary { font-size: 12px; line-height: 1.9; }
    .spx-summary b { color: #f3f4f6; }
    .spx-summary .k { color: #6b7280; display: inline-block; width: 84px; }
    .spx-pill { position: fixed; bottom: 14px; right: 14px; z-index: 999998; background: #111827; border: 1px solid #374151;
      color: #818cf8; font: 600 11px ui-monospace, monospace; padding: 5px 10px; border-radius: 999px; opacity: .55; pointer-events: none; }
  `;
  function injectCss() {
    if (document.getElementById('spx-style')) return;
    const s = document.createElement('style');
    s.id = 'spx-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  function showPill() {
    if (document.getElementById('spx-pill')) return;
    const p = document.createElement('div');
    p.id = 'spx-pill'; p.className = 'spx-pill'; p.textContent = '⚡ Alt+A → Scalp Punch';
    document.body.appendChild(p);
  }
  function updatePill() {
    const p = document.getElementById('spx-pill');
    if (!p) return;
    if (open && minimized) {
      p.textContent = '⚡ Scalp Punch minimized — Alt+A to resume';
      p.style.opacity = '1';
    } else {
      p.textContent = '⚡ Alt+A → Scalp Punch';
      p.style.opacity = '.55';
    }
  }

  // ---- Wizard state + step machine -----------------------------------------------------------
  const STEPS = ['symbol', 'prices', 'maxloss', 'tradetype', 'broker', 'review'];
  let open = false;
  let minimized = false;
  let step = 0;
  let state = {};
  let overlay = null;
  let busy = false;

  function resetState() {
    state = {
      root: detectChartRoot(), symbol: null, symbolDesc: null,
      side: null, sideManual: false, entry: '', sl: '', target: '',
      maxLoss: String(GM_getValue('spx_last_maxloss', 100)),
      tradeType: 'MIS', broker: 'fyers',
      error: null, resolving: false,
    };
  }

  function closeWizard() {
    open = false;
    minimized = false;
    if (overlay) { overlay.remove(); overlay = null; }
    updatePill();
  }

  function openWizard() {
    resetState();
    step = 0;
    open = true;
    minimized = false;
    overlay = document.createElement('div');
    overlay.className = 'spx-overlay';
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeWizard(); });
    document.body.appendChild(overlay);
    render();
    updatePill();
  }

  // Alt+A while the wizard is open hides it so the chart underneath is fully usable again —
  // step and every field typed so far stay in `state`; Alt+A a second time reopens at the same spot.
  function minimizeWizard() {
    if (!overlay) return;
    if (document.activeElement && overlay.contains(document.activeElement)) document.activeElement.blur();
    overlay.style.display = 'none';
    minimized = true;
    updatePill();
  }
  function restoreWizard() {
    if (!overlay) return;
    overlay.style.display = '';
    minimized = false;
    render();
    updatePill();
  }
  function focusFirstInput() {
    setTimeout(() => { const i = overlay && overlay.querySelector('input'); if (i) i.focus(); }, 0);
  }

  function computeSide() {
    if (state.sideManual) return state.side;
    const e = +state.entry, t = +state.target;
    if (e > 0 && t > 0 && e !== t) return t > e ? 'BUY' : 'SELL';
    return state.side;
  }
  function qty() {
    const d = Math.abs(+state.sl - +state.entry);
    return d > 0 ? Math.floor(+state.maxLoss / d) : 0;
  }

  function next() { step = Math.min(step + 1, STEPS.length - 1); render(); }
  function back() { step = Math.max(step - 1, 0); render(); }

  async function goResolveSymbol(root) {
    if (!root || !root.trim()) { state.error = 'Type a script name (e.g. SBIN) or let it auto-fill from the chart.'; render(); return; }
    state.resolving = true; state.error = null; render();
    try {
      const m = await resolveEquity(root.trim());
      state.resolving = false;
      if (!m) { state.error = `No cash equity found for "${root.trim()}".`; render(); return; }
      state.symbol = m.symbol; state.symbolDesc = m.symbol_desc || null;
      next();
    } catch (e) {
      state.resolving = false; state.error = e.message; render();
    }
  }

  async function goArm() {
    const q = qty();
    if (q < 1) { state.error = 'Qty < 1 — widen Max Loss or tighten the SL distance.'; render(); return; }
    busy = true; state.error = null; render();
    try {
      GM_setValue('spx_last_maxloss', +state.maxLoss);
      const created = await gmPost('/scalp', {
        symbol: state.symbol, name: state.symbolDesc, side: computeSide(),
        entry_price: +state.entry, sl_price: +state.sl, target_price: +state.target,
        max_loss: +state.maxLoss, trade_type: state.tradeType, broker: state.broker,
        note: 'Armed via Fyers chart punch extension',
      });
      LOG('armed', created);
      busy = false;
      state.armed = created;
      render();
      setTimeout(closeWizard, 2200);
    } catch (e) {
      busy = false; state.error = e.message; render();
    }
  }

  // ---- Render ---------------------------------------------------------------------------------
  function render() {
    if (!overlay) return;
    const s = state;
    let body = '';

    if (STEPS[step] === 'symbol') {
      body = `
        <div class="spx-title">SCALP PUNCH</div>
        <div class="spx-step">Step 1/6 — Symbol</div>
        <label class="spx-label">Cash equity script</label>
        <input class="spx-input" id="spx-root" value="${(s.root || '').replace(/"/g, '&quot;')}" placeholder="e.g. SBIN" autocomplete="off" />
        <div class="spx-btnrow">
          <button class="spx-btn" id="spx-cancel">Cancel (Esc)</button>
          <button class="spx-btn spx-primary" id="spx-go">${s.resolving ? 'Resolving…' : 'Next →'}</button>
        </div>
        ${s.error ? `<div class="spx-err">${s.error}</div>` : ''}
      `;
    } else if (STEPS[step] === 'prices') {
      const side = computeSide();
      body = `
        <div class="spx-title">SCALP PUNCH</div>
        <div class="spx-step">Step 2/6 — Prices · ${s.symbol.replace('NSE:', '').replace('-EQ', '')}${s.symbolDesc ? ' · ' + s.symbolDesc : ''}</div>
        <div class="spx-row">
          <div class="spx-col"><label class="spx-label">Entry</label><input class="spx-input" id="spx-entry" type="number" step="0.05" value="${s.entry}" /></div>
          <div class="spx-col"><label class="spx-label">Stoploss</label><input class="spx-input" id="spx-sl" type="number" step="0.05" value="${s.sl}" /></div>
          <div class="spx-col"><label class="spx-label">Target</label><input class="spx-input" id="spx-target" type="number" step="0.05" value="${s.target}" /></div>
        </div>
        <label class="spx-label">Side ${!s.sideManual ? '(auto — target vs entry)' : ''}</label>
        <div class="spx-choice">
          <div class="spx-opt ${side === 'BUY' ? 'sel buy' : ''}" id="spx-buy">BUY</div>
          <div class="spx-opt ${side === 'SELL' ? 'sel sell' : ''}" id="spx-sell">SELL</div>
        </div>
        <div class="spx-btnrow">
          <button class="spx-btn" id="spx-back">← Back</button>
          <button class="spx-btn spx-primary" id="spx-go">Next →</button>
        </div>
        ${s.error ? `<div class="spx-err">${s.error}</div>` : ''}
      `;
    } else if (STEPS[step] === 'maxloss') {
      body = `
        <div class="spx-title">SCALP PUNCH</div>
        <div class="spx-step">Step 3/6 — Max loss</div>
        <label class="spx-label">Max loss for this scalp (₹) — qty = max loss ÷ |SL − entry|</label>
        <input class="spx-input" id="spx-maxloss" type="number" step="1" value="${s.maxLoss}" />
        <div class="spx-btnrow">
          <button class="spx-btn" id="spx-back">← Back</button>
          <button class="spx-btn spx-primary" id="spx-go">Next →</button>
        </div>
        ${s.error ? `<div class="spx-err">${s.error}</div>` : ''}
      `;
    } else if (STEPS[step] === 'tradetype') {
      body = `
        <div class="spx-title">SCALP PUNCH</div>
        <div class="spx-step">Step 4/6 — Trade type</div>
        <label class="spx-label">MIS (intraday) or CNC (carry)</label>
        <div class="spx-choice">
          <div class="spx-opt ${s.tradeType === 'MIS' ? 'sel neutral' : ''}" id="spx-mis">MIS</div>
          <div class="spx-opt ${s.tradeType === 'CNC' ? 'sel neutral' : ''}" id="spx-cnc">CNC</div>
        </div>
        <div class="spx-btnrow">
          <button class="spx-btn" id="spx-back">← Back</button>
          <button class="spx-btn spx-primary" id="spx-go">Next →</button>
        </div>
      `;
    } else if (STEPS[step] === 'broker') {
      body = `
        <div class="spx-title">SCALP PUNCH</div>
        <div class="spx-step">Step 5/6 — Broker</div>
        <div class="spx-choice">
          ${['fyers', 'zerodha', 'shoonya'].map(b => `<div class="spx-opt ${s.broker === b ? 'sel neutral' : ''}" data-b="${b}">${b}</div>`).join('')}
        </div>
        <div class="spx-btnrow">
          <button class="spx-btn" id="spx-back">← Back</button>
          <button class="spx-btn spx-primary" id="spx-go">Next →</button>
        </div>
      `;
    } else if (STEPS[step] === 'review') {
      const side = computeSide();
      const q = qty();
      if (s.armed) {
        body = `
          <div class="spx-title">SCALP PUNCH</div>
          <div class="spx-ok">✅ Armed — ${s.symbol.replace('NSE:', '').replace('-EQ', '')} ${side} qty ${s.armed.qty}, status ${s.armed.status}.</div>
        `;
      } else {
        body = `
          <div class="spx-title">SCALP PUNCH</div>
          <div class="spx-step">Step 6/6 — Confirm &amp; arm</div>
          <div class="spx-summary">
            <div><span class="k">Symbol</span><b>${s.symbol.replace('NSE:', '').replace('-EQ', '')}</b> ${s.symbolDesc ? `<span style="color:#6b7280">(${s.symbolDesc})</span>` : ''}</div>
            <div><span class="k">Side</span><b style="color:${side === 'BUY' ? '#4ade80' : '#f87171'}">${side}</b></div>
            <div><span class="k">Entry / SL / Tgt</span><b>${s.entry} / ${s.sl} / ${s.target}</b></div>
            <div><span class="k">Max loss</span><b>₹${s.maxLoss}</b></div>
            <div><span class="k">Qty</span><b style="color:${q >= 1 ? '#a5b4fc' : '#f87171'}">${q}</b></div>
            <div><span class="k">Trade type</span><b>${s.tradeType}</b></div>
            <div><span class="k">Broker</span><b>${s.broker}</b></div>
          </div>
          <div class="spx-btnrow">
            <button class="spx-btn" id="spx-back">← Back</button>
            <button class="spx-btn spx-arm" id="spx-arm" ${busy ? 'disabled' : ''}>${busy ? 'Arming…' : '⚡ Arm scalp'}</button>
          </div>
          ${s.error ? `<div class="spx-err">${s.error}</div>` : ''}
        `;
      }
    }

    overlay.innerHTML = `<div class="spx-card">${body}</div>`;
    bind();
    focusFirstInput();
  }

  function bind() {
    const s = state;
    const q = (sel) => overlay.querySelector(sel);
    const cancelBtn = q('#spx-cancel'); if (cancelBtn) cancelBtn.onclick = closeWizard;
    const backBtn = q('#spx-back'); if (backBtn) backBtn.onclick = back;
    const goBtn = q('#spx-go');
    const armBtn = q('#spx-arm'); if (armBtn) armBtn.onclick = goArm;

    if (STEPS[step] === 'symbol') {
      const input = q('#spx-root');
      const go = () => goResolveSymbol(input.value);
      if (goBtn) goBtn.onclick = go;
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    } else if (STEPS[step] === 'prices') {
      const eIn = q('#spx-entry'), slIn = q('#spx-sl'), tIn = q('#spx-target');
      const sync = () => { s.entry = eIn.value; s.sl = slIn.value; s.target = tIn.value; };
      [eIn, slIn, tIn].forEach(el => el.addEventListener('input', () => { sync(); renderSideOnly(); }));
      const go = () => {
        sync();
        if (!(+s.entry > 0 && +s.sl > 0 && +s.target > 0 && +s.entry !== +s.sl)) {
          s.error = 'Entry, SL and Target must be positive, and SL must differ from Entry.'; render(); return;
        }
        s.error = null; s.side = computeSide(); next();
      };
      if (goBtn) goBtn.onclick = go;
      tIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      const buy = q('#spx-buy'), sell = q('#spx-sell');
      buy.onclick = () => { s.sideManual = true; s.side = 'BUY'; render(); };
      sell.onclick = () => { s.sideManual = true; s.side = 'SELL'; render(); };
    } else if (STEPS[step] === 'maxloss') {
      const mlIn = q('#spx-maxloss');
      const go = () => {
        s.maxLoss = mlIn.value;
        if (!(+s.maxLoss > 0)) { s.error = 'Max loss must be positive.'; render(); return; }
        s.error = null; next();
      };
      if (goBtn) goBtn.onclick = go;
      mlIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
      mlIn.addEventListener('input', () => { s.maxLoss = mlIn.value; });
    } else if (STEPS[step] === 'tradetype') {
      q('#spx-mis').onclick = () => { s.tradeType = 'MIS'; next(); };
      q('#spx-cnc').onclick = () => { s.tradeType = 'CNC'; next(); };
      if (goBtn) goBtn.onclick = next;
    } else if (STEPS[step] === 'broker') {
      overlay.querySelectorAll('[data-b]').forEach(el => {
        el.onclick = () => { s.broker = el.getAttribute('data-b'); next(); };
      });
      if (goBtn) goBtn.onclick = next;
    }
  }

  // Cheap re-render of just the side badges while typing prices, so keystrokes don't get eaten
  // by a full re-render stealing input focus.
  function renderSideOnly() {
    const side = computeSide();
    const buy = overlay.querySelector('#spx-buy'), sell = overlay.querySelector('#spx-sell');
    if (!buy || !sell) return;
    buy.className = 'spx-opt' + (side === 'BUY' ? ' sel buy' : '');
    sell.className = 'spx-opt' + (side === 'SELL' ? ' sel sell' : '');
  }

  // ---- Global hotkey + Escape-to-close, bound on every same-origin document -----------------
  function onKeyDown(e) {
    const altA = e.altKey && (e.key === 'a' || e.key === 'A');

    if (open && minimized) {
      // Wizard is hidden and the chart should behave normally — only Alt+A (resume) is ours.
      if (altA) { e.preventDefault(); e.stopPropagation(); restoreWizard(); }
      return;
    }
    if (open) { // visible and capturing
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeWizard(); return; }
      if (altA) { e.preventDefault(); e.stopPropagation(); minimizeWizard(); return; }
      e.stopPropagation(); // keep the chart underneath from reacting while the wizard is up
      return;
    }
    if (altA && !isEditableFocused(e.target.ownerDocument || document)) {
      e.preventDefault(); e.stopPropagation();
      openWizard();
    }
  }
  function attachListeners() {
    for (const d of docs()) {
      if (d.__spxBound) continue;
      d.__spxBound = true;
      d.addEventListener('keydown', onKeyDown, true);
    }
  }

  try {
    injectCss();
    showPill();
    attachListeners();
    setInterval(attachListeners, 2000); // Fyers is an SPA — pick up iframes that load later
    LOG('loaded on', location.host, '— Alt+A to arm a cash scalp. Backend:', backend());
  } catch (e) {
    console.error('[ScalpPunch] init failed — the pill/hotkey never got set up:', e);
  }
})();
