# Repo guide

Monorepo of several independent apps sharing one Vite build. Active work is the **Trading Dashboard**.

## Apps / layout
- **Trading Dashboard** — frontend `src/trading/`, entry `trading.html`; backend `trading/backend/` (FastAPI, Python, port 8000).
- Task Manager — `src/` + `task.html` (React + Supabase).
- Accounts — `accounts/` (separate Vite app). Kitchen bot — `kitchen/`. Cameras — frontend `cameras/` (recordings-only player + ⚙ Manage panel); backend `camera-manager/` (one Node service: ONVIF add/delete + ffmpeg recorder + recordings HTTP on :8080, replaces the deprecated go2rtc + `recorder/` + `ptz-server/`).
- `tools/` — standalone scripts (e.g. Tampermonkey userscripts), not part of the build.
- Build: `vite.config.js` (base `/task/`, multi-entry), `postbuild.mjs` (Cloudflare deploy only — restructures `dist/`, rebuilds accounts; **do not run for local dev**).

## Running locally (Windows)
- Startup file: `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\TradingDashboard.bat` (starts backend + frontend, waits for both, opens browser).
- **Serve the production bundle, not `npm run dev`** — dev mode is sluggish. Build with `npx vite build --mode development` (minified AND reads `.env.local` LAN settings, not `.env.production`/Render), then `npx vite preview --host --port 4173`. URL: `http://localhost:4173/task/trading.html`.
- LAN/phone access: PC LAN IP + `--host`; frontend baked URL in `.env.local` (`VITE_TRADING_API_URL`), backend CORS in `trading/backend/.env` (`ALLOWED_ORIGINS`). Both read env at startup — restart after changes.
- **The frontend port (4173) is wired into THREE env vars — keep them in sync if it changes:** `VITE_TRADING_API_URL` (`.env.local`), `ALLOWED_ORIGINS` (backend `.env`, CORS), and `FRONTEND_URL` (backend `.env`, the broker-OAuth post-login redirect target for Fyers/Zerodha/Shoonya). A stale `FRONTEND_URL` sends the browser to a dead port after broker login.

## Trading — critical rules
- **REAL MONEY account. Always confirm before placing/exiting any order** — every order path must have an explicit confirm step. Order quantities are entered in **lots**, not raw quantity.
- **Strategy system = ORDER LEDGER (money pot), not position reconciliation.** A strategy is a list of orders in `strategy_orders` (`strategy_db.py`); net position per symbol = Σ signed FILLED qty; realized P&L = average-netting `(avg_sell−avg_buy)×min(buy,sell)`; total P&L = realized + live MTM of the open net. **The broker's live position is NEVER consulted to define a strategy** (the old phantom/over/direction reconciliation is gone). An **exit is just the opposite order** into the same strategy (auto-nets + books realized). Orders enter via: strategy builder (auto-filed, PENDING→FILLED on fill), the **Unassigned Orders inbox** (`/strategy/unassigned-orders` → `/assign-order`), or **manual add** (`/manual-order`, for pre-dashboard/broker orders). Once FILLED in a strategy it's a permanent position — absence from tomorrow's order book ≠ cancelled. Compute lives in `routes/strategy.py::compute_strategies`/`_merge_orders_to_legs`.
- Three brokers: **Fyers** (primary + market data via fyers-apiv3), **Zerodha** (kiteconnect), **Shoonya** (Finvasia Noren). Clients: `fyers_client.py`, `zerodha_client.py`, `shoonya_client.py`.
- **Symbol formats.** Canonical = Fyers (`NSE:NIFTY2670724000CE`, `NSE:RELIANCE-EQ`). Zerodha tsym = Fyers body minus exchange prefix (converter `src/trading/zerodhaSymbol.js` → `fyersToZerodha`). Shoonya tsym differs for F&O, resolved via `trading/backend/shoonya_symbols.py`. `-EQ` (equity) and `-TB` (T-Bill) are identical across all three on NSE.
- **Broker IP whitelisting** is the recurring pain. Fyers & Zerodha route through a TrueIP proxy (env `FYERS_PROXY_URL`, `ZERODHA_PROXY_URL`) → whitelist the proxy's static IPv6 on those brokers. Shoonya's API **blocks the proxy** → it uses the PC's home IP, which must be whitelisted on Shoonya (home IP is dynamic — re-whitelist when it changes).
- Secrets live in `trading/backend/.env` (git-ignored). Never commit it.

## Frontend notes
- API base: `src/trading/api.js` reads `VITE_TRADING_API_URL` (defaults to `http://localhost:8000`).
- The **NewsSidebar** and scanners (`RoiScanner`, `SpreadScanner`, `VolatilityScanner`) are in `src/trading/components/`. Zerodha basket-margin helper: `src/trading/zerodhaMargin.js` + `useZerodhaMargins.js`.
- Chart deep-link: "Open in Kite ↗" builds `kite.zerodha.com/markets/ext/chart/web/tvc/{EXCH}/{TSYM}/{TOKEN}`; token from backend `GET /zerodha/instrument-token` (kite instruments dump).

## Verifying changes
- Frontend changes: confirm with `npx vite build --mode development` (fast) and, when observable, the preview tools. Backend is often running with `--reload`; `.env` changes need a manual restart.
- User's memory dir holds durable project facts — check the MEMORY.md index if present.
