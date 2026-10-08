# Trading Chart — KLineCharts design & plan

Status: **design / not yet built** · Last updated: 2026-10-09

Goal: an in-dashboard candlestick chart for the full NSE universe (stocks + F&O +
indices) with (a) our computed **breakeven / strike / scalp levels drawn as horizontal
lines**, and (b) **trade-from-chart**: drag SL/target lines and click-to-arm scalps,
wired to our existing order + scalp engine.

---

## 1. Library decision — raw `klinecharts`, NOT KLineChart Pro

We will build on the base **`klinecharts`** library, not `@klinecharts/pro`.

Why (verified 2026-10-09 against the docs + the Pro bundle):

- **Phase 2 (draggable order lines) is the hard requirement, and it is only guaranteed
  if we control the chart instance.** On raw klinecharts, `init(el)` returns the chart
  instance, and we call `createOverlay` / `registerOverlay` directly.
- **KLineChart Pro does not expose its chart instance.** Its entire public API is
  `setTheme/getTheme`, `setStyles/getStyles`, `setLocale`, `setTimezone`,
  `setSymbol/getSymbol`, `setPeriod/getPeriod`. The dist bundle imports `init`, `dispose`,
  `registerOverlay` from klinecharts but **not `getChart`**, and there is no global
  `getChart(el)` to retrieve the inner instance. So with Pro we could not reliably attach
  our own order overlays — exactly the "Phase 1 done, Phase 2 impossible" trap to avoid.
- Trade-off: we lose Pro's prebuilt shell (symbol-search box, period bar, indicator menu).
  That shell is modest to rebuild, and we already have the pieces (symbol search via
  `symbol_master.search`, period buttons are trivial).

If we ever want Pro's shell, the only safe way to combine it with Phase 2 would be to
**fork Pro** (Apache-2.0) to expose the instance — more maintenance than it's worth vs.
building the shell on raw klinecharts.

### Phase 2 feasibility — confirmed klinecharts capabilities
- Custom overlays: `registerOverlay({ name, totalStep, createPointFigures, ... })` (global),
  `chart.createOverlay(...)`, `chart.overrideOverlay(...)`, `chart.removeOverlay(...)`.
- Built-in horizontal overlays: **`priceLine`**, `horizontalRayLine`, `horizontalStraightLine`,
  `horizontalSegment`.
- Drag interaction: **`onPressedMoveStart`, `onPressedMoving`, `onPressedMoveEnd`**;
  `lock: true` disables dragging (we use `lock: false` for order lines, `lock: true` for
  read-only breakeven/strike lines).
- Other hooks: `onClick`, `onDoubleClick`, `onRightClick` (call `event.preventDefault()`
  to stop the default delete), `onRemoved`, `onSelected/onDeselected`, `onMouseEnter/Leave`.
- `performEventPressedMove` in a custom template can constrain movement to the price axis
  (so an order line only moves in price, never in time).

---

## 2. Where it lives

A new **"Chart"** tab in the trading terminal (alongside ROI Scanner, Spread Scanner, …):
a full-width chart with a thin right-side order rail (symbol, timeframe, active scalp/position
summary, confirm toggles).

---

## 3. Architecture / data flow

```
 symbol_master.search ─► GET /chart/symbols?q=      ─► symbol search box
 fyers get_candles    ─► GET /chart/candles         ─► chart.applyNewData(bars)   (history)
 Fyers WS socket      ─► WS  /chart/stream?symbol=   ─► chart.updateData(bar)      (realtime)
 strategy/payoff math ─► (already in app)            ─► read-only priceLine overlays (breakeven/strike/spot)
 scalps + positions   ─► GET /scalps, /positions (2s)─► draggable order-line overlays (entry/SL/target)
 drag SL/target line  ─► POST modify scalp/order     ─► scalp engine ─► broker ─► re-fetch ─► snap to confirmed
 click empty price    ─► "Arm scalp here" ─► arm_scalp(trigger=price) (confirm-gated)
```

---

## 4. Frontend component (`src/trading/components/Chart.jsx`)

Three overlay layers on one `klinecharts` instance:

1. **Candles + indicators** — from the datafeed (below). `chart.createIndicator('VOL')`,
   `'MA'`, etc. Period buttons (1m/5m/15m/1h/1d) re-call history.
2. **Read-only level lines** (`lock: true` `priceLine` overlays): breakevens (from the
   existing payoff/strategy math), strategy strikes, spot, optional VWAP/levels. Redrawn when
   the active strategy or spot changes.
3. **Draggable order lines** — a custom overlay registered once (`registerOverlay`) with the
   drag hooks. Each armed scalp / open position renders as: **entry** (solid), **SL** (red,
   draggable), **target** (green, draggable), with qty + live P&L in the label.

State sync: poll `/scalps` + `/positions` every ~2s → reconcile overlays to broker-confirmed
state. A drag updates optimistically, commits on release, then re-fetch snaps the line to the
confirmed value (never leaves an un-acknowledged stop on the chart).

---

## 5. Datafeed (maps to existing backend)

A small provider object with the same shape KLineChart Pro uses (kept deliberately so a later
swap to Pro-style sources is easy), but driven by our own code:

| Method | Purpose | Backed by |
|---|---|---|
| `searchSymbols(q)` | symbol search box (full universe) | ✅ `symbol_master.search()` (exists) |
| `getHistoryKLineData(symbol, period, from, to)` | historical candles | ✅ `fyers_client.get_candles()` → map to `{ timestamp, open, high, low, close, volume }` |
| `subscribe(symbol, period, cb)` | realtime → `cb(latestBar)` rolls the forming candle | ✅ Fyers WS socket → new `/chart/stream` relay |
| `unsubscribe(symbol, period)` | stop the stream | ✅ close that relay |

### Data-source abstraction (future-proofing)
`/chart/candles` + `/chart/stream` sit behind a `DataProvider` interface:
- **v1: Fyers** (free, already live) — good for recent/scalping candles.
- **later: TrueData / AccelPix** — deep historical intraday for analysis; swap the provider
  with no change to the chart or order code. Brokers stay **execution-only**.

---

## 6. Backend — mostly exists

| Need | Status |
|---|---|
| Historical candles | ✅ `fyers_client.get_candles()` — wrap in `GET /chart/candles` (new, thin) |
| Live ticks | ✅ Fyers WS socket already running — add `GET/WS /chart/stream` relay (new) |
| Symbol search | ✅ `symbol_master.search()` — expose/ reuse |
| Place / modify / cancel order | ✅ existing order endpoints |
| Arm / exit / cancel / adjust scalp | ✅ existing scalp engine (`arm_scalp`, `exit_scalp`, `set_scalp_auto`, `list_scalps`) |
| Positions / open orders | ✅ `get_positions`, order book |

**Only new backend code:** a candles REST wrapper and a tick-relay stream. Everything
trade-related reuses what exists.

---

## 7. Trade-from-chart mapping (the crux)

Scalp model (trigger / SL / target / qty) ↔ three chart lines:

- **Drag SL line** → on release → modify scalp SL (or the SL order) to the dropped price →
  re-fetch → line snaps to confirmed value.
- **Drag target line** → modify target, same pattern.
- **Drag a pending entry/trigger line** → re-arm scalp at the new trigger.
- **Click empty space at a price** → "Arm scalp here" popup → prefilled `arm_scalp(trigger=price)`.
- **Right-click a line** → cancel/exit (with `preventDefault()` so klinecharts' own delete
  doesn't fire first).

**Safety (non-negotiable — this moves real stops):**
- Confirm-gate every commit (respect the app's existing confirm setting; paper/confirm-first
  during development).
- Debounce drag commits; ignore drags while a modify is in-flight.
- Always reconcile against broker state after a commit; the chart shows confirmed state, not
  the optimistic drag.

---

## 8. Phasing

- **Phase 1 — read-only + click-to-arm.** Raw klinecharts shell (symbol search, periods,
  indicators) + Fyers datafeed (history + WS) + static breakeven/strike/spot lines +
  click-a-price → arm scalp (confirm-gated). Low risk, self-contained.
- **Phase 2 — draggable order lines.** Custom draggable SL/target overlays wired to
  scalp/order modify, with the safety guards above. The real trade-from-chart work.
- **Phase 3 — data + analysis (optional).** Swap/augment datafeed with TrueData for deep
  history; add more indicators/drawing tools.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Pro hides the chart instance (blocks overlays) | **Resolved** — use raw klinecharts; `init()` returns the instance. |
| Drag moves a real stop by accident | Confirm-gate + debounce + reconcile; paper/confirm-first in dev. |
| Fyers WS/history load competing with live trading feed | One charted symbol at a time; light; keep separate from scan bursts. |
| Shallow Fyers intraday history for analysis | DataProvider abstraction → swap to TrueData/AccelPix later without rework. |
| Realtime candle rolling correctness (ticks → OHLC) | Build/roll the forming candle server-side in the relay; send clean bars to `updateData`. |

---

## 10. Open items to verify at build time
- Exact `klinecharts` version + `init/createOverlay/registerOverlay` signatures (API has
  shifted across v9.x) — pin a specific version.
- Fyers `get_candles` resolution codes + max range per request (chunk history if needed).
- Fyers WS tick fields → OHLC rolling per period.
- Confirm the custom order-overlay template renders the label (price + qty + P&L) cleanly on
  both light/dark themes.
