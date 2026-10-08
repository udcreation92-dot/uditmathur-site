import datetime
from fyers_client import client
from symbol_master import get_lot_size


def _days_to_expiry(expiry_ts: int) -> int:
    """Whole calendar days from today to expiry date, inclusive (+1)."""
    expiry_date = datetime.datetime.fromtimestamp(int(expiry_ts)).date()
    today = datetime.date.today()
    return (expiry_date - today).days + 1


def scan_vertical_spread(underlying: str, option_type: str, sell_strike: float,
                          expiry_ts: int, strike_count: int = 20) -> list[dict]:
    """Covered/vertical credit spread scanner: sell `sell_strike` (option_type CE/PE),
    scan every valid hedge (buy) strike further OTM on the same side. No margin API call —
    real margin comes from exporting these combos to PC-SPAN (see /strategy/span-export)
    plus ELM computed client-side, since the margin API doesn't apply spread hedge benefit
    on this account."""
    option_type = option_type.upper()
    if option_type not in ("CE", "PE"):
        raise ValueError("option_type must be CE or PE")

    days = _days_to_expiry(expiry_ts)
    if days < 1:
        return []

    chain_resp = client.get_option_chain(underlying, strike_count=strike_count, timestamp=str(expiry_ts))
    if not chain_resp or chain_resp.get("s") != "ok":
        return []
    data = chain_resp["data"]

    by_strike = {}
    for row in data["optionsChain"]:
        if row["option_type"] == option_type:
            by_strike[row["strike_price"]] = row

    sell_row = by_strike.get(sell_strike)
    if not sell_row:
        return []
    sell_bid = sell_row.get("bid") or 0
    if sell_bid <= 0:
        return []

    lot_size = get_lot_size(sell_row["symbol"])

    # Hedge (buy) strikes are further OTM than the sell strike, on the same side:
    # higher strikes for a CE (call) spread, lower strikes for a PE (put) spread.
    if option_type == "CE":
        buy_strikes = sorted(s for s in by_strike if s > sell_strike)
    else:
        buy_strikes = sorted((s for s in by_strike if s < sell_strike), reverse=True)

    results = []
    for buy_strike in buy_strikes:
        buy_row = by_strike[buy_strike]
        buy_ask = buy_row.get("ask") or 0
        if buy_ask <= 0:
            continue
        net_premium = sell_bid - buy_ask
        money = net_premium * lot_size
        results.append({
            "option_type": option_type,
            "sell_strike": sell_strike,
            "buy_strike": buy_strike,
            "width": abs(buy_strike - sell_strike),
            "sell_symbol": sell_row["symbol"],
            "buy_symbol": buy_row["symbol"],
            "sell_bid": sell_bid,
            "buy_ask": buy_ask,
            "net_premium": round(net_premium, 2),
            "premium_money": round(money, 2),
            "lot_size": lot_size,
            "days_to_expiry": days,
        })

    return results
