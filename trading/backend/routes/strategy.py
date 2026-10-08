import re
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel
from typing import List, Optional
from fyers_client import client
from zerodha_client import client as zclient
from shoonya_client import client as sclient, ShoonyaError
import shoonya_symbols
import symbol_master
import strategy_db as db
import roi_scanner
import spread_scanner
import span_pos
import event_calendar

router = APIRouter(prefix="/strategy", tags=["strategy"])

# Ledger durability guard. The strategy ledger lives in a local SQLite file (strategy_db.py).
# On an ephemeral host (e.g. Render without a persistent disk) that file is wiped on every
# restart / redeploy / idle spin-down, so orders written there silently vanish. Set
# LEDGER_READ_ONLY=1 on such deployments: reads/scanners keep working, but any endpoint that
# writes the ledger (or places a broker order) is refused, forcing all order intake to the
# durable local backend instead of quietly accepting entries that will be lost.
import os

_LEDGER_READ_ONLY = os.environ.get("LEDGER_READ_ONLY", "").strip().lower() in ("1", "true", "yes")


def _guard_writable():
    if _LEDGER_READ_ONLY:
        raise HTTPException(
            403,
            "This is the read-only cloud dashboard — its ledger is not durable. "
            "Enter orders on the local dashboard (the PC backend) instead.",
        )


SPAN_DIR = Path(r"C:\Users\udcre\OneDrive\Documents\TradingData\SPAN")

ORDER_TYPE_MAP = {"MKT": 2, "LMT": 1, "SL": 4, "SL-M": 3}


class RoiScanRequest(BaseModel):
    target_roi_pct: float
    underlyings: Optional[List[str]] = None
    max_expiries: int = 3
    strike_count: int = 20
    expiry_index: Optional[int] = None   # scan only this single expiry (0 = nearest); overrides max_expiries
    scan_all: bool = False               # scan EVERY listed expiry (ignores expiry_index)
    safe_ce: Optional[float] = None      # include only CE strikes >= this (snapped to nearest strike)
    safe_pe: Optional[float] = None      # include only PE strikes <= this (snapped to nearest strike)
    limit: int = 40                      # cap to top-N by ELM-score (frontend auto-pulls real margin per row)


@router.post("/roi-scan")
def roi_scan(req: RoiScanRequest):
    if req.target_roi_pct < 0:
        raise HTTPException(400, "target_roi_pct cannot be negative")
    results = roi_scanner.scan(
        target_roi_pct=req.target_roi_pct,
        underlyings=req.underlyings,
        # scan_all: sweep every expiry (expiry_index=None + a cap above the ~weekly+monthly count).
        max_expiries=50 if req.scan_all else req.max_expiries,
        strike_count=req.strike_count,
        expiry_index=None if req.scan_all else req.expiry_index,
        safe_ce=req.safe_ce,
        safe_pe=req.safe_pe,
        limit=req.limit,
    )
    return results


class SpreadScanRequest(BaseModel):
    underlying: str
    option_type: str     # "CE" or "PE"
    sell_strike: float
    expiry_ts: int
    strike_count: int = 20


@router.post("/spread-scan")
def spread_scan(req: SpreadScanRequest):
    if req.option_type.upper() not in ("CE", "PE"):
        raise HTTPException(400, "option_type must be CE or PE")
    return spread_scanner.scan_vertical_spread(
        underlying=req.underlying,
        option_type=req.option_type,
        sell_strike=req.sell_strike,
        expiry_ts=req.expiry_ts,
        strike_count=req.strike_count,
    )


class PosLeg(BaseModel):
    pf_code: str
    expiry: str          # YYYYMMDD
    option_type: str     # "C" or "P"
    strike: float
    net: int             # signed quantity, negative = short


class SpanExportRequest(BaseModel):
    portfolios: List[List[PosLeg]]
    filename: Optional[str] = None


@router.post("/span-export")
def span_export(req: SpanExportRequest):
    if not req.portfolios:
        raise HTTPException(400, "No portfolios to export")
    run_id = uuid.uuid4().hex[:8].upper()
    xml = span_pos.build_pos_file([[leg.dict() for leg in legs] for legs in req.portfolios], acct_id=run_id)
    filename = req.filename or "scan_export.pos"
    if not filename.endswith(".pos"):
        filename += ".pos"
    SPAN_DIR.mkdir(parents=True, exist_ok=True)
    path = SPAN_DIR / filename
    path.write_text(xml, encoding="utf-8")
    return {"path": str(path), "filename": filename, "run_id": run_id}


@router.get("/span-results")
def span_results():
    """Reads Results.csv from the PC-SPAN output folder directly — no upload needed,
    since both this backend and PC-SPAN run on the same machine."""
    path = SPAN_DIR / "Results.csv"
    if not path.exists():
        raise HTTPException(404, "Results.csv not found in SPAN folder yet")
    return Response(content=path.read_text(encoding="utf-8"), media_type="text/csv")


class Leg(BaseModel):
    symbol: str
    side: str            # "BUY" or "SELL"
    quantity: int
    order_type: str = "MKT"
    limit_price: float = 0
    product_type: str = "MARGIN"  # multi-day F&O strategies default to margin/NRML, not intraday


class MarginRequest(BaseModel):
    legs: List[Leg]


class ExecuteRequest(BaseModel):
    legs: List[Leg]
    strategy_name: Optional[str] = None
    notes: Optional[str] = None   # trade journal: why entered, plan, exit rule


class AllocateRequest(BaseModel):
    symbol: str
    side: str             # "BUY" or "SELL" — direction of the position slice being allocated
    quantity: int
    broker: str = "fyers"
    strategy_id: Optional[int] = None
    strategy_name: Optional[str] = None  # creates a new strategy if strategy_id not given


def _to_fyers_legs(legs: List[Leg]):
    fyers_legs = []
    for leg in legs:
        if leg.side not in ("BUY", "SELL"):
            raise HTTPException(400, "side must be 'BUY' or 'SELL'")
        fyers_legs.append({
            "symbol": leg.symbol,
            "qty": leg.quantity,
            "side": 1 if leg.side == "BUY" else -1,
            "type": ORDER_TYPE_MAP.get(leg.order_type, 2),
            "productType": leg.product_type,
            "limitPrice": leg.limit_price,
            "stopLoss": 0,
        })
    return fyers_legs


@router.post("/margin")
def calculate_margin(req: MarginRequest):
    if not req.legs:
        raise HTTPException(400, "At least one leg is required")
    fyers_legs = _to_fyers_legs(req.legs)
    result = client.get_margin(fyers_legs)
    if result.get("s") != "ok":
        raise HTTPException(400, f"Margin calculation failed: {result.get('message', result)}")
    return result["data"]


@router.post("/execute")
def execute_strategy(req: ExecuteRequest):
    _guard_writable()
    if not req.legs:
        raise HTTPException(400, "At least one leg is required")

    fyers_legs = [{
        "symbol": leg.symbol,
        "qty": leg.quantity,
        "side": 1 if leg.side == "BUY" else -1,
        "type": ORDER_TYPE_MAP.get(leg.order_type, 2),
        "productType": leg.product_type,
        "limitPrice": leg.limit_price,
    } for leg in req.legs]

    result = client.place_basket_order(fyers_legs)

    strategy_id = None
    failures = []
    if req.strategy_name:
        strategy_id = db.create_strategy(req.strategy_name, notes=req.notes)
        data = result.get("data") if isinstance(result, dict) else None
        recorded = 0
        for i, leg in enumerate(req.legs):
            item = data[i] if (data and i < len(data)) else None
            oid = None
            try:
                oid = item["body"]["id"] if isinstance(item, dict) else None
            except (KeyError, TypeError, IndexError):
                oid = None
            if oid:
                # Accepted at the broker -> PENDING with its id; _resolve_pending_orders fills it.
                db.add_order(strategy_id, "fyers", leg.symbol, leg.side, leg.quantity, leg.limit_price,
                             order_id=str(oid), status="PENDING", source="builder")
                recorded += 1
            else:
                # NO broker order id => the order was NOT accepted (rejected/margin/error). Record it
                # REJECTED (excluded from the position) — do NOT phantom-fill it as a real leg. A
                # genuinely-placed order with an unparseable id would still surface in the broker
                # order book / unassigned-orders inbox to assign, so nothing real is lost either way.
                msg = None
                try:
                    b = item.get("body") if isinstance(item, dict) else None
                    msg = (b.get("message") if isinstance(b, dict) else None) or (item.get("message") if isinstance(item, dict) else None)
                except Exception:
                    msg = None
                db.add_order(strategy_id, "fyers", leg.symbol, leg.side, leg.quantity, leg.limit_price,
                             order_id=None, status="REJECTED", source="builder")
                failures.append({"symbol": leg.symbol, "message": msg or "order not accepted by the broker (no order id)"})
        if recorded == 0:
            # The whole basket was rejected — don't leave a phantom empty strategy behind.
            db.delete_strategy(strategy_id)
            strategy_id = None
            raise HTTPException(502, "Fyers rejected the order — nothing was placed. "
                                + (result.get("message") if isinstance(result, dict) else "")
                                + " " + "; ".join(f["message"] for f in failures))

    return {"order_result": result, "strategy_id": strategy_id, "failures": failures}


def _to_zerodha_leg(leg: Leg) -> dict:
    """Fyers-format leg -> Zerodha order params (exchange + bare tradingsymbol), mirroring the
    frontend's zerodhaSymbol.js conversion so both paths agree on the symbol format."""
    body = leg.symbol.split(":")[-1]
    if body.endswith("-EQ"):
        return {"exchange": "NSE", "tradingsymbol": body[:-3]}
    if body.endswith(("CE", "PE", "FUT")):
        return {"exchange": "NFO", "tradingsymbol": body}
    return {"exchange": "NSE", "tradingsymbol": body}


def _round_tick(price: float, tick: float = 0.05) -> float:
    return round(round(price / tick) * tick, 2)


# Zerodha rejects plain MARKET orders for options placed via API ("Market orders without
# market protection are not allowed via API") — their sanctioned workaround is a marketable
# LIMIT order at LTP padded by a protection buffer, which fills like a market order in any
# liquid book but caps the worst fill instead of sweeping a thin one.
MARKET_PROTECTION_PCT = 3.0


def _protective_limit(ltp: float, side: str) -> float:
    pad = ltp * MARKET_PROTECTION_PCT / 100
    price = ltp + pad if side == "BUY" else ltp - pad
    return max(_round_tick(price), 0.05)


@router.post("/execute-zerodha")
def execute_zerodha_strategy(req: ExecuteRequest):
    """Zerodha counterpart of /execute: places each leg as its own Kite order AND records the
    strategy with broker='zerodha' allocations, so Zerodha trades show up in the same strategy
    P&L/ROI tracking as Fyers ones (compute_strategies already joins Zerodha positions).
    MARKET legs on options are converted to protective LIMIT orders — see _protective_limit."""
    _guard_writable()
    if not req.legs:
        raise HTTPException(400, "At least one leg is required")

    zlegs = [_to_zerodha_leg(leg) for leg in req.legs]

    # One batched LTP call for every MARKET option leg that needs a protective limit price.
    need_ltp = [f'{z["exchange"]}:{z["tradingsymbol"]}'
                for leg, z in zip(req.legs, zlegs)
                if leg.order_type == "MKT" and z["exchange"] in ("NFO", "BFO")]
    ltp_map = {}
    if need_ltp:
        try:
            ltp_map = zclient.get_ltp(need_ltp)
        except Exception:
            pass

    leg_results = []
    any_ok = False
    for leg, z in zip(req.legs, zlegs):
        if leg.side not in ("BUY", "SELL"):
            raise HTTPException(400, "side must be 'BUY' or 'SELL'")
        order_type, price = ("LIMIT", leg.limit_price) if leg.order_type == "LMT" else ("MARKET", None)
        converted_to_limit = False
        if order_type == "MARKET" and z["exchange"] in ("NFO", "BFO"):
            ltp = ltp_map.get(f'{z["exchange"]}:{z["tradingsymbol"]}')
            if ltp:
                order_type, price = "LIMIT", _protective_limit(ltp, leg.side)
                converted_to_limit = True
            # No LTP available -> let the MARKET order through and surface Kite's own
            # rejection message rather than inventing a price blind.
        try:
            order_id = zclient.place_order(
                variety="regular", exchange=z["exchange"], tradingsymbol=z["tradingsymbol"],
                transaction_type=leg.side, quantity=leg.quantity,
                product="NRML" if z["exchange"] in ("NFO", "BFO") else ("CNC" if leg.product_type == "CNC" else "MIS"),
                order_type=order_type, price=price,
            )
            any_ok = True
            leg_results.append({"symbol": leg.symbol, "side": leg.side, "qty": leg.quantity, "ok": True,
                                "order_id": order_id, "price": price,
                                "protected_limit": converted_to_limit})
        except Exception as e:
            leg_results.append({"symbol": leg.symbol, "side": leg.side, "qty": leg.quantity, "ok": False,
                                "message": str(e)})

    # Track whatever actually got placed — a partially-filled strategy still needs monitoring
    # (arguably more than a fully-filled one).
    strategy_id = None
    if req.strategy_name and any_ok:
        strategy_id = db.create_strategy(req.strategy_name, notes=req.notes)
        for leg, z, r in zip(req.legs, zlegs, leg_results):
            if r["ok"] and r.get("order_id"):
                # Orders store the bare Zerodha tradingsymbol. Recorded PENDING with the broker id
                # so _resolve_pending_orders promotes it to FILLED (auto-assigned, never unassigned).
                db.add_order(strategy_id, "zerodha", z["tradingsymbol"], leg.side, leg.quantity,
                             r.get("price") or leg.limit_price, order_id=str(r["order_id"]),
                             status="PENDING", source="builder")

    return {"legs": leg_results, "strategy_id": strategy_id, "all_ok": all(r["ok"] for r in leg_results)}


@router.post("/execute-shoonya")
def execute_shoonya_strategy(req: ExecuteRequest):
    """Shoonya counterpart of /execute-zerodha: places each leg on Shoonya AND records the
    strategy with broker='shoonya' allocations (stored in Fyers symbol format, so live P&L /
    margin / expiry reuse the existing Fyers/Zerodha-format logic). Only the successfully placed
    legs are tracked, so a partial fill is still monitored."""
    _guard_writable()
    if not req.legs:
        raise HTTPException(400, "At least one leg is required")

    leg_results = []
    any_ok = False
    for leg in req.legs:
        if leg.side not in ("BUY", "SELL"):
            raise HTTPException(400, "side must be 'BUY' or 'SELL'")
        try:
            contract = shoonya_symbols.fyers_to_shoonya(leg.symbol)
        except ValueError as e:
            leg_results.append({"symbol": leg.symbol, "side": leg.side, "qty": leg.quantity,
                                "ok": False, "message": str(e)})
            continue
        price_type = "LMT" if leg.order_type == "LMT" else "MKT"
        product = {"INTRADAY": "I", "CNC": "C", "MARGIN": "M"}.get(leg.product_type, "M")
        try:
            result = sclient.place_order(
                exchange=contract["exch"], tradingsymbol=contract["tsym"],
                transaction_type="B" if leg.side == "BUY" else "S",
                quantity=leg.quantity, price_type=price_type, product=product,
                price=leg.limit_price,
            )
            ok = result.get("stat") == "Ok"
            any_ok = any_ok or ok
            leg_results.append({"symbol": leg.symbol, "side": leg.side, "qty": leg.quantity, "ok": ok,
                                "order_id": result.get("norenordno") if ok else None,
                                "message": None if ok else result.get("emsg", str(result))})
        except Exception as e:
            leg_results.append({"symbol": leg.symbol, "side": leg.side, "qty": leg.quantity,
                                "ok": False, "message": str(e)})

    strategy_id = None
    if req.strategy_name and any_ok:
        strategy_id = db.create_strategy(req.strategy_name, notes=req.notes)
        for leg, r in zip(req.legs, leg_results):
            if r["ok"] and r.get("order_id"):
                # Shoonya orders store the Fyers symbol. PENDING + broker id -> auto-filled.
                db.add_order(strategy_id, "shoonya", leg.symbol, leg.side, leg.quantity,
                             leg.limit_price, order_id=str(r["order_id"]), status="PENDING", source="builder")

    return {"legs": leg_results, "strategy_id": strategy_id, "all_ok": all(r["ok"] for r in leg_results)}


@router.post("/execute-multileg")
def execute_multileg_strategy(req: ExecuteRequest):
    """Places legs via Fyers' dedicated multileg endpoint (2 or 3 legs, IOC, atomic at the exchange)
    instead of independent basket orders. Falls back is not automatic — if this fails, use /execute."""
    _guard_writable()
    if len(req.legs) not in (2, 3):
        raise HTTPException(400, "Multileg orders require exactly 2 or 3 legs")

    fyers_legs = [{
        "symbol": leg.symbol,
        "qty": leg.quantity,
        "side": 1 if leg.side == "BUY" else -1,
        "type": ORDER_TYPE_MAP.get(leg.order_type, 1),
        "limitPrice": leg.limit_price,
    } for leg in req.legs]

    product_type = req.legs[0].product_type
    order_type = "3L" if len(req.legs) == 3 else "2L"
    result = client.place_multileg_order(fyers_legs, product_type=product_type, order_type=order_type)

    strategy_id = None
    if req.strategy_name and result.get("s") == "ok":
        strategy_id = db.create_strategy(req.strategy_name, notes=req.notes)
        # Multileg is atomic IOC (fills immediately or cancels) and returns no per-leg ids, so
        # record the legs FILLED at their limit price.
        for leg in req.legs:
            db.add_order(strategy_id, "fyers", leg.symbol, leg.side, leg.quantity, leg.limit_price,
                         order_id=None, status="FILLED", source="builder")

    return {"order_result": result, "strategy_id": strategy_id}


def _compute_pnl_map(positions: list[dict], broker: str) -> dict[tuple[str, str], dict]:
    """(broker, symbol) -> {netQty, unit_pl, ltp, netAvg}"""
    out = {}
    for p in positions:
        net_qty = p.get("netQty", 0)
        pl = p.get("pl", 0)
        out[(broker, p["symbol"])] = {
            "netQty": net_qty,
            "unit_pl": (pl / net_qty) if net_qty else 0,
            "ltp": p.get("ltp"),
            "netAvg": p.get("netAvg"),
        }
    return out


def _is_option_symbol(symbol: str) -> bool:
    """Option leg (Fyers symbol ending CE/PE). Used where the premium-decay ROI logic applies."""
    return symbol.endswith("CE") or symbol.endswith("PE")


def _is_future_symbol(symbol: str) -> bool:
    """Future leg (Fyers symbol ending FUT)."""
    return symbol.endswith("FUT")


def _is_fno_symbol(symbol: str) -> bool:
    """The strategy/allocation system tracks F&O — options AND futures — but not equity
    delivery. This is the inclusion gate for positions/legs."""
    return _is_option_symbol(symbol) or _is_future_symbol(symbol)


_INDEX_UNDERLYING = {
    "NIFTY": "NSE:NIFTY50-INDEX", "BANKNIFTY": "NSE:NIFTYBANK-INDEX",
    "FINNIFTY": "NSE:FINNIFTY-INDEX", "MIDCPNIFTY": "NSE:MIDCPNIFTY-INDEX",
    "NIFTYNXT50": "NSE:NIFTYNXT50-INDEX",
}
_ROOT_RE = re.compile(r"^([A-Z&-]+?)\d")


def _leg_root(symbol: str) -> str:
    """Underlying root from a Fyers F&O symbol (e.g. NSE:BANKBARODA26JUL234PE -> BANKBARODA)."""
    body = symbol.split(":")[-1].upper()
    m = _ROOT_RE.match(body)
    return m.group(1) if m else body


def _underlying_symbol(root: str) -> str:
    """Fyers spot symbol for a root — index symbol for indices, else the cash equity."""
    return _INDEX_UNDERLYING.get(root, f"NSE:{root}-EQ")


def _fetch_ltp(symbols: list[str]) -> dict[str, float]:
    """{fyers_symbol: ltp} — from the live WebSocket cache when fresh, REST for the rest."""
    out = {}
    try:
        import fyers_ws
        for s, q in fyers_ws.fresh_quotes(symbols).items():
            if q.get("ltp") is not None:
                out[s] = q["ltp"]
    except Exception:
        pass
    misses = [s for s in symbols if s and s not in out]
    for i in range(0, len(misses), 50):
        chunk = misses[i:i + 50]
        if not chunk:
            continue
        try:
            resp = client.get_quotes(",".join(chunk))
        except Exception:
            continue
        if resp and resp.get("s") == "ok":
            for item in resp.get("d", []):
                if item.get("s") == "ok":
                    out[item["n"]] = item.get("v", {}).get("lp")
    return out


def _leg_fyers_symbol(leg: dict) -> str:
    """Reverse of _leg_zerodha_tradingsymbol — Fyers is this app's market-data source, so a
    Zerodha-executed leg's bare tradingsymbol (e.g. "NIFTY2670724800CE") is prefixed back to
    "NSE:NIFTY2670724800CE" to fetch a live quote for it."""
    symbol = leg["symbol"]
    return symbol if ":" in symbol else f"NSE:{symbol}"


def _leg_zerodha_tradingsymbol(leg: dict) -> str:
    """Zerodha's tradingsymbol format is identical to Fyers' minus the exchange prefix
    (verified against a live Kite instrument dump), so a Fyers option leg like
    "NSE:NIFTY2670724800CE" converts to the Zerodha tradingsymbol "NIFTY2670724800CE" —
    used to price ALL option legs via Zerodha's margin API regardless of which broker the
    trade actually executed on."""
    symbol = leg["symbol"]
    return symbol.split(":")[1] if ":" in symbol else symbol


def _zerodha_all_positions() -> list[dict]:
    """Zerodha open day/carry F&O positions only — equity delivery holdings are intentionally
    excluded here since the strategy-allocation system tracks options positions, not equity."""
    out = []
    try:
        net = (zclient.get_positions() or {}).get("net", [])
        for p in net:
            if p.get("quantity", 0) != 0 and p.get("exchange") in ("NFO", "BFO") and _is_fno_symbol(p["tradingsymbol"]):
                out.append({
                    "symbol": p["tradingsymbol"],
                    "netQty": p["quantity"],
                    "pl": p.get("pnl", 0),
                    "ltp": p.get("last_price"),
                    "netAvg": p.get("average_price"),
                })
    except Exception:
        pass
    return out


def _shoonya_all_positions() -> list[dict]:
    """Open Shoonya F&O option positions, mapped back to this app's Fyers symbol so they join
    against strategy allocations (which are stored in Fyers format for Shoonya legs too). A
    position whose Shoonya tsym can't be reverse-resolved is skipped rather than mis-joined."""
    out = []
    try:
        for p in (sclient.get_positions() or []):
            try:
                net_qty = int(float(p.get("netqty", 0) or 0))
            except (TypeError, ValueError):
                continue
            if net_qty == 0:
                continue
            fy = shoonya_symbols.shoonya_to_fyers(p.get("tsym", ""), p.get("exch", ""))
            if not fy or not _is_fno_symbol(fy):
                continue

            def _f(v):
                try:
                    return float(v)
                except (TypeError, ValueError):
                    return 0.0
            out.append({
                "symbol": fy,
                "netQty": net_qty,
                "pl": _f(p.get("rpnl")) + _f(p.get("urmtom")),
                "ltp": _f(p.get("lp")),
                "netAvg": _f(p.get("netavgprc") or p.get("netupldprc")),
            })
    except Exception:
        pass
    return out


# Per-strategy margin/expiry cache: {leg-composition key: (margin, expiry, fetched_at)}. The
# Positions page polls /strategy/list on an interval, and margin barely moves strategy-to-
# strategy poll-to-poll — recomputing it from Zerodha's basket-margin API every single poll for
# every open strategy was the main cause of slow page loads (each call is a real network
# round-trip, ~15+ strategies = ~15+ Zerodha calls per poll, worse once routed through a proxy).
# Measured: running these concurrently gave essentially NO speedup (Zerodha's margin endpoint —
# or the proxy — appears to serialize/rate-limit concurrent requests rather than truly
# parallelizing them), so a long cache TTL, not more concurrency, is what actually fixes the
# slow page loads; the cache turns a ~40-65s cold computation into a ~0.3s warm one for the vast
# majority of polls. Keyed on the actual leg composition (not strategy id) so edits/
# reassignments naturally invalidate; a strategy whose legs haven't changed reuses the cached
# figure. 3 min is generous for a number that's mostly used as a stable ROI denominator.
_MARGIN_CACHE_TTL = 180  # seconds
_margin_cache: dict[tuple, tuple[float | None, str | None, float]] = {}


def _legs_cache_key(fno_legs: list[dict], tradingsymbols: list[str]) -> tuple:
    return tuple(sorted((ts, leg["side"], leg["qty"]) for leg, ts in zip(fno_legs, tradingsymbols)))


def _strategy_margin_and_expiry(legs: list[dict]) -> tuple[float | None, str | None]:
    """Live margin (via Zerodha's basket margin API) and nearest expiry among a strategy's
    option legs — computed for ALL legs regardless of which broker actually holds the
    position, since Zerodha's margin API is the requested source of truth. Fyers legs are
    converted to their equivalent Zerodha tradingsymbol purely for pricing purposes.
    Cached for _MARGIN_CACHE_TTL seconds per leg composition — see _margin_cache above."""
    fno_legs = [leg for leg in legs if _is_fno_symbol(leg["symbol"])]
    if not fno_legs:
        return None, None

    tradingsymbols = [_leg_zerodha_tradingsymbol(leg) for leg in fno_legs]
    cache_key = _legs_cache_key(fno_legs, tradingsymbols)
    cached = _margin_cache.get(cache_key)
    if cached and time.time() - cached[2] < _MARGIN_CACHE_TTL:
        return cached[0], cached[1]

    orders = [{
        "exchange": "NFO",
        "tradingsymbol": ts,
        "transaction_type": leg["side"],
        "variety": "regular",
        "product": "NRML",
        "order_type": "MARKET",
        "quantity": leg["qty"],
        "price": 0,
        "trigger_price": 0,
    } for leg, ts in zip(fno_legs, tradingsymbols)]

    margin = None
    try:
        result = zclient.get_basket_margins(orders)
        margin = result.get("final", {}).get("total")
    except Exception:
        pass

    expiry = None
    try:
        expiry_map = zclient.get_expiry_map("NFO")
        expiries = [expiry_map[ts] for ts in tradingsymbols if ts in expiry_map]
        if expiries:
            expiry = min(expiries)
    except Exception:
        pass

    _margin_cache[cache_key] = (margin, expiry, time.time())
    return margin, expiry


def _fetch_bid_ask(symbols: list[str]) -> dict[str, dict]:
    """{fyers_symbol: {"bid":, "ask":}} — the exit-realistic quote (sell a long at the bid, buy back
    a short at the ask). Served from the live WebSocket cache when fresh (~0.2s, no broker call);
    anything not streaming is filled in with a batched Fyers REST quote."""
    quote_map = {}
    try:
        import fyers_ws
        for s, q in fyers_ws.fresh_quotes(symbols).items():
            b, a = q.get("bid"), q.get("ask")
            # Require BOTH sides from the stream. A partial tick (e.g. ask=None) must fall through to
            # the REST fallback — otherwise a short leg's buy-back exit gets no ask and can't be placed
            # (this stranded a NYKAA short leg on auto-exit).
            if b is not None and a is not None:
                quote_map[s] = {"bid": b, "ask": a}
    except Exception:
        pass
    misses = [s for s in symbols if s not in quote_map]
    for i in range(0, len(misses), 50):
        chunk = misses[i:i + 50]
        try:
            resp = client.get_quotes(",".join(chunk))
        except Exception:
            continue
        if resp and resp.get("s") == "ok":
            for item in resp.get("d", []):
                if item.get("s") == "ok":
                    v = item.get("v", {})
                    quote_map[item["n"]] = {"bid": v.get("bid"), "ask": v.get("ask")}
    return quote_map


# Statuses that mean the strategy page is showing something that doesn't match reality at the
# broker (the whole point of the reconciliation): PHANTOM/OVER/DIRECTION are strategy-correctness
# problems, UNDER just means there's extra unallocated position at the broker (surfaced
# separately via /strategy/unallocated), and OK means the tally agrees.
_RECON_PROBLEM_STATES = ("phantom", "over", "direction")


def _classify_recon(allocated: int, actual: int) -> str:
    """Compare net qty tracked in strategies (allocated) vs net qty actually at the broker."""
    if allocated == actual:
        return "ok"
    if actual == 0:
        return "phantom"      # tracked as a live strategy leg, but no position at the broker
    if allocated == 0:
        return "unallocated"  # broker position not assigned to any strategy
    if (allocated > 0) != (actual > 0):
        return "direction"    # tracked long but broker short (or vice versa)
    if abs(allocated) > abs(actual):
        return "over"         # tracking more qty than the broker actually holds
    return "under"            # broker holds more than is tracked


def _num0(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _order_fill_status(broker: str, order_id: str, books: dict) -> dict:
    """Look up a placed order in the broker's order book (fetched once per cycle into `books`).
    Returns {"state": "filled"|"pending"|"rejected"|"unknown", "filled_qty": int, "avg_price": float}.
    Parsed defensively — broker order-book field names/status strings vary."""
    rows = books.get(broker) or []
    for o in rows:
        oid = str(o.get("norenordno") or o.get("order_id") or o.get("id") or "")
        if oid != str(order_id):
            continue
        status = str(o.get("status") or "").upper()
        if broker == "shoonya":
            filled = int(_num0(o.get("fillshares")))
            avg = _num0(o.get("avgprc"))
            if status == "COMPLETE":
                return {"state": "filled", "filled_qty": filled, "avg_price": avg}
            if status in ("REJECTED", "CANCELED", "CANCELLED"):
                return {"state": "rejected", "filled_qty": filled, "avg_price": avg}
            return {"state": "pending", "filled_qty": filled, "avg_price": avg}
        if broker == "zerodha":
            filled = int(_num0(o.get("filled_quantity")))
            avg = _num0(o.get("average_price"))
            if status == "COMPLETE":
                return {"state": "filled", "filled_qty": filled, "avg_price": avg}
            if status in ("REJECTED", "CANCELLED"):
                return {"state": "rejected", "filled_qty": filled, "avg_price": avg}
            return {"state": "pending", "filled_qty": filled, "avg_price": avg}
        # fyers: status 2 = filled/traded, 5 = rejected, 1 = cancelled; else pending
        filled = int(_num0(o.get("filledQty")))
        avg = _num0(o.get("tradedPrice") or o.get("limitPrice"))
        st = o.get("status")
        if st == 2 or (filled and filled >= int(_num0(o.get("qty")))):
            return {"state": "filled", "filled_qty": filled, "avg_price": avg}
        if st in (1, 5):
            return {"state": "rejected", "filled_qty": filled, "avg_price": avg}
        return {"state": "pending", "filled_qty": filled, "avg_price": avg}
    return {"state": "unknown", "filled_qty": 0, "avg_price": 0}


def _fetch_order_books(brokers: set) -> dict:
    books = {}
    for b in brokers:
        try:
            if b == "zerodha":
                books[b] = zclient.get_order_book() or []
            elif b == "shoonya":
                books[b] = sclient.get_order_book() or []
            else:
                resp = client.get_order_book()
                books[b] = (resp.get("orderBook", []) if isinstance(resp, dict) else resp) or []
        except Exception:
            books[b] = []
    return books


def _resolve_pending_orders() -> None:
    """For every PENDING strategy order that carries a broker order id, check the broker's order
    book: once FILLED, mark it FILLED at the real fill qty/price (it then merges into the net
    position); if rejected/cancelled, mark it CANCELLED (kept for audit + surfaced as an alert,
    but no longer counts toward any position). Runs each /strategy/list poll."""
    pending = [p for p in db.list_orders(statuses=("PENDING",)) if p.get("order_id")]
    if not pending:
        return
    books = _fetch_order_books({p["broker"] for p in pending})
    for p in pending:
        st = _order_fill_status(p["broker"], p["order_id"], books)
        if st["state"] == "filled":
            db.mark_order_filled(p["id"], st["filled_qty"] or p["qty"], st["avg_price"] or p["price"])
        elif st["state"] == "rejected":
            db.update_order(p["id"], status="CANCELLED")
        # pending / unknown: leave it to be checked again next cycle


def _reconciliation_map(pnl_map: dict) -> dict[tuple, dict]:
    """(broker, symbol) -> {allocated, actual, status}. Uses the already-fetched broker positions
    (pnl_map) and the open-strategy allocation tally — no extra broker calls."""
    allocated_net = db.get_allocated_signed_qty()
    broker_net = {k: v.get("netQty", 0) for k, v in pnl_map.items()}
    recon = {}
    for key in set(allocated_net) | set(broker_net):
        a = allocated_net.get(key, 0)
        act = broker_net.get(key, 0)
        recon[key] = {"allocated": a, "actual": act, "status": _classify_recon(a, act)}
    return recon


def _merge_orders_to_legs(orders: list[dict]) -> tuple[list[dict], float]:
    """Merge a strategy's FILLED orders into one leg per symbol (money-pot netting). Returns
    (legs, realized_total). Each leg is the net OPEN side/qty at the residual-side average, plus
    the realized P&L booked from the offsetting (closed) quantity via average-netting:
        realized = (avg_sell - avg_buy) * min(buy_qty, sell_qty)."""
    agg: dict[str, dict] = {}
    for o in orders:
        if o["status"] != "FILLED":
            continue
        a = agg.get(o["symbol"])
        if a is None:
            a = agg[o["symbol"]] = {"broker": o["broker"], "symbol": o["symbol"],
                                    "buy_qty": 0, "buy_val": 0.0, "sell_qty": 0, "sell_val": 0.0, "dates": []}
        px = o["price"] or 0
        if o["side"] == "BUY":
            a["buy_qty"] += o["qty"]; a["buy_val"] += o["qty"] * px
        else:
            a["sell_qty"] += o["qty"]; a["sell_val"] += o["qty"] * px
        a["dates"].append((o.get("filled_at") or o.get("created_at") or "")[:10])
    legs, realized_total = [], 0.0
    for a in agg.values():
        bq, sq = a["buy_qty"], a["sell_qty"]
        avg_b = a["buy_val"] / bq if bq else 0.0
        avg_s = a["sell_val"] / sq if sq else 0.0
        realized = (avg_s - avg_b) * min(bq, sq)
        realized_total += realized
        net = bq - sq
        if net > 0:
            side, qty, entry = "BUY", net, avg_b
        elif net < 0:
            side, qty, entry = "SELL", -net, avg_s
        else:
            side, qty, entry = "FLAT", 0, None
        legs.append({
            "broker": a["broker"], "symbol": a["symbol"], "side": side, "qty": qty,
            "entry": round(entry, 2) if entry else None, "realized": round(realized, 2),
            "buy_qty": bq, "sell_qty": sq,
            "avg_buy": round(avg_b, 2) if bq else None, "avg_sell": round(avg_s, 2) if sq else None,
            "created_at": min([d for d in a["dates"] if d]) if a["dates"] else None,
        })
    return legs, round(realized_total, 2)


def compute_strategies() -> list[dict]:
    """Full open+closed strategy list with live P&L/margin/ROI, built from the order ledger.
    A strategy is a money pot: each symbol's net OPEN position + realized P&L come from the
    strategy's own FILLED orders — the broker's live position is never consulted. Shared by the
    /list route and the background P&L snapshot job."""
    _resolve_pending_orders()  # fill/cancel any pending orders per the broker order book

    all_orders = db.list_orders()
    orders_by_strategy: dict[int, list] = {}
    for o in all_orders:
        orders_by_strategy.setdefault(o["strategy_id"], []).append(o)

    strategies = []
    for s in db.list_strategies():  # metadata (id/name/status/notes); ignore its old 'legs'
        orders = orders_by_strategy.get(s["id"], [])
        legs, realized_total = _merge_orders_to_legs(orders)
        pending = [o for o in orders if o["status"] == "PENDING"]
        # Keep strategies that hold (or await) at least one F&O instrument.
        if not (any(_is_fno_symbol(l["symbol"]) for l in legs) or any(_is_fno_symbol(p["symbol"]) for p in pending)):
            continue
        s = {**s, "legs": legs, "realized_total": realized_total, "pending_orders": pending}
        strategies.append(s)

    all_symbols = sorted({_leg_fyers_symbol(leg) for s in strategies for leg in s["legs"] if _is_fno_symbol(leg["symbol"])})
    quote_map = _fetch_bid_ask(all_symbols)
    ltp_map = _fetch_ltp(all_symbols)  # fallback for live P&L when a leg has no live bid/ask

    # Underlying spot per strategy (from its first F&O leg's root) — powers moneyness/greeks and
    # the spot readout on each strategy card. Batched into one quote call.
    strat_underlying = {}
    for s in strategies:
        fno = [leg for leg in s["legs"] if _is_fno_symbol(leg["symbol"])] or \
              [p for p in s["pending_orders"] if _is_fno_symbol(p["symbol"])]
        if fno:
            root = _leg_root(fno[0]["symbol"])
            strat_underlying[s["id"]] = (root, _underlying_symbol(root))
    spot_map = _fetch_ltp(sorted({v[1] for v in strat_underlying.values()}))

    # Keep every open-strategy leg + underlying streaming on the Fyers WebSocket so the NEXT poll
    # (and auto-exit's tick-by-tick checks) reads ~0.2s-fresh prices straight from the cache instead
    # of a ~270ms REST round-trip. Idempotent — only newly-seen symbols actually hit the socket.
    try:
        import fyers_ws
        fyers_ws.subscribe(all_symbols + sorted({v[1] for v in strat_underlying.values() if v[1]}))
    except Exception:
        pass

    # Margin/expiry per strategy each cost a real Zerodha network round-trip on a cache miss.
    # A small worker pool is used mainly to overlap connection-setup latency across strategies —
    # measured, higher concurrency (8) gave no further speedup (Zerodha's margin endpoint/the
    # proxy appears to serialize concurrent calls) and risks tripping Kite's strict rate limit
    # on order-related endpoints (~3 req/sec), so this stays modest. The real fix for repeat
    # polls is _strategy_margin_and_expiry's own cache (_MARGIN_CACHE_TTL) — most polls hit it
    # and skip the network entirely.
    # Margin is on the net OPEN positions only (qty > 0); fully-closed (FLAT) legs carry no risk.
    with ThreadPoolExecutor(max_workers=3) as pool:
        margin_expiry_results = list(pool.map(
            lambda s: _strategy_margin_and_expiry([l for l in s["legs"] if l["qty"] > 0]), strategies))
    margin_expiry_by_id = {s["id"]: me for s, me in zip(strategies, margin_expiry_results)}

    result = []
    for s in strategies:
        total_pl = 0.0
        entry_pl = 0.0
        live_capture_pl = 0.0
        have_entry_price = False
        have_live_prices = False
        entry_dates = []
        # Every symbol's realized P&L is in the pot regardless of whether it still has an open leg.
        total_pl += s["realized_total"]
        for leg in s["legs"]:
            fysym = _leg_fyers_symbol(leg)
            quote = quote_map.get(fysym, {})
            bid, ask = quote.get("bid"), quote.get("ask")
            ltp = ltp_map.get(fysym)
            leg["bid"], leg["ask"], leg["ltp"] = bid, ask, ltp
            oq = leg["qty"]                       # net OPEN qty (0 for a fully-closed symbol)
            leg["open_qty"] = oq
            leg["lot_size"] = symbol_master.get_lot_size(fysym)
            entry_price = leg.get("entry")

            # Exit-realistic live P&L on the OPEN portion: a long exits at the bid, a short covers
            # at the ask; fall back to LTP when a side has no live quote.
            leg_pl = 0.0
            if oq > 0 and entry_price:
                exit_price = (bid if leg["side"] == "BUY" else ask)
                if exit_price is None:
                    exit_price = ltp
                if exit_price is not None:
                    leg_pl = (exit_price - entry_price) * oq if leg["side"] == "BUY" else (entry_price - exit_price) * oq
            leg["pl"] = round(leg_pl, 2)
            total_pl += leg_pl

            # Live-capture P&L: the premium still on the table if the position is held AS-IS to
            # expiry and every option settles at 0, priced off the CURRENT market at CLOSE-OUT marks
            # — each leg valued at the price you'd actually transact to unwind it: a short at the
            # ASK (what it costs to buy back), a long at the BID (what you'd sell it for). Answers
            # "what forward return is left from here, valuing my legs at realistic exit prices?".
            is_fut = _is_future_symbol(leg["symbol"])
            leg["kind"] = "future" if is_fut else "option"

            if oq <= 0:
                continue  # fully-closed symbol: realized already counted, no open capture
            if is_fut:
                # Futures have no premium-decay — a future leg contributes its live mark-to-market
                # P&L to BOTH the Entry and Live figures; the option legs keep their premium-decay
                # ROI and the future's directional P&L is added on top.
                have_live_prices = True
                have_entry_price = True
                live_capture_pl += leg_pl
                entry_pl += leg_pl
                if leg.get("created_at"):
                    entry_dates.append(leg["created_at"][:10])
            else:
                capture_price = ask if leg["side"] == "SELL" else bid
                if capture_price is None:
                    capture_price = ltp
                if capture_price is not None:
                    have_live_prices = True
                    premium_now = capture_price * oq
                    live_capture_pl += premium_now if leg["side"] == "SELL" else -premium_now
                if entry_price:
                    have_entry_price = True
                    premium = entry_price * oq
                    # Best-case decay-to-0 P&L: a seller keeps the premium, a buyer loses it.
                    entry_pl += premium if leg["side"] == "SELL" else -premium
                    if leg.get("created_at"):
                        entry_dates.append(leg["created_at"][:10])

        # ROI is FORWARD-CAPTURE ONLY: the return still on the table from the OPEN position if held
        # to expiry (all options decaying to 0). Realized P&L already banked from closed legs is
        # DELIBERATELY EXCLUDED from ROI — it's yours whether you hold, roll, or exit, so it must not
        # pad the forward return that drives the card's Live/Entry ROI, the roll floor, and auto-exit
        # arming (all read roi_pct). Realized still counts fully in total_pl (the money-pot P&L, line
        # above) and hence in payoff/breakeven. A fully-closed strategy has no forward capture, so it
        # correctly shows no ROI (roi_pct None) rather than an ROI conjured from banked profit.

        s["total_pl"] = round(total_pl, 2)
        s["pending_orders"] = s.get("pending_orders", [])  # orders placed but not yet filled (PENDING tag)
        us = strat_underlying.get(s["id"])
        s["underlying"] = us[0] if us else None
        s["underlying_symbol"] = us[1] if us else None  # Fyers underlying, for the add-leg chain
        # Upcoming financial-results/earnings for this underlying within a week — surfaced as a
        # highlight on the card so an event-risk (e.g. results tomorrow) isn't missed on an open position.
        s["earnings_event"] = event_calendar.earnings_within(us[0], days=7) if us else None
        s["broker"] = (s["legs"][0].get("broker") if s["legs"] else
                       (s["pending_orders"][0].get("broker") if s["pending_orders"] else None)) or "fyers"
        s["spot"] = spot_map.get(us[1]) if us else None
        margin, expiry = margin_expiry_by_id.get(s["id"], (None, None))
        s["margin"] = margin
        s["expiry"] = expiry
        s["auto_exit"] = db.get_auto_exit(s["id"])

        # ROI convention across the app is annualized (p.a.) — the scanners label their targets
        # "p.a." — so both ROIs annualize over the same holding period and share the margin
        # denominator, keeping Live vs Entry directly comparable:
        #   Live ROI  — forward return if held AS-IS to expiry and all options settle at 0,
        #               priced off the CURRENT market (live_capture_pl). This is what you can
        #               still earn from here, NOT the mark-to-market P&L (that's total_pl, shown
        #               separately at the top of each strategy).
        #   Entry ROI — the same best-case decay-to-0 return, but locked in at ENTRY prices.
        # Holding period = earliest recorded entry date -> expiry, INCLUSIVE and floored at 1
        # day, so a same-day/expiry-day (0DTE) trade doesn't collapse the annualization.
        hold_days = None
        if expiry:
            ref_date = min(entry_dates) if entry_dates else date.today().isoformat()
            try:
                hold_days = max((date.fromisoformat(expiry) - date.fromisoformat(ref_date)).days + 1, 1)
            except ValueError:
                hold_days = None

        def _annualized_roi(pl: float) -> float | None:
            if not margin:
                return None
            roi = pl / margin * 100
            return round(roi * (365 / hold_days), 2) if hold_days else round(roi, 2)

        s["roi_pct"] = _annualized_roi(live_capture_pl) if have_live_prices else None
        s["entry_roi_pct"] = _annualized_roi(entry_pl) if have_entry_price else None
        result.append(s)
    return result


@router.get("/list")
def list_strategies():
    return compute_strategies()


def _place_leg_order(broker: str, stored_symbol: str, side: str, qty: int, price: float,
                     is_limit: bool = True) -> tuple[bool, str | None, str | None]:
    """Place one order for a strategy leg on its own broker. `stored_symbol` is in the format the
    allocation stores (bare tradingsymbol for Zerodha; Fyers-format for Fyers/Shoonya). Returns
    (ok, order_id, error). Shared by exit-leg and add-leg."""
    if broker == "zerodha":
        order_id = zclient.place_order(
            variety="regular", exchange="NFO", tradingsymbol=stored_symbol,
            transaction_type=side, quantity=qty, product="NRML",
            order_type="LIMIT" if is_limit else "MARKET", price=price if is_limit else None,
        )
        return True, order_id, None
    if broker == "shoonya":
        contract = shoonya_symbols.fyers_to_shoonya(stored_symbol)
        result = sclient.place_order(
            exchange=contract["exch"], tradingsymbol=contract["tsym"],
            transaction_type="B" if side == "BUY" else "S", quantity=qty,
            price_type="LMT" if is_limit else "MKT", product="M", price=price if is_limit else 0,
        )
        ok = result.get("stat") == "Ok"
        return ok, result.get("norenordno"), None if ok else result.get("emsg", str(result))
    # fyers
    result = client.place_order(
        symbol=stored_symbol, qty=qty, side=1 if side == "BUY" else -1,
        order_type=1 if is_limit else 2, product_type="MARGIN", limit_price=price if is_limit else 0,
    )
    ok = bool(result and result.get("s") == "ok")
    return ok, (result.get("id") if result else None), None if ok else str(result)


class ExitLegRequest(BaseModel):
    allocation_id: int
    qty: int          # units to exit (frontend converts lots -> qty via the leg's lot size)
    price: float      # limit price (the level clicked in the depth ladder)


@router.post("/exit-leg")
def exit_leg(req: ExitLegRequest):
    """Places a LIMIT order to exit part/all of one leg — opposite side, same broker, at the
    clicked price. Real money; the frontend gates it behind a confirm. Does NOT book realized
    P&L here — that's done via /book-realized once the exit actually fills (single-use confirm)."""
    _guard_writable()
    alloc = db.get_allocation(req.allocation_id)
    if not alloc:
        raise HTTPException(404, "Leg not found")
    broker = alloc.get("broker") or "fyers"
    open_qty = alloc["qty"] - (alloc.get("closed_qty") or 0)
    qty = min(int(req.qty), open_qty)
    if qty <= 0:
        raise HTTPException(400, "Nothing left to exit on this leg")
    exit_side = "SELL" if alloc["side"] == "BUY" else "BUY"
    try:
        ok, order_id, msg = _place_leg_order(broker, alloc["symbol"], exit_side, qty, req.price)
    except Exception as e:
        raise HTTPException(400, f"Exit order failed: {e}")
    if not ok:
        raise HTTPException(400, f"Exit order rejected: {msg}")
    return {"order_id": order_id, "side": exit_side, "qty": qty, "price": req.price}


class BookRealizedRequest(BaseModel):
    allocation_id: int
    closed_qty: int
    realized_pl: float


@router.post("/book-realized")
def book_realized(req: BookRealizedRequest):
    """Books realized P&L for the exited portion of a leg (from either an app exit or a direct
    broker exit) and shrinks the tracked open qty, so the strategy total P&L / reconciliation
    reflect what's actually still running."""
    _guard_writable()
    alloc = db.get_allocation(req.allocation_id)
    if not alloc:
        raise HTTPException(404, "Leg not found")
    if req.closed_qty <= 0:
        raise HTTPException(400, "closed_qty must be positive")
    db.book_leg_realized(req.allocation_id, req.closed_qty, req.realized_pl)
    return db.get_allocation(req.allocation_id)


class AddLegRequest(BaseModel):
    strategy_id: int
    symbol: str       # Fyers-format symbol chosen from the option chain
    side: str         # BUY or SELL
    qty: int
    price: float
    broker: str = "fyers"


@router.post("/add-leg")
def add_leg(req: AddLegRequest):
    """Places a LIMIT order for a new leg and records it as a PENDING order on the strategy — it
    is NOT counted as a real leg until the order actually fills (a resting limit order that never
    fills would otherwise show as a phantom position mismatch). Once filled, the next
    /strategy/list poll auto-adds it as a tracked leg at the real fill qty/price. Real money;
    frontend confirms first."""
    _guard_writable()
    if not db.get_strategy(req.strategy_id):
        raise HTTPException(404, "Strategy not found")
    if req.side not in ("BUY", "SELL"):
        raise HTTPException(400, "side must be BUY or SELL")
    # Zerodha allocations store the bare tradingsymbol; Fyers/Shoonya store the Fyers symbol.
    stored_symbol = req.symbol.split(":")[-1] if req.broker == "zerodha" else req.symbol
    try:
        ok, order_id, msg = _place_leg_order(req.broker, stored_symbol, req.side, req.qty, req.price)
    except Exception as e:
        raise HTTPException(400, f"Order failed: {e}")
    if not ok:
        raise HTTPException(400, f"Order rejected: {msg}")
    # Record as a PENDING order on the strategy. On fill it merges into the net position (an
    # opposite-side order nets down / books realized automatically). This one path serves both
    # opening a new leg and exiting an existing one — an exit is just the offsetting order.
    row_id = db.add_order(req.strategy_id, req.broker, stored_symbol, req.side, req.qty, req.price,
                          order_id=str(order_id), status="PENDING", source="builder")
    return {"order_id": order_id, "order_row_id": row_id, "pending": True}


class ModifyOrderRequest(BaseModel):
    price: float


@router.post("/order/{order_row_id}/modify")
def modify_order(order_row_id: int, req: ModifyOrderRequest):
    """Re-price a still-PENDING strategy order at the broker (e.g. to chase a resting exit that
    isn't filling). Updates the broker order and the ledger's recorded price. Real money."""
    _guard_writable()
    o = db.get_order(order_row_id)
    if not o:
        raise HTTPException(404, "Order not found")
    if o["status"] != "PENDING":
        raise HTTPException(400, "Only pending orders can be modified")
    if not o.get("order_id"):
        raise HTTPException(400, "Order has no broker id to modify")
    broker, oid, price = o["broker"], o["order_id"], round(float(req.price), 2)
    if price <= 0:
        raise HTTPException(400, "Price must be positive")
    try:
        if broker == "zerodha":
            zclient.modify_order(variety="regular", order_id=oid, price=price, order_type="LIMIT")
        elif broker == "shoonya":
            contract = shoonya_symbols.fyers_to_shoonya(o["symbol"])
            r = sclient.modify_order(order_no=oid, exchange=contract["exch"], tradingsymbol=contract["tsym"],
                                     quantity=o["qty"], price=price, price_type="LMT")
            if isinstance(r, dict) and r.get("stat") not in ("Ok", None):
                raise RuntimeError(r.get("emsg") or str(r))
        else:
            client.modify_order(oid, limitPrice=price, type=1)
    except Exception as e:
        raise HTTPException(502, f"Broker rejected the modify: {e}")
    db.update_order(order_row_id, price=price)
    return {"modified": True, "price": price}


@router.post("/order/{order_row_id}/cancel")
def cancel_order(order_row_id: int):
    """Cancels a still-PENDING strategy order at the broker and marks it CANCELLED (kept for audit;
    drops out of the position math). Filled orders are permanent positions and can't be cancelled
    here — remove them via DELETE /order/{id} if entered by mistake."""
    _guard_writable()
    o = db.get_order(order_row_id)
    if not o:
        raise HTTPException(404, "Order not found")
    if o["status"] != "PENDING":
        raise HTTPException(400, "Only pending orders can be cancelled")
    broker, oid = o["broker"], o["order_id"]
    try:
        if oid:
            if broker == "zerodha":
                zclient.cancel_order(variety="regular", order_id=oid)
            elif broker == "shoonya":
                sclient.cancel_order(oid)
            else:
                client.cancel_order(oid)
    except Exception:
        pass  # order may already be filled/gone — mark cancelled regardless
    db.update_order(order_row_id, status="CANCELLED")
    return {"cancelled": True}


# ---- Order-level intake: manual entry, detected-order assignment, edit/delete ---------------

# ---- Roll: exit a failing strategy and redeploy its margin into a better-ROI one ------------

@router.get("/roll-expiries")
def roll_expiries(target: str):
    """Selectable expiries for a target script (for the roll setup dropdown)."""
    import roll_engine
    return roll_engine.list_roll_expiries(target)


class RollScanRequest(BaseModel):
    target: str                          # Fyers-format underlying to roll INTO (e.g. NSE:RELIANCE-EQ)
    expiry_ts: int                       # chosen expiry (unix ts, from /roll-expiries)
    safe_ce_level: float | None = None   # OPTIONAL price level considered safe on the CE side
    safe_pe_level: float | None = None   # OPTIONAL price level considered safe on the PE side
    include_itm: bool = False            # also scan ITM strikes for short strangles (not just OTM/ATM)
    roi_floor_override: float | None = None  # custom target ROI floor instead of the strategy's live ROI
    ignore_margin: bool = False          # drop the margin-budget filter when scanning


@router.post("/{strategy_id}/roll-scan")
def roll_scan(strategy_id: int, req: RollScanRequest):
    """Scan the chosen target script + expiry for replacement candidates: ROI >= the target ROI
    floor (strategy's live ROI by default, or an override), real margin <= its released margin
    (unless ignored). Always scans short strangles; if safe CE/PE levels are given, also adds a
    safe strangle + credit spreads at the nearest strikes. Slow (~1 min)."""
    import roll_engine
    s = next((x for x in compute_strategies() if x["id"] == strategy_id), None)
    if not s or s["status"] != "OPEN":
        raise HTTPException(404, "Open strategy not found")
    try:
        return roll_engine.scan_for_roll(s, req.target, req.expiry_ts,
                                         req.safe_ce_level, req.safe_pe_level, req.include_itm,
                                         req.roi_floor_override, req.ignore_margin)
    except ValueError as e:
        raise HTTPException(400, str(e))


class RollExecuteRequest(BaseModel):
    entry_legs: List[dict]          # [{symbol, side, price, lot_size}]
    lots: int = 1
    broker: str = "shoonya"
    new_name: str
    notes: Optional[str] = None


@router.post("/{strategy_id}/roll-execute")
def roll_execute(strategy_id: int, req: RollExecuteRequest):
    """Start the sequential roll: limit exits at bid/ask -> wait until flat -> place the new
    strategy. REAL MONEY — the frontend confirm is the consent for both phases."""
    _guard_writable()
    import roll_engine
    if req.lots < 1 or not req.entry_legs:
        raise HTTPException(400, "lots must be >= 1 and entry_legs non-empty")
    s = next((x for x in compute_strategies() if x["id"] == strategy_id), None)
    if not s or s["status"] != "OPEN":
        raise HTTPException(404, "Open strategy not found")
    job_id = roll_engine.start_roll(s, req.entry_legs, req.lots, req.broker,
                                    req.new_name.strip() or f"Roll of {s['name']}", req.notes)
    return {"job_id": job_id}


@router.get("/roll-status/{job_id}")
def roll_status(job_id: str):
    import roll_engine
    j = roll_engine.get_job(job_id)
    if not j:
        raise HTTPException(404, "Roll job not found")
    return j


class ManualOrderRequest(BaseModel):
    strategy_id: Optional[int] = None
    strategy_name: Optional[str] = None      # or create a new strategy
    broker: str = "fyers"
    symbol: str                              # Fyers-format (bare tradingsymbol for zerodha)
    side: str                                # BUY or SELL
    qty: int
    price: float
    order_id: Optional[str] = None           # broker order id if known
    status: str = "FILLED"                   # FILLED (a real past fill) or PENDING


@router.post("/manual-order")
def manual_order(req: ManualOrderRequest):
    """Add an order the dashboard didn't see (e.g. placed yesterday / directly at the broker).
    Once added it is a position in the strategy — its absence from tomorrow's order book does NOT
    mean it was cancelled."""
    _guard_writable()
    if req.side not in ("BUY", "SELL"):
        raise HTTPException(400, "side must be BUY or SELL")
    if req.qty <= 0:
        raise HTTPException(400, "qty must be positive")
    if req.status not in ("FILLED", "PENDING"):
        raise HTTPException(400, "status must be FILLED or PENDING")
    sid = req.strategy_id
    if not sid:
        if not req.strategy_name:
            raise HTTPException(400, "strategy_id or strategy_name is required")
        sid = db.create_strategy(req.strategy_name)
    elif not db.get_strategy(sid):
        raise HTTPException(404, "Strategy not found")
    stored_symbol = req.symbol.split(":")[-1] if req.broker == "zerodha" else req.symbol
    row_id = db.add_order(sid, req.broker, stored_symbol, req.side, req.qty, req.price,
                          order_id=req.order_id, status=req.status, source="manual")
    return {"order_row_id": row_id, "strategy_id": sid}


class AssignOrderRequest(BaseModel):
    strategy_id: Optional[int] = None
    strategy_name: Optional[str] = None
    broker: str
    symbol: str
    side: str
    qty: int
    price: float
    order_id: str


@router.post("/assign-order")
def assign_order(req: AssignOrderRequest):
    """File a broker-detected order (from the unassigned-orders inbox) into a strategy."""
    _guard_writable()
    sid = req.strategy_id
    if not sid:
        if not req.strategy_name:
            raise HTTPException(400, "strategy_id or strategy_name is required")
        sid = db.create_strategy(req.strategy_name)
    elif not db.get_strategy(sid):
        raise HTTPException(404, "Strategy not found")
    stored_symbol = req.symbol.split(":")[-1] if req.broker == "zerodha" else req.symbol
    row_id = db.add_order(sid, req.broker, stored_symbol, req.side, req.qty, req.price,
                          order_id=req.order_id, status="FILLED", source="detected")
    return {"order_row_id": row_id, "strategy_id": sid}


class UpdateOrderRequest(BaseModel):
    strategy_id: Optional[int] = None
    side: Optional[str] = None
    qty: Optional[int] = None
    price: Optional[float] = None


@router.patch("/order/{order_row_id}")
def update_order(order_row_id: int, req: UpdateOrderRequest):
    _guard_writable()
    if not db.get_order(order_row_id):
        raise HTTPException(404, "Order not found")
    db.update_order(order_row_id, strategy_id=req.strategy_id, side=req.side, qty=req.qty, price=req.price)
    return db.get_order(order_row_id)


@router.delete("/order/{order_row_id}")
def delete_order(order_row_id: int):
    _guard_writable()
    if not db.get_order(order_row_id):
        raise HTTPException(404, "Order not found")
    db.delete_order(order_row_id)
    return {"deleted": True}


class WhatIfMarginRequest(BaseModel):
    legs: list[dict]   # [{symbol (Fyers), side "BUY"/"SELL", qty}]


@router.post("/whatif-margin")
def whatif_margin(req: WhatIfMarginRequest):
    """Real (Zerodha basket) margin for a hypothetical set of legs — powers the what-if payoff's
    'Possible ROI' before any order is placed. Reuses the roll engine's basket-margin helper."""
    import roll_engine
    legs = [{"tradingsymbol": roll_engine._bare(l["symbol"]), "side": l["side"], "qty": int(l["qty"])}
            for l in req.legs if l.get("symbol") and l.get("qty")]
    if not legs:
        return {"margin": None}
    return {"margin": roll_engine._basket_margin(legs)}


class MoveLegRequest(BaseModel):
    symbol: str                        # the leg's symbol (Fyers format, as stored)
    to_strategy_id: int                # destination strategy


@router.post("/{strategy_id}/move-leg")
def move_leg(strategy_id: int, req: MoveLegRequest):
    """Shift a whole leg (every order for one symbol) from this strategy into another — for merging
    strategies. The leg carries its entry price, realized P&L (from netting), timestamps and any
    pending orders, because a leg IS its orders and we just re-point them. The destination auto-nets
    if it already holds the same symbol."""
    _guard_writable()
    src = db.get_strategy(strategy_id)
    dst = db.get_strategy(req.to_strategy_id)
    if not src or not dst:
        raise HTTPException(404, "Source or destination strategy not found")
    if strategy_id == req.to_strategy_id:
        raise HTTPException(400, "Source and destination are the same strategy")
    moved = db.move_leg_orders(strategy_id, req.symbol, req.to_strategy_id)
    if moved == 0:
        raise HTTPException(404, "No orders for that symbol in this strategy")
    return {"moved": moved, "from": strategy_id, "to": req.to_strategy_id, "symbol": req.symbol}


class MergeRequest(BaseModel):
    into_strategy_id: int


@router.post("/{strategy_id}/merge-into")
def merge_into(strategy_id: int, req: MergeRequest):
    """Merge this ENTIRE strategy into another — move all its orders across. The emptied source is
    left in place (archive/close it separately if you want it gone)."""
    _guard_writable()
    src = db.get_strategy(strategy_id)
    dst = db.get_strategy(req.into_strategy_id)
    if not src or not dst:
        raise HTTPException(404, "Source or destination strategy not found")
    if strategy_id == req.into_strategy_id:
        raise HTTPException(400, "Source and destination are the same strategy")
    moved = db.move_all_orders(strategy_id, req.into_strategy_id)
    return {"moved": moved, "from": strategy_id, "into": req.into_strategy_id}


@router.get("/{strategy_id}/pnl-history")
def pnl_history(strategy_id: int):
    if not db.get_strategy(strategy_id):
        raise HTTPException(404, "Strategy not found")
    return db.get_pnl_snapshots(strategy_id)


class NotesRequest(BaseModel):
    notes: str


@router.patch("/{strategy_id}/notes")
def set_notes(strategy_id: int, req: NotesRequest):
    _guard_writable()
    if not db.get_strategy(strategy_id):
        raise HTTPException(404, "Strategy not found")
    db.set_notes(strategy_id, req.notes)
    return db.get_strategy(strategy_id)


@router.post("/{strategy_id}/square-off")
def square_off(strategy_id: int):
    """Places a closing MARKET order for every leg (opposite side, same qty, on the leg's own
    broker), then marks the strategy CLOSED. This transacts REAL money — the frontend gates it
    behind an explicit confirm step. Partial failures are reported per-leg and the strategy is
    only marked CLOSED if every close order was accepted."""
    _guard_writable()
    strategy = db.get_strategy(strategy_id)
    if not strategy:
        raise HTTPException(404, "Strategy not found")
    if strategy["status"] != "OPEN":
        raise HTTPException(400, "Strategy is not open")

    # Close the NET open positions (merged from the order ledger), not raw orders.
    legs = [l for l in _merge_orders_to_legs(db.list_orders(strategy_id))[0] if l["qty"] > 0]
    leg_results = []
    all_ok = True
    for leg in legs:
        close_side = "SELL" if leg["side"] == "BUY" else "BUY"
        broker = leg.get("broker") or "fyers"
        try:
            if broker == "zerodha":
                order_id = zclient.place_order(
                    variety="regular", exchange="NFO", tradingsymbol=leg["symbol"],
                    transaction_type=close_side, quantity=leg["qty"], product="NRML",
                    order_type="MARKET",
                )
                leg_results.append({"symbol": leg["symbol"], "side": close_side, "ok": True, "order_id": order_id})
            elif broker == "shoonya":
                # Shoonya legs are stored in Fyers format — convert to the Shoonya contract to
                # place the closing MARKET order.
                contract = shoonya_symbols.fyers_to_shoonya(leg["symbol"])
                result = sclient.place_order(
                    exchange=contract["exch"], tradingsymbol=contract["tsym"],
                    transaction_type="B" if close_side == "BUY" else "S",
                    quantity=leg["qty"], price_type="MKT", product="M",
                )
                ok = result.get("stat") == "Ok"
                all_ok = all_ok and ok
                leg_results.append({"symbol": leg["symbol"], "side": close_side, "ok": ok,
                                    "order_id": result.get("norenordno"),
                                    "message": None if ok else result.get("emsg", str(result))})
            else:
                result = client.place_order(
                    symbol=leg["symbol"], qty=leg["qty"],
                    side=1 if close_side == "BUY" else -1,
                    order_type=2, product_type="MARGIN",
                )
                ok = bool(result and result.get("s") == "ok")
                all_ok = all_ok and ok
                leg_results.append({"symbol": leg["symbol"], "side": close_side, "ok": ok,
                                    "order_id": result.get("id") if result else None,
                                    "message": None if ok else str(result)})
        except Exception as e:
            all_ok = False
            leg_results.append({"symbol": leg["symbol"], "side": close_side, "ok": False, "message": str(e)})

    # Record each closing order on the strategy so its fill nets the leg to flat (and it doesn't
    # resurface in the unassigned-orders inbox). Matched to legs by symbol.
    by_symbol = {lr["symbol"]: lr for lr in leg_results if lr.get("ok") and lr.get("order_id")}
    for leg in legs:
        lr = by_symbol.get(leg["symbol"])
        if lr:
            close_side = "SELL" if leg["side"] == "BUY" else "BUY"
            db.add_order(strategy_id, leg["broker"], leg["symbol"], close_side, leg["qty"], None,
                         order_id=str(lr["order_id"]), status="PENDING", source="builder")
    if all_ok:
        db.close_strategy(strategy_id)
    return {"closed": all_ok, "legs": leg_results}


# ---- Auto-exit: place LIMIT exit orders at the live bid/ask when a target ROI is hit ---------

def _place_leg_exit_limit(leg: dict, limit_price: float) -> dict:
    """Place a single closing LIMIT order for one open leg at `limit_price` (the current bid for a
    long being sold, or ask for a short being bought), on the leg's own broker. Records the order
    on the strategy as PENDING so its fill nets the leg. Returns a per-leg result dict."""
    close_side = "SELL" if leg["side"] == "BUY" else "BUY"
    broker = leg.get("broker") or "fyers"
    price = round(float(limit_price), 2)
    res = {"symbol": leg["symbol"], "side": close_side, "qty": leg["qty"], "price": price, "ok": False}
    try:
        if broker == "zerodha":
            oid = zclient.place_order(
                variety="regular", exchange="NFO", tradingsymbol=leg["symbol"],
                transaction_type=close_side, quantity=leg["qty"], product="NRML",
                order_type="LIMIT", price=price,
            )
            res.update(ok=True, order_id=str(oid))
        elif broker == "shoonya":
            contract = shoonya_symbols.fyers_to_shoonya(leg["symbol"])
            result = sclient.place_order(
                exchange=contract["exch"], tradingsymbol=contract["tsym"],
                transaction_type="B" if close_side == "BUY" else "S",
                quantity=leg["qty"], price_type="LMT", product="M", price=price,
            )
            ok = result.get("stat") == "Ok"
            res.update(ok=ok, order_id=result.get("norenordno"),
                       message=None if ok else result.get("emsg", str(result)))
        else:
            result = client.place_order(
                symbol=leg["symbol"], qty=leg["qty"],
                side=1 if close_side == "BUY" else -1,
                order_type=1, product_type="MARGIN", limit_price=price,
            )
            ok = bool(result and result.get("s") == "ok")
            res.update(ok=ok, order_id=result.get("id") if result else None,
                       message=None if ok else str(result))
    except Exception as e:
        res.update(ok=False, message=str(e))
    if res.get("ok") and res.get("order_id"):
        db.add_order(leg["strategy_id"] if leg.get("strategy_id") else leg["_sid"], broker,
                     leg["symbol"], close_side, leg["qty"], price,
                     order_id=str(res["order_id"]), status="PENDING", source="builder")
    return res


def execute_auto_exit(strategy: dict) -> dict:
    """Places closing LIMIT orders for every OPEN leg of `strategy` at the leg's current exit quote
    (long -> sell at bid, short -> buy at ask; falls back to LTP if a side has no quote). Orders are
    left RESTING — the strategy is NOT force-closed here; the pending orders net the legs on fill.
    Called by the auto_exit_watcher when the target ROI is reached. Transacts REAL money."""
    _guard_writable()
    sid = strategy["id"]
    pending = strategy.get("pending_orders", [])
    legs = [l for l in strategy["legs"] if l["qty"] > 0]
    results = []
    for leg in legs:
        leg["_sid"] = sid
        close_side = "SELL" if leg["side"] == "BUY" else "BUY"
        # Skip a leg that already has a resting closing order — so a RETRY (after a partial failure)
        # only places the still-un-exited legs and never double-sells the one that already went in.
        if any(p.get("symbol") == leg["symbol"] and p.get("side") == close_side for p in pending):
            results.append({"symbol": leg["symbol"], "ok": True, "skipped": "already exiting"})
            continue
        limit_price = leg.get("bid") if leg["side"] == "BUY" else leg.get("ask")
        if limit_price is None:
            limit_price = leg.get("ltp")
        if limit_price is None:
            results.append({"symbol": leg["symbol"], "ok": False, "message": "no quote for limit price"})
            continue
        results.append(_place_leg_exit_limit(leg, limit_price))
    return {"legs": results}


class AutoExitRequest(BaseModel):
    trigger_type: str = "roi"                 # 'roi' | 'spot'
    target_roi_pct: float | None = None       # for 'roi'
    target_spot: float | None = None          # for 'spot' — underlying LTP level
    spot_dir: str | None = None               # for 'spot' — 'above' | 'below'


@router.post("/{strategy_id}/auto-exit")
def arm_auto_exit(strategy_id: int, req: AutoExitRequest):
    """Arm auto-exit. 'roi': when live ROI decays to <= target_roi_pct, place limit exit orders at
    bid/ask (profit-taking on short premium). 'spot': when the UNDERLYING's LTP crosses target_spot
    in spot_dir ('above'/'below'), exit at whatever bid/ask is live then — a hard price stop.
    Real-money automation — arming is the explicit consent."""
    _guard_writable()
    s = db.get_strategy(strategy_id)
    if not s:
        raise HTTPException(404, "Strategy not found")
    if s["status"] != "OPEN":
        raise HTTPException(400, "Strategy is not open")
    if req.trigger_type == "spot":
        if not (req.target_spot and req.target_spot > 0) or req.spot_dir not in ("above", "below"):
            raise HTTPException(400, "spot trigger needs target_spot > 0 and spot_dir 'above'/'below'")
        db.arm_auto_exit(strategy_id, "spot", target_spot=req.target_spot, spot_dir=req.spot_dir)
    else:
        if req.target_roi_pct is None:
            raise HTTPException(400, "roi trigger needs target_roi_pct")
        db.arm_auto_exit(strategy_id, "roi", target_roi_pct=req.target_roi_pct)
    return db.get_auto_exit(strategy_id)


@router.delete("/{strategy_id}/auto-exit")
def disarm_auto_exit(strategy_id: int):
    db.disarm_auto_exit(strategy_id)
    return {"disarmed": True}


@router.get("/unassigned-orders")
def get_unassigned_orders():
    """FILLED F&O orders in the brokers' order books that aren't yet filed against any strategy —
    the inbox the user assigns to a strategy. Excludes anything already in the ledger (by
    broker+order_id). `symbol` is Fyers-format; pass it straight to /assign-order."""
    known = db.known_order_ids()
    mig = db.migrated_symbols()   # (broker, stored-symbol) already covered by migrated positions
    books = _fetch_order_books({"fyers", "zerodha", "shoonya"})
    out = []

    for o in books.get("fyers", []):
        if o.get("status") != 2:  # 2 = traded/filled
            continue
        oid = str(o.get("id") or "")
        sym = o.get("symbol", "")
        if not oid or ("fyers", oid) in known or ("fyers", sym) in mig or not _is_fno_symbol(sym):
            continue
        out.append({"broker": "fyers", "order_id": oid, "symbol": sym, "root": _leg_root(sym),
                    "side": "BUY" if o.get("side") == 1 else "SELL",
                    "qty": int(_num0(o.get("filledQty"))), "price": _num0(o.get("tradedPrice"))})

    for o in books.get("zerodha", []):
        if str(o.get("status", "")).upper() != "COMPLETE":
            continue
        oid = str(o.get("order_id") or "")
        tsym = o.get("tradingsymbol", "")
        fy = "NSE:" + tsym
        if not oid or ("zerodha", oid) in known or ("zerodha", tsym) in mig or not _is_fno_symbol(fy):
            continue
        out.append({"broker": "zerodha", "order_id": oid, "symbol": fy, "root": _leg_root(fy),
                    "side": str(o.get("transaction_type", "")).upper(),
                    "qty": int(_num0(o.get("filled_quantity"))), "price": _num0(o.get("average_price"))})

    for o in books.get("shoonya", []):
        if str(o.get("status", "")).upper() != "COMPLETE":
            continue
        oid = str(o.get("norenordno") or "")
        fy = shoonya_symbols.shoonya_to_fyers(o.get("tsym", ""), o.get("exch", ""))
        if not oid or ("shoonya", oid) in known or ("shoonya", fy) in mig or not fy or not _is_fno_symbol(fy):
            continue
        out.append({"broker": "shoonya", "order_id": oid, "symbol": fy, "root": _leg_root(fy),
                    "side": "BUY" if str(o.get("trantype", "")).upper().startswith("B") else "SELL",
                    "qty": int(_num0(o.get("fillshares"))), "price": _num0(o.get("avgprc"))})

    return out


@router.get("/all")
def list_all_strategy_names():
    return [{"id": s["id"], "name": s["name"], "status": s["status"]} for s in db.list_strategies()]


@router.post("/allocate")
def allocate(req: AllocateRequest):
    _guard_writable()
    if req.side not in ("BUY", "SELL"):
        raise HTTPException(400, "side must be 'BUY' or 'SELL'")
    if req.quantity <= 0:
        raise HTTPException(400, "quantity must be positive")

    strategy_id = req.strategy_id
    if not strategy_id:
        if not req.strategy_name:
            raise HTTPException(400, "strategy_id or strategy_name is required")
        strategy_id = db.create_strategy(req.strategy_name)

    strategy = db.get_strategy(strategy_id)
    if not strategy:
        raise HTTPException(404, "Strategy not found")

    db.add_allocation(strategy_id, req.symbol, req.side, req.quantity, broker=req.broker)
    return db.get_strategy(strategy_id)


class UpdateAllocationRequest(BaseModel):
    strategy_id: Optional[int] = None       # move to this existing strategy
    new_strategy_name: Optional[str] = None  # or create+move to a brand new one
    quantity: Optional[int] = None
    side: Optional[str] = None
    avg_price: Optional[float] = None       # entry price, for Entry ROI on legs allocated without one
    created_at: Optional[str] = None        # entry/execution date (YYYY-MM-DD), for annualizing Entry ROI


@router.patch("/allocations/{allocation_id}")
def update_allocation(allocation_id: int, req: UpdateAllocationRequest):
    _guard_writable()
    alloc = db.get_allocation(allocation_id)
    if not alloc:
        raise HTTPException(404, "Allocation not found")
    if req.side and req.side not in ("BUY", "SELL"):
        raise HTTPException(400, "side must be 'BUY' or 'SELL'")
    if req.quantity is not None and req.quantity <= 0:
        raise HTTPException(400, "quantity must be positive")
    if req.avg_price is not None and req.avg_price <= 0:
        raise HTTPException(400, "avg_price must be positive")

    target_strategy_id = req.strategy_id
    if req.new_strategy_name:
        target_strategy_id = db.create_strategy(req.new_strategy_name)
    if target_strategy_id and not db.get_strategy(target_strategy_id):
        raise HTTPException(404, "Target strategy not found")

    db.update_allocation(allocation_id, strategy_id=target_strategy_id, qty=req.quantity, side=req.side,
                          avg_price=req.avg_price, created_at=req.created_at)
    return db.get_allocation(allocation_id)


@router.delete("/allocations/{allocation_id}")
def remove_allocation(allocation_id: int):
    _guard_writable()
    if not db.get_allocation(allocation_id):
        raise HTTPException(404, "Allocation not found")
    db.delete_allocation(allocation_id)
    return {"status": "removed"}


@router.post("/{strategy_id}/close")
def close_strategy(strategy_id: int):
    _guard_writable()
    strategy = db.get_strategy(strategy_id)
    if not strategy:
        raise HTTPException(404, "Strategy not found")
    db.close_strategy(strategy_id)
    return db.get_strategy(strategy_id)
