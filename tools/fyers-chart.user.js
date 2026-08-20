// ==UserScript==
// @name         Dashboard → Fyers Chart
// @namespace    uditmathur.trading
// @description  Opens the chart for a symbol on trade.fyers.in when the Trading Dashboard passes it in the URL hash (#fychart=NSE:SBIN-EQ&q=SBIN). Drives the embedded TradingView symbol-search dialog.
// @match        https://trade.fyers.in/*
// @run-at       document-idle
// @grant        none
// @version      2.3
// ==/UserScript==
(function () {
  'use strict';

  const LOG = (...a) => console.log('%c[FyChart]', 'color:#4ea1d3;font-weight:bold', ...a);

  // offsetParent is null for position:fixed elements (TradingView's toolbar is fixed), so use
  // client rects for visibility instead.
  const isVisible = (el) => !!el && el.getClientRects().length > 0;

  // Documents to search: the top document plus any same-origin iframes (TradingView may be framed).
  function docs() {
    const list = [document];
    for (const f of document.querySelectorAll('iframe')) {
      try { if (f.contentDocument) list.push(f.contentDocument); } catch (_) { /* cross-origin */ }
    }
    return list;
  }
  function queryDeep(selector) {
    for (const d of docs()) {
      for (const el of d.querySelectorAll(selector)) if (isVisible(el)) return el;
    }
    return null;
  }
  function queryAllDeep(selector) {
    const out = [];
    for (const d of docs()) for (const el of d.querySelectorAll(selector)) if (isVisible(el)) out.push(el);
    return out;
  }

  // ---- Read the request the dashboard put in the URL hash ---------------------------------
  function parseHash() {
    const p = new URLSearchParams(location.hash.replace(/^#/, ''));
    return { symbol: p.get('fychart'), q: p.get('q') };
  }

  // TradingView/React control the input's value via a setter, so assigning .value is ignored.
  // Set via the native setter, then dispatch 'input' so the framework registers it.
  function setReactInput(el, value) {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  // TradingView's search box ignores a plain .value set — it listens for real input events. Select
  // the pre-filled text and replace it via execCommand('insertText'), which dispatches genuine
  // beforeinput/input events. Falls back to the React setter if execCommand is unavailable.
  function typeInto(el, text) {
    el.focus();
    try { el.setSelectionRange(0, (el.value || '').length); } catch (_) {}
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (_) {}
    if (!ok || el.value !== text) setReactInput(el, text);
  }

  function fireKey(el, key, keyCode) {
    for (const type of ['keydown', 'keypress', 'keyup']) {
      el.dispatchEvent(new KeyboardEvent(type, { key, keyCode, which: keyCode, bubbles: true }));
    }
  }

  function waitFor(getter, { timeout = 8000, interval = 120 } = {}) {
    return new Promise((resolve) => {
      const start = Date.now();
      const tick = () => {
        let v = null;
        try { v = getter(); } catch (_) {}
        if (v) return resolve(v);
        if (Date.now() - start > timeout) return resolve(null);
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  // ---- The embedded TradingView chart's symbol-search button (from Fyers' DOM) --------------
  const TRIGGER_SELECTORS = [
    '[data-tooltip="Symbol Search"]',
    '#header-toolbar-symbol-search',
    'button[data-name="symbol-search-button"]',
  ];
  function findTrigger() {
    for (const s of TRIGGER_SELECTORS) {
      const el = queryDeep(s);
      if (el) return el;
    }
    return null;
  }

  // Any visible <input> that isn't in the pre-open set = the dialog's search box.
  function findNewInput(before) {
    const inDialog = queryDeep('input[data-role="search"]');
    if (inDialog) return inDialog;
    const cands = queryAllDeep('input').filter(i => !before.has(i));
    return cands[0] || null;
  }

  // TradingView result rows expose the ticker via data-symbol-short / data-symbol-full.
  // Match ONLY the wanted ticker (never a stray first row) so we can't select the wrong symbol.
  const normTicker = (s) => (s || '').toUpperCase().replace(/^NSE:|^BSE:|^MCX:/, '').replace(/-EQ$/, '');
  function findResultRow(ticker) {
    const rows = queryAllDeep('[data-symbol-short], [data-symbol-full]');
    return rows.find(e =>
      normTicker(e.getAttribute('data-symbol-short')) === ticker ||
      normTicker(e.getAttribute('data-symbol-full')) === ticker
    ) || null;
  }

  // ---- Preferred path: call TradingView's setSymbol directly if the widget is reachable -----
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
  function setViaWidget(fullSymbol) {
    const w = findTvWidget();
    if (!w) return false;
    try {
      if (typeof w.activeChart === 'function') { w.activeChart().setSymbol(fullSymbol); LOG('✅ set via widget.activeChart().setSymbol', fullSymbol); return true; }
      if (typeof w.setSymbol === 'function') { w.setSymbol(fullSymbol, 'D', () => {}); LOG('✅ set via widget.setSymbol', fullSymbol); return true; }
    } catch (e) { LOG('widget.setSymbol threw', e); }
    return false;
  }

  // ---- Drive it ----------------------------------------------------------------------------
  let busy = false;
  async function driveSearch(term, fullSymbol) {
    if (busy) return;
    busy = true;
    try {
      if (fullSymbol && setViaWidget(fullSymbol)) return; // clean path — no search UI needed
      const trigger = await waitFor(findTrigger, { timeout: 10000 });
      if (!trigger) {
        const tips = [...new Set(queryAllDeep('[data-tooltip]').map(e => e.getAttribute('data-tooltip')))];
        LOG('❌ Symbol-search button not found. Visible data-tooltip values seen:', tips);
        return;
      }
      const before = new Set([...document.querySelectorAll('input')]);
      trigger.click();
      LOG('opened symbol search');

      const input = await waitFor(() => findNewInput(before));
      if (!input) {
        LOG('❌ Search input did not appear after opening the dialog.');
        return;
      }
      typeInto(input, term);
      LOG('typed:', term, '→ input now:', JSON.stringify(input.value), '(want:', fullSymbol, ')');

      const wanted = normTicker(fullSymbol || term);

      // Wait for the row that matches the wanted ticker, then click it. If it never appears
      // (search didn't filter), press Enter to accept whatever the top highlighted result is.
      const row = await waitFor(() => findResultRow(wanted), { timeout: 5000 });
      if (row) {
        LOG('clicking result:', row.getAttribute('data-symbol-short') || row.textContent.trim().slice(0, 40));
        row.click();
      } else {
        LOG('no matching row for', wanted, '— input value is', JSON.stringify(input.value), '; pressing Enter');
        fireKey(input, 'Enter', 13);
      }
    } finally {
      busy = false;
    }
  }

  function handle() {
    const { symbol, q } = parseHash();
    if (!symbol && !q) return;
    LOG('request →', { symbol, q });
    driveSearch(q || symbol, symbol);
  }

  window.addEventListener('hashchange', handle);   // dashboard reused the tab (hash changed)
  setTimeout(handle, 1800);                         // fresh tab load

  LOG('userscript loaded on', location.host);
})();
