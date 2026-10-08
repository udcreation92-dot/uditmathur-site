// Zerodha's tradingsymbol format is identical to Fyers' minus the exchange prefix, across
// equities, options, futures, and T-Bills (verified against a live Kite instrument dump) —
// e.g. Fyers "NSE:NIFTY2670724200CE" -> Zerodha exchange "NFO", tradingsymbol "NIFTY2670724200CE".
export function fyersToZerodha(fyersSymbol) {
  const body = fyersSymbol.includes(":") ? fyersSymbol.split(":")[1] : fyersSymbol;
  if (body.endsWith("-EQ")) return { exchange: "NSE", tradingsymbol: body.slice(0, -3) };
  if (body.endsWith("-TB")) return { exchange: "NSE", tradingsymbol: body };
  if (body.endsWith("CE") || body.endsWith("PE") || body.endsWith("FUT")) {
    return { exchange: "NFO", tradingsymbol: body };
  }
  return { exchange: "NSE", tradingsymbol: body };
}

const TBILL_RE = /^(\d+)D(\d{2})(\d{2})(\d{2})-TB$/;
// BSE-listed T-Bills use a different tradingsymbol shape: "{tenor}TB{DD}{M or MM}{YY}",
// e.g. "364TB28527" = 364-day, maturity 28-5-2027; "091TB190919" = 91-day, 19-09-2019
// (verified against a live Kite instruments dump — month is 1 digit when < 10).
const TBILL_BSE_RE = /^(\d+)TB(\d{2})(\d{1,2})(\d{2})$/;

// Parses a T-Bill tradingsymbol (e.g. "91D030926-TB" or BSE "364TB28527") into tenor +
// maturity date, or null if the symbol isn't a T-Bill. Works on bare Zerodha symbols and
// Fyers "NSE:...-TB" symbols alike.
export function parseTbillSymbol(symbol) {
  const bare = symbol.includes(":") ? symbol.split(":")[1] : symbol;
  let m = bare.match(TBILL_RE);
  if (m) {
    const [, tenorDays, dd, mm, yy] = m;
    return { tenorDays: +tenorDays, maturityDate: `20${yy}-${mm}-${dd}` };
  }
  m = bare.match(TBILL_BSE_RE);
  if (m) {
    const [, tenorDays, dd, mth, yy] = m;
    return { tenorDays: +tenorDays, maturityDate: `20${yy}-${mth.padStart(2, "0")}-${dd}` };
  }
  return null;
}

export const PRODUCT_TO_ZERODHA = { INTRADAY: "MIS", CNC: "CNC", MARGIN: "NRML" };
export const ORDER_TYPE_TO_ZERODHA = { MKT: "MARKET", LMT: "LIMIT", SL: "SL", "SL-M": "SL-M" };

// Converts a Fyers-shaped order request into a Zerodha placeOrder payload.
export function toZerodhaOrder({ symbol, side, quantity, order_type, limit_price, stop_price, product_type }) {
  const { exchange, tradingsymbol } = fyersToZerodha(symbol);
  return {
    exchange,
    tradingsymbol,
    side,
    quantity,
    order_type: ORDER_TYPE_TO_ZERODHA[order_type] || "MARKET",
    product: PRODUCT_TO_ZERODHA[product_type] || "MIS",
    price: limit_price || 0,
    trigger_price: stop_price || 0,
  };
}
