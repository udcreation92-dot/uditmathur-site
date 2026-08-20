// Drag-to-Summarize — background service worker.
// Orchestrates: open dragged URL in a background tab -> extract article from the
// rendered DOM (soft-paywall friendly) -> summarize via DeepSeek -> return to the page.

const DEFAULTS = { model: 'deepseek-chat', length: 'medium', language: 'English' };

// Clicking the toolbar icon opens settings (there is no popup).
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'summarize') {
    handleSummarize(msg.url)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true; // keep the message channel open for the async response
  }
  if (msg?.type === 'ask') {
    handleAsk(msg)
      .then(sendResponse)
      .catch((e) => sendResponse({ ok: false, error: String(e?.message || e) }));
    return true;
  }
});

async function getSettings() {
  const s = await chrome.storage.local.get(['deepseekApiKey', 'model', 'length', 'language']);
  return { ...DEFAULTS, ...s };
}

async function handleSummarize(url) {
  const settings = await getSettings();
  if (!settings.deepseekApiKey) {
    return { ok: false, error: 'No DeepSeek API key set. Click the extension icon to open settings.' };
  }
  const article = await openAndExtract(url);
  if (!article || !article.text || article.text.length < 200) {
    return { ok: false, error: 'Could not extract readable article text from that link.' };
  }
  const summary = await summarizeWithDeepSeek(article, settings);
  return { ok: true, title: article.title, byline: article.byline, url, summary, text: article.text };
}

// Load the URL in an inactive tab so it renders with the user's real session
// (cookies/subscription), extract, then close the tab.
async function openAndExtract(url) {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  try {
    await waitForComplete(tabId, 15000);
    await sleep(1200); // let client-side content hydrate
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: extractArticle });
    return results?.[0]?.result || null;
  } finally {
    try { await chrome.tabs.remove(tabId); } catch (_) { /* tab already gone */ }
  }
}

function waitForComplete(tabId, timeout) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (id, info) => { if (id === tabId && info.status === 'complete') finish(); };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId, (t) => { if (!chrome.runtime.lastError && t?.status === 'complete') finish(); });
    setTimeout(finish, timeout);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Runs INSIDE the target page (isolated world). Must be fully self-contained.
function extractArticle() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const meta = (sel) => document.querySelector(sel)?.getAttribute('content') || '';
  const title = clean(meta('meta[property="og:title"]') || document.title);
  const byline = clean(meta('meta[name="author"]') || meta('meta[property="article:author"]'));

  // 1) JSON-LD articleBody — often holds the FULL text even when it's visually paywalled.
  let best = '';
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node.articleBody === 'string' && node.articleBody.length > best.length) best = node.articleBody;
    Object.values(node).forEach((v) => { if (v && typeof v === 'object') walk(v); });
  };
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try { walk(JSON.parse(s.textContent)); } catch (_) { /* malformed ld+json */ }
  });
  if (best && best.length > 400) return { title, byline, text: clean(best).slice(0, 12000) };

  // 2) Fall back to the main content container in the DOM.
  const containers = ['article', '[role="main"]', 'main', '#content', '.article-body', '.post-content'];
  let root = null;
  for (const sel of containers) { const el = document.querySelector(sel); if (el) { root = el; break; } }
  if (!root) {
    // pick the block with the most direct-child paragraph text
    let bestEl = null, bestLen = 0;
    document.querySelectorAll('div, section').forEach((el) => {
      let len = 0;
      el.querySelectorAll(':scope > p').forEach((p) => { len += p.innerText.length; });
      if (len > bestLen) { bestLen = len; bestEl = el; }
    });
    root = bestEl || document.body;
  }
  const parts = [];
  root.querySelectorAll('p, h2, h3, li').forEach((el) => {
    const t = clean(el.innerText);
    if (t.length > 40) parts.push(t);
  });
  let text = parts.join('\n');
  if (text.length < 200) text = clean(document.body.innerText);
  return { title, byline, text: text.slice(0, 12000) };
}

// Answer a follow-up question about an already-extracted article. The content
// script passes the article {title,text} plus the running Q&A history so the model
// keeps context across turns.
async function handleAsk({ article, history, question }) {
  const settings = await getSettings();
  if (!settings.deepseekApiKey) {
    return { ok: false, error: 'No DeepSeek API key set. Click the extension icon to open settings.' };
  }
  if (!article?.text) return { ok: false, error: 'No article context to ask about.' };
  if (!question?.trim()) return { ok: false, error: 'Empty question.' };

  const messages = [
    {
      role: 'system',
      content:
        `You answer questions about the article below. Use only information contained in the article; ` +
        `if the answer is not in it, say so plainly. Answer in ${settings.language}. Be concise. ` +
        `Output GitHub-flavored Markdown.\n\nTITLE: ${article.title}\n\nARTICLE:\n${article.text}`,
    },
    ...(Array.isArray(history) ? history : []),
    { role: 'user', content: question },
  ];
  const answer = await callDeepSeek(messages, settings);
  return { ok: true, answer };
}

async function summarizeWithDeepSeek(article, settings) {
  const lengthSpec = {
    short: 'Write a 2-3 sentence summary only.',
    medium: 'Write a one-line **TL;DR**, then 4-5 key bullet points.',
    detailed: 'Write a one-line **TL;DR**, then 6-8 key bullet points, then a short "Why it matters" line.',
  }[settings.length] || 'Write a one-line **TL;DR**, then 4-5 key bullet points.';

  const messages = [
    {
      role: 'system',
      content:
        'You summarize web articles accurately and concisely. Never invent facts that are not in the provided text. Output GitHub-flavored Markdown.',
    },
    {
      role: 'user',
      content: `Summarize the article below.\nLanguage: ${settings.language}\n${lengthSpec}\n\nTITLE: ${article.title}\n\nARTICLE:\n${article.text}`,
    },
  ];
  return callDeepSeek(messages, settings);
}

async function callDeepSeek(messages, settings) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.deepseekApiKey}` },
    body: JSON.stringify({ model: settings.model, temperature: 0.3, stream: false, messages }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`DeepSeek API ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '(empty response)';
}
