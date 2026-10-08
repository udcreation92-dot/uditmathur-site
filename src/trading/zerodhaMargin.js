import { api } from "./api";
import { fyersToZerodha } from "./zerodhaSymbol";

// Fetches a combo's Zerodha basket margin. `legs` = [{ symbol (Fyers-format), side, quantity }].
// Returns { net, gross }: net = final total after hedge/spread benefit; gross = standalone sum.
export async function comboZerodhaMargin(legs) {
  const marginLegs = legs.map(l => {
    const { exchange, tradingsymbol } = fyersToZerodha(l.symbol);
    return {
      exchange, tradingsymbol, side: l.side, product: "NRML",
      order_type: "MARKET", quantity: l.quantity, price: 0, trigger_price: 0, variety: "regular",
    };
  });
  const res = await api.zerodhaCalculateMargin(marginLegs);
  const net = res?.final?.total ?? res?.initial?.total;
  const gross = res?.initial?.total;
  if (net == null) throw new Error("No margin in response");
  return { net, gross };
}

// Annualized ROI (%) of premium collected against a margin requirement.
export function roiFromMargin(premiumMoney, margin, daysToExpiry) {
  if (!margin || !daysToExpiry) return null;
  return (premiumMoney / margin) * (365 / daysToExpiry) * 100;
}
