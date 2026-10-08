const BASE = import.meta.env.VITE_TRADING_API_URL || "http://localhost:8000";

// FastAPI returns validation errors as detail: [{ loc, msg, type }, ...] and other errors as a
// plain string. Blindly interpolating the array/object yields "[object Object]", so flatten it.
function formatDetail(detail) {
  if (detail == null) return null;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map(formatDetail).filter(Boolean).join("; ");
  }
  if (typeof detail === "object") {
    const field = Array.isArray(detail.loc) ? detail.loc.filter(l => l !== "body").join(".") : "";
    const msg = detail.msg || detail.message || JSON.stringify(detail);
    return field ? `${field}: ${msg}` : msg;
  }
  return String(detail);
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(formatDetail(err.detail) || "Request failed");
  }
  return res.json();
}

export const api = {
  authStatus: () => request("/auth/status"),
  getLoginUrl: () => request("/auth/login-url"),
  authCallback: (authCode) =>
    request(`/auth/callback?auth_code=${encodeURIComponent(authCode)}`, { method: "POST" }),

  searchScrip: (q, segment) =>
    request(`/market/search?q=${encodeURIComponent(q)}${segment ? `&segment=${segment}` : ""}`),
  getQuote: (symbol) => request(`/market/quote?symbol=${encodeURIComponent(symbol)}`),
  getTBillTradedYields: () => request(`/market/tbills/traded-yields`),
  getCandles: (symbol, resolution = "5", days = 5) => {
    const to = new Date();
    const from = new Date(Date.now() - days * 86400000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    return request(
      `/market/candles?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&range_from=${fmt(from)}&range_to=${fmt(to)}`
    );
  },

  getOptionChain: (symbol, strikeCount = 10, timestamp = "") =>
    request(`/market/option-chain?symbol=${encodeURIComponent(symbol)}&strike_count=${strikeCount}&timestamp=${timestamp}`),
  getDepth: (symbol) => request(`/market/depth?symbol=${encodeURIComponent(symbol)}`),
  // Historical candles for the chart. resolution: "1".."60" (minutes) | "D". from/to: "YYYY-MM-DD".
  getCandles: (symbol, resolution, from, to) =>
    request(`/market/candles?symbol=${encodeURIComponent(symbol)}&resolution=${encodeURIComponent(resolution)}&range_from=${from}&range_to=${to}`),
  getTBills: () => request(`/market/tbills`),
  recordTbillPurchase: (symbol) => request(`/market/tbills/record-purchase?symbol=${encodeURIComponent(symbol)}`, { method: "POST" }),
  getTbillPurchases: () => request(`/market/tbills/purchases`),
  setTbillPurchaseDate: (symbol, date) =>
    request(`/market/tbills/purchases/set?symbol=${encodeURIComponent(symbol)}&date=${encodeURIComponent(date)}`, { method: "POST" }),
  getHoldingLots: () => request(`/market/holding-lots`),
  addHoldingLot: (broker, symbol, date, qty, price) =>
    request(`/market/holding-lots?broker=${encodeURIComponent(broker)}&symbol=${encodeURIComponent(symbol)}&date=${encodeURIComponent(date)}&qty=${qty}&price=${price}`, { method: "POST" }),
  deleteHoldingLot: (lotId, broker, symbol) =>
    request(`/market/holding-lots/${lotId}?broker=${encodeURIComponent(broker)}&symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" }),
  getHoldingTargets: () => request(`/market/holding-targets`),
  armHoldingTarget: (broker, symbol, targetPrice, slPrice) => {
    const p = new URLSearchParams({ broker, symbol });
    if (targetPrice != null && targetPrice !== "") p.set("target_price", targetPrice);
    if (slPrice != null && slPrice !== "") p.set("sl_price", slPrice);
    return request(`/market/holding-targets?${p}`, { method: "POST" });
  },
  setHoldingTargetAuto: (broker, symbol, on) =>
    request(`/market/holding-targets/auto?broker=${encodeURIComponent(broker)}&symbol=${encodeURIComponent(symbol)}&on=${on}`, { method: "POST" }),
  disarmHoldingTarget: (broker, symbol) =>
    request(`/market/holding-targets?broker=${encodeURIComponent(broker)}&symbol=${encodeURIComponent(symbol)}`, { method: "DELETE" }),
  startFoVolatilityScan: () => request(`/market/fo-volatility/start`, { method: "POST" }),
  getFoVolatilityStatus: () => request(`/market/fo-volatility/status`),
  getVolatilityForRoot: (root) => request(`/market/volatility?root=${encodeURIComponent(root)}`),

  getTBillWatch: () => request(`/tbill-watch/status`),
  startTBillWatch: (targetRoi, budgetTotal, broker = "fyers") =>
    request("/tbill-watch/start", { method: "POST", body: JSON.stringify({ target_roi: targetRoi, budget_total: budgetTotal, broker }) }),
  stopTBillWatch: (id) => request("/tbill-watch/stop", { method: "POST", body: JSON.stringify({ id }) }),

  getSpanWatchStatus: () => request("/span-watch/status"),
  checkSpanNow: () => request("/span-watch/check-now", { method: "POST" }),

  getRssStatus: () => request("/rss/status"),
  checkRssNow: () => request("/rss/check-now", { method: "POST" }),
  getRssFeed: (limit = 50, source) => request(`/rss/feed?limit=${limit}${source ? `&source=${encodeURIComponent(source)}` : ""}`),
  getRssAlerts: (symbol) => request(`/rss/alerts?symbol=${encodeURIComponent(symbol)}`),
  getRssForStrategies: () => request("/rss/for-open-strategies"),
  summarizeRss: (url, title, fallbackText) => request("/rss/summarize", { method: "POST", body: JSON.stringify({ url, title, fallback_text: fallbackText }) }),
  getRssBrief: () => request("/rss/brief"),
  generateRssBrief: () => request("/rss/brief", { method: "POST" }),
  getRssSources: () => request("/rss/sources"),
  addRssSource: (name, url) => request("/rss/sources", { method: "POST", body: JSON.stringify({ name, url }) }),
  deleteRssSource: (name) => request(`/rss/sources/${encodeURIComponent(name)}`, { method: "DELETE" }),

  getUpcomingHolidays: (days = 10) => request(`/holidays/upcoming?days=${days}`),

  getCalendarStatus: () => request("/calendar/status"),
  getUpcomingEvents: (days = 14, foOnly = true) => request(`/calendar/upcoming?days=${days}&fo_only=${foOnly}`),
  getMacroEvents: () => request("/calendar/macro"),
  addMacroEvent: (name, date, category) => request("/calendar/macro", { method: "POST", body: JSON.stringify({ name, date, category }) }),
  deleteMacroEvent: (name, date) => request(`/calendar/macro?name=${encodeURIComponent(name)}&date=${encodeURIComponent(date)}`, { method: "DELETE" }),
  askAssistant: (messages) => request("/assistant/ask", { method: "POST", body: JSON.stringify({ messages }) }),
  rollExpiries: (target) => request(`/strategy/roll-expiries?target=${encodeURIComponent(target)}`),
  rollScan: (strategyId, body) => request(`/strategy/${strategyId}/roll-scan`, { method: "POST", body: JSON.stringify(body) }),
  rollExecute: (strategyId, body) => request(`/strategy/${strategyId}/roll-execute`, { method: "POST", body: JSON.stringify(body) }),
  rollStatus: (jobId) => request(`/strategy/roll-status/${jobId}`),
  getCorporateActions: (days = 30, foOnly = false) => request(`/calendar/corporate-actions?days=${days}&fo_only=${foOnly}`),
  getMacroSuggestions: () => request("/calendar/macro-suggestions?status=pending"),
  approveMacroSuggestion: (id) => request(`/calendar/macro-suggestions/${id}/approve`, { method: "POST" }),
  rejectMacroSuggestion: (id) => request(`/calendar/macro-suggestions/${id}/reject`, { method: "POST" }),

  listModules: () => request("/analysis/modules"),
  runAnalysis: (body) => request("/analysis/run", { method: "POST", body: JSON.stringify(body) }),

  placeOrder: (body) => request("/orders/place", { method: "POST", body: JSON.stringify(body) }),
  getPositions: () => request("/orders/positions"),
  getOrderBook: () => request("/orders/book"),
  getFunds: () => request("/orders/funds"),

  calculateMargin: (legs) => request("/strategy/margin", { method: "POST", body: JSON.stringify({ legs }) }),
  executeStrategy: (legs, strategyName, notes) =>
    request("/strategy/execute", { method: "POST", body: JSON.stringify({ legs, strategy_name: strategyName, notes }) }),

  listStrategies: () => request("/strategy/list"),
  listStrategyNames: () => request("/strategy/all"),
  // Order-ledger model: strategies are built from orders, not reconciled positions.
  getUnassignedOrders: () => request("/strategy/unassigned-orders"),
  assignOrder: (body) => request("/strategy/assign-order", { method: "POST", body: JSON.stringify(body) }),
  manualOrder: (body) => request("/strategy/manual-order", { method: "POST", body: JSON.stringify(body) }),
  armAutoExit: (id, body) => request(`/strategy/${id}/auto-exit`, { method: "POST", body: JSON.stringify(body) }),
  disarmAutoExit: (id) => request(`/strategy/${id}/auto-exit`, { method: "DELETE" }),
  updateOrder: (orderRowId, body) => request(`/strategy/order/${orderRowId}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteOrder: (orderRowId) => request(`/strategy/order/${orderRowId}`, { method: "DELETE" }),
  cancelOrder: (orderRowId) => request(`/strategy/order/${orderRowId}/cancel`, { method: "POST" }),
  modifyOrder: (orderRowId, price) => request(`/strategy/order/${orderRowId}/modify`, { method: "POST", body: JSON.stringify({ price }) }),
  whatIfMargin: (legs) => request(`/strategy/whatif-margin`, { method: "POST", body: JSON.stringify({ legs }) }),
  moveLeg: (strategyId, symbol, toStrategyId) => request(`/strategy/${strategyId}/move-leg`, { method: "POST", body: JSON.stringify({ symbol, to_strategy_id: toStrategyId }) }),
  mergeStrategy: (strategyId, intoStrategyId) => request(`/strategy/${strategyId}/merge-into`, { method: "POST", body: JSON.stringify({ into_strategy_id: intoStrategyId }) }),
  closeStrategy: (id) => request(`/strategy/${id}/close`, { method: "POST" }),
  squareOffStrategy: (id) => request(`/strategy/${id}/square-off`, { method: "POST" }),
  addLeg: (body) => request("/strategy/add-leg", { method: "POST", body: JSON.stringify(body) }),
  getPnlHistory: (id) => request(`/strategy/${id}/pnl-history`),
  setStrategyNotes: (id, notes) => request(`/strategy/${id}/notes`, { method: "PATCH", body: JSON.stringify({ notes }) }),

  getUnseenEvents: () => request("/events/unseen"),
  markEventsSeen: (ids) => request("/events/mark-seen", { method: "POST", body: JSON.stringify({ ids }) }),

  roiScan: (body) => request("/strategy/roi-scan", { method: "POST", body: JSON.stringify(body) }),
  spreadScan: (body) => request("/strategy/spread-scan", { method: "POST", body: JSON.stringify(body) }),
  exportSpanPos: (portfolios, filename) =>
    request("/strategy/span-export", { method: "POST", body: JSON.stringify({ portfolios, filename }) }),
  getSpanResults: async () => {
    const res = await fetch(`${BASE}/strategy/span-results`);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: res.statusText }));
      throw new Error(formatDetail(err.detail) || "Failed to load Results.csv");
    }
    return res.text();
  },
  executeMultileg: (legs, strategyName, notes) =>
    request("/strategy/execute-multileg", { method: "POST", body: JSON.stringify({ legs, strategy_name: strategyName, notes }) }),
  executeZerodhaStrategy: (legs, strategyName, notes) =>
    request("/strategy/execute-zerodha", { method: "POST", body: JSON.stringify({ legs, strategy_name: strategyName, notes }) }),

  // Order management
  modifyOrder: (orderId, body) => request(`/orders/${orderId}`, { method: "PATCH", body: JSON.stringify(body) }),
  cancelOrder: (orderId) => request(`/orders/${orderId}`, { method: "DELETE" }),
  exitPositions: (positionId) => request("/orders/exit", { method: "POST", body: JSON.stringify({ position_id: positionId }) }),
  convertPosition: (body) => request("/orders/convert", { method: "POST", body: JSON.stringify(body) }),
  getTradebook: () => request("/orders/tradebook"),
  getHoldings: () => request("/orders/holdings"),
  getOrderHistory: (orderId) => request(`/orders/history/${orderId}`),
  getMarketStatus: () => request("/orders/market-status"),
  logout: () => request("/orders/logout", { method: "POST" }),

  // GTT orders
  placeGtt: (body) => request("/gtt/place", { method: "POST", body: JSON.stringify(body) }),
  modifyGtt: (orderId, body) => request(`/gtt/${orderId}`, { method: "PATCH", body: JSON.stringify(body) }),
  cancelGtt: (orderId) => request(`/gtt/${orderId}`, { method: "DELETE" }),
  listGtt: () => request("/gtt/list"),

  // Alerts
  createAlert: (body) => request("/alerts/create", { method: "POST", body: JSON.stringify(body) }),
  updateAlert: (alertId, body) => request(`/alerts/${alertId}`, { method: "PUT", body: JSON.stringify(body) }),
  deleteAlert: (alertId) => request(`/alerts/${alertId}`, { method: "DELETE" }),
  toggleAlert: (alertId) => request(`/alerts/${alertId}/toggle`, { method: "POST" }),
  listAlerts: () => request("/alerts/list"),

  // Reports
  getLedger: (fromDate, toDate) =>
    request(`/reports/ledger${fromDate ? `?from_date=${fromDate}&to_date=${toDate}` : ""}`),
  getRealisedPnl: (fromDate, toDate) =>
    request(`/reports/realised-pnl${fromDate ? `?from_date=${fromDate}&to_date=${toDate}` : ""}`),
  getTaxPnl: (fromDate, toDate) =>
    request(`/reports/tax-pnl${fromDate ? `?from_date=${fromDate}&to_date=${toDate}` : ""}`),
  getCharges: (fromDate, toDate) =>
    request(`/reports/charges${fromDate ? `?from_date=${fromDate}&to_date=${toDate}` : ""}`),

  // Zerodha (separate broker — orders/positions/funds only)
  zerodhaAuthStatus: () => request("/zerodha/auth/status"),
  zerodhaGetLoginUrl: () => request("/zerodha/auth/login-url"),
  zerodhaAuthCallback: (requestToken) =>
    request(`/zerodha/auth/callback?request_token=${encodeURIComponent(requestToken)}`, { method: "POST" }),
  zerodhaLogout: () => request("/zerodha/auth/logout", { method: "POST" }),
  zerodhaGetFunds: () => request("/zerodha/funds"),
  zerodhaGetPositions: () => request("/zerodha/positions"),
  zerodhaGetHoldings: () => request("/zerodha/holdings"),
  zerodhaGetOrderBook: () => request("/zerodha/orders/book"),
  zerodhaPlaceOrder: (body) => request("/zerodha/orders/place", { method: "POST", body: JSON.stringify(body) }),
  zerodhaModifyOrder: (orderId, body) => request(`/zerodha/orders/${orderId}`, { method: "PATCH", body: JSON.stringify(body) }),
  zerodhaCancelOrder: (orderId, variety = "regular") =>
    request(`/zerodha/orders/${orderId}?variety=${variety}`, { method: "DELETE" }),
  zerodhaGetTrades: () => request("/zerodha/trades"),
  zerodhaCalculateMargin: (legs) => request("/zerodha/margins", { method: "POST", body: JSON.stringify({ legs }) }),
  zerodhaInstrumentToken: (symbol) => request(`/zerodha/instrument-token?symbol=${encodeURIComponent(symbol)}`),
  zerodhaListGtt: () => request("/zerodha/gtt/list"),
  zerodhaPlaceGtt: (body) => request("/zerodha/gtt/place", { method: "POST", body: JSON.stringify(body) }),
  zerodhaModifyGtt: (triggerId, body) => request(`/zerodha/gtt/${triggerId}`, { method: "PUT", body: JSON.stringify(body) }),
  zerodhaCancelGtt: (triggerId) => request(`/zerodha/gtt/${triggerId}`, { method: "DELETE" }),

  // Shoonya (Finvasia Noren — third broker; OAuth redirect login)
  getTotp: (broker) => request(`/totp/${broker}`),
  // Cash-segment scalping
  listScalps: () => request("/scalp/list"),
  createScalp: (body) => request("/scalp", { method: "POST", body: JSON.stringify(body) }),
  setScalpAuto: (on) => request("/scalp/auto", { method: "POST", body: JSON.stringify({ on }) }),
  editScalp: (id, body) => request(`/scalp/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  scalpTradeType: (id, tradeType) => request(`/scalp/${id}/trade-type`, { method: "POST", body: JSON.stringify({ trade_type: tradeType }) }),
  pauseScalp: (id, paused) => request(`/scalp/${id}/pause`, { method: "POST", body: JSON.stringify({ paused }) }),
  cancelScalp: (id) => request(`/scalp/${id}/cancel`, { method: "POST" }),
  exitScalp: (id) => request(`/scalp/${id}/exit`, { method: "POST" }),
  deleteScalp: (id) => request(`/scalp/${id}`, { method: "DELETE" }),
  scalpReport: () => request("/scalp/report"),
  shoonyaAuthStatus: () => request("/shoonya/auth/status"),
  shoonyaIpGuard: () => request("/shoonya/ip-guard"),
  shoonyaAutoLogin: () => request("/autologin/shoonya", { method: "POST" }),
  shoonyaGetLoginUrl: () => request("/shoonya/auth/login-url"),
  shoonyaAuthCallback: (code) => request(`/shoonya/auth/callback?code=${encodeURIComponent(code)}`, { method: "POST" }),
  shoonyaLogout: () => request("/shoonya/auth/logout", { method: "POST" }),
  shoonyaGetFunds: () => request("/shoonya/funds"),
  shoonyaGetPositions: () => request("/shoonya/positions"),
  shoonyaGetHoldings: () => request("/shoonya/holdings"),
  shoonyaGetOrderBook: () => request("/shoonya/orders/book"),
  shoonyaPlaceOrder: (body) => request("/shoonya/orders/place", { method: "POST", body: JSON.stringify(body) }),
  shoonyaCancelOrder: (orderNo) => request(`/shoonya/orders/${encodeURIComponent(orderNo)}`, { method: "DELETE" }),
  shoonyaResolveSymbol: (symbol) => request(`/shoonya/resolve?symbol=${encodeURIComponent(symbol)}`),
  executeShoonyaStrategy: (legs, strategyName, notes) =>
    request("/strategy/execute-shoonya", { method: "POST", body: JSON.stringify({ legs, strategy_name: strategyName, notes }) }),

  // Read Later (saved from the Telegram bot; viewed/managed here)
  readLaterList: () => request("/news/readlater"),
  readLaterSetRead: (id, read) => request("/news/readlater/read", { method: "POST", body: JSON.stringify({ id, read }) }),
  readLaterDelete: (id) => request("/news/readlater/delete", { method: "POST", body: JSON.stringify({ id, read: true }) }),
  readLaterClearRead: () => request("/news/readlater/clear-read", { method: "POST" }),
};
