# Drag-to-Summarize (Edge/Chrome extension)

Drag any link to the blue bar at the top of the page → the extension opens that
page in a background tab, extracts the article, and shows a **DeepSeek** summary
in a floating panel. No backend required.

## How it beats paywalls (partially)
- The linked page is loaded in a **real background tab in your own browser**, so it
  renders with your cookies/session and any client-side content.
- Extraction prefers the page's **JSON-LD `articleBody`**, which many metered
  ("soft") paywalls embed in full for SEO — so the summary often works even when the
  visible page is cut off.
- **Hard paywalls** (article body never sent unless you're subscribed) can't be
  bypassed — the text simply isn't in the page. Nothing can conjure data the server
  didn't send.

## Install (load unpacked)
1. Open `edge://extensions` (or `chrome://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and select this folder
   (`tools/link-summarizer-extension`).
4. Click the extension's toolbar icon → **options** open → paste your DeepSeek API
   key (from platform.deepseek.com) → **Save**.

## Use
- Grab any link and drag it upward; a **"Drop link to summarize"** bar appears at
  the top. Drop it there.
- The panel shows a TL;DR + bullets. **Copy** or **Open link ↗** from the footer.
- **Ask follow-up questions** in the box at the bottom of the panel — the AI answers
  using the extracted article as context and remembers the conversation. Answers are
  grounded in the article; it says so if something isn't covered.

## Cost
~$0.001 per ~700-word article on `deepseek-chat` (input ~2k tokens, output ~300).

## Notes / limits
- Reader-view + summary only — it does **not** embed the live page visually (sites
  block iframe embedding via `X-Frame-Options`/CSP; stripping that is out of scope).
- A background tab briefly opens and closes for each summary.
- Very JS-heavy or bot-blocked pages may fail to extract; you'll see an error in the
  panel.
- Settings & API key are stored in `chrome.storage.local` (this browser only).
