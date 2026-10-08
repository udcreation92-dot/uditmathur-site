import os
from fastapi import APIRouter, HTTPException
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from typing import Optional

from shoonya_client import client, ShoonyaError
from fyers_client import client as fyers_client
import shoonya_symbols
import state_paths

router = APIRouter(prefix="/shoonya", tags=["shoonya"])

FRONTEND_URL = os.environ.get("FRONTEND_URL", "http://localhost:5173/task/trading.html")

# Fyers-style enums (what the rest of the app speaks) -> Shoonya/Noren codes.
SIDE_MAP = {"BUY": "B", "SELL": "S"}
ORDER_TYPE_MAP = {"MKT": "MKT", "LMT": "LMT", "SL": "SL-LMT", "SL-M": "SL-MKT"}
PRODUCT_MAP = {"INTRADAY": "I", "CNC": "C", "MARGIN": "M", "NRML": "M"}


@router.get("/auth/status")
def auth_status():
    try:
        return {"logged_in": client.is_logged_in()}
    except Exception:
        return {"logged_in": False}


_IP_STATE_FILE = str(state_paths.state_path(".shoonya_ip_state.json"))


def _read_last_ok_ip():
    import json
    try:
        with open(_IP_STATE_FILE) as fh:
            return json.load(fh).get("last_ok_ip")
    except Exception:
        return None


def _write_last_ok_ip(ip: str):
    import json
    try:
        with open(_IP_STATE_FILE, "w") as fh:
            json.dump({"last_ok_ip": ip}, fh)
    except Exception:
        pass


def _current_egress_ipv4():
    """The IPv4 Shoonya sees (api.shoonya.com is IPv4-only). None if unreachable."""
    import shoonya_client
    try:
        return shoonya_client._shoonya_session.get("https://api.ipify.org", timeout=10).text.strip()
    except Exception:
        return None


@router.get("/ip-guard")
def ip_guard():
    """Startup guard for the recurring Shoonya home-IP drift. Compares the CURRENT egress IPv4
    (what Shoonya sees) against the IP that was current the last time Shoonya was connected. While
    logged in, the current IP is working, so it's recorded as the known-good. When disconnected and
    the IP has since drifted, `changed` is true and the UI warns you to re-whitelist BEFORE trading."""
    import shoonya_client
    current = _current_egress_ipv4()
    try:
        logged_in = shoonya_client.client.is_logged_in()
    except Exception:
        logged_in = False
    if logged_in and current:
        _write_last_ok_ip(current)  # this IP is demonstrably working -> new known-good
        return {"current_ip": current, "last_ok_ip": current, "changed": False, "logged_in": True}
    last_ok = _read_last_ok_ip()
    return {"current_ip": current, "last_ok_ip": last_ok,
            "changed": bool(last_ok and current and current != last_ok), "logged_in": logged_in}


@router.get("/egress-ip")
def egress_ip():
    """Diagnostic: the exact IP that must be whitelisted on the Shoonya API-key page.

    api.shoonya.com is IPv4-ONLY (no AAAA record), so every Shoonya API call — login, token
    exchange, orders — leaves over IPv4 and Shoonya only ever sees your IPv4. An IPv6 whitelist
    entry can NEVER match; whitelist `whitelist_this` (your IPv4) as the Primary IP. `ipv6` is shown
    for reference only. Uses the same session as the token exchange (SHOONYA_PROXY_URL is blank —
    Shoonya's firewall blocks the datacenter proxy — so this is your home IP)."""
    import shoonya_client
    sess = shoonya_client._shoonya_session
    out = {"proxy_configured": bool(shoonya_client._SHOONYA_PROXY_URL),
           "note": "api.shoonya.com is IPv4-only — whitelist 'whitelist_this' (IPv4) as Shoonya Primary IP."}
    # api.ipify.org is IPv4-only, so this echoes the exact IPv4 Shoonya sees; api6 is IPv6 reference.
    for label, url in (("whitelist_this", "https://api.ipify.org"), ("ipv6", "https://api6.ipify.org")):
        try:
            out[label] = sess.get(url, timeout=12).text.strip()
        except Exception as e:
            out[label] = f"(unreachable: {type(e).__name__})"
    return out


@router.get("/auth/login-url")
def login_url():
    """OAuth login URL — the frontend redirects the browser here to log in to Shoonya."""
    try:
        return {"url": client.get_oauth_url()}
    except ShoonyaError as e:
        raise HTTPException(400, str(e))


@router.post("/auth/callback")
def auth_callback(code: str):
    """Exchange an OAuth auth code (pasted/handled by the frontend) for an access token."""
    try:
        return {"status": "logged in", **client.exchange_auth_code(code)}
    except ShoonyaError as e:
        raise HTTPException(400, str(e))


@router.get("/auth/redirect")
def auth_redirect(code: str = None, request_token: str = None):
    """Shoonya's OAuth redirect target (register this URL on trade.shoonya.com). Exchanges the
    code server-side, then bounces the browser back to the frontend — no copy/paste needed."""
    auth_code = code or request_token
    if not auth_code:
        return RedirectResponse(f"{FRONTEND_URL}?shoonya_login=error")
    try:
        client.exchange_auth_code(auth_code)
        return RedirectResponse(f"{FRONTEND_URL}?shoonya_login=success")
    except Exception:
        return RedirectResponse(f"{FRONTEND_URL}?shoonya_login=error")


@router.post("/auth/logout")
def logout():
    client.logout()
    return {"status": "logged out"}


def _num(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


@router.get("/positions")
def positions():
    """Normalized to the same shape the frontend uses for Fyers/Zerodha positions."""
    try:
        raw = client.get_positions()
    except ShoonyaError as e:
        raise HTTPException(400, str(e))
    out = []
    for p in raw:
        net_qty = int(_num(p.get("netqty")))
        if net_qty == 0:
            continue
        out.append({
            "symbol": p.get("tsym"),
            "exchange": p.get("exch"),
            "product": p.get("prd"),
            "netQty": net_qty,
            "netAvg": _num(p.get("netavgprc") or p.get("netupldprc")),
            "ltp": _num(p.get("lp")),
            "pl": _num(p.get("rpnl")) + _num(p.get("urmtom")),  # realized + unrealized MTM
            "raw": p,
        })
    return out


@router.get("/holdings")
def holdings():
    """Normalize Noren holdings (nested exch_tsym list, upldprc avg) into the same shape the
    Holdings view uses for Fyers/Zerodha, and enrich last price + P&L from Fyers market data
    (Shoonya's holdings payload carries neither)."""
    try:
        raw = client.get_holdings()
    except ShoonyaError as e:
        raise HTTPException(400, str(e))
    items = []
    for h in (raw or []):
        et = h.get("exch_tsym") or []
        nse = next((e for e in et if e.get("exch") == "NSE"), (et[0] if et else {})) or {}
        tsym = nse.get("tsym", "")
        qty = int(_num(h.get("holdqty"))) + int(_num(h.get("btstqty")))
        if not tsym or qty == 0:
            continue
        fy = None
        try:
            fy = shoonya_symbols.shoonya_to_fyers(tsym, nse.get("exch", "NSE"))
        except Exception:
            fy = None
        items.append({
            "tradingsymbol": tsym, "quantity": qty, "average_price": _num(h.get("upldprc")),
            "last_price": None, "pnl": None, "isin": h.get("isin"), "_fy": fy,
        })
    fysyms = list({it["_fy"] for it in items if it["_fy"]})
    ltp = {}
    if fysyms:
        try:
            resp = fyers_client.get_quotes(",".join(fysyms))
            if resp and resp.get("s") == "ok":
                for d in resp.get("d", []):
                    if d.get("s") == "ok":
                        ltp[d["n"]] = d.get("v", {}).get("lp")
        except Exception:
            pass
    for it in items:
        lp = ltp.get(it.pop("_fy", None))
        if lp is not None:
            it["last_price"] = lp
            it["pnl"] = round((lp - it["average_price"]) * it["quantity"], 2)
    return items


@router.get("/funds")
def funds():
    try:
        lim = client.get_limits()
    except ShoonyaError as e:
        raise HTTPException(400, str(e))
    # Standardized: cash (incl. intraday pay-in/out) + pledged collateral = total; available =
    # total - utilized. Matches the Fyers/Zerodha shape so the funds card is apples-to-apples.
    cash = _num(lim.get("cash")) + _num(lim.get("payin")) - _num(lim.get("payout"))
    collateral = _num(lim.get("collateral"))
    utilized = _num(lim.get("marginused"))
    total = cash + collateral
    return {
        "cash": cash,
        "collateral": collateral,
        "utilized": utilized,
        "available": total - utilized,
        "total": total,
        "native_available": None,
        "raw": lim,
    }


@router.get("/orders/book")
def order_book():
    try:
        return client.get_order_book()
    except ShoonyaError as e:
        raise HTTPException(400, str(e))


@router.get("/trades")
def trades():
    try:
        return client.get_trade_book()
    except ShoonyaError as e:
        raise HTTPException(400, str(e))


class OrderRequest(BaseModel):
    symbol: str            # Fyers-format symbol (converted server-side), e.g. "NSE:NIFTY2670724000CE"
    side: str              # "BUY" or "SELL"
    quantity: int
    order_type: str = "MKT"    # MKT, LMT, SL, SL-M
    product_type: str = "INTRADAY"  # INTRADAY, CNC, MARGIN
    limit_price: float = 0
    trigger_price: float = 0


@router.post("/orders/place")
def place_order(req: OrderRequest):
    if req.side not in SIDE_MAP:
        raise HTTPException(400, "side must be 'BUY' or 'SELL'")
    try:
        contract = shoonya_symbols.fyers_to_shoonya(req.symbol)
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        result = client.place_order(
            exchange=contract["exch"], tradingsymbol=contract["tsym"],
            transaction_type=SIDE_MAP[req.side], quantity=req.quantity,
            price_type=ORDER_TYPE_MAP.get(req.order_type, "MKT"),
            product=PRODUCT_MAP.get(req.product_type, "I"),
            price=req.limit_price, trigger_price=req.trigger_price,
        )
    except ShoonyaError as e:
        raise HTTPException(400, f"Order failed: {e}")
    if result.get("stat") != "Ok":
        raise HTTPException(400, f"Order rejected: {result.get('emsg', result)}")
    return {"order_id": result.get("norenordno"), "tsym": contract["tsym"]}


class CancelRequest(BaseModel):
    order_no: str


@router.delete("/orders/{order_no}")
def cancel_order(order_no: str):
    try:
        result = client.cancel_order(order_no)
    except ShoonyaError as e:
        raise HTTPException(400, f"Cancel failed: {e}")
    return {"order_id": result.get("result", order_no)}


@router.get("/resolve")
def resolve_symbol(symbol: str):
    """Debug helper: shows what Shoonya contract a Fyers symbol maps to, without placing anything."""
    try:
        return shoonya_symbols.fyers_to_shoonya(symbol)
    except ValueError as e:
        raise HTTPException(404, str(e))
