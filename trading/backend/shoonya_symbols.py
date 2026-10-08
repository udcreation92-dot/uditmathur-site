"""Resolves a Fyers-format symbol (this app's canonical format) to a Shoonya/Noren trading
symbol for order placement, since Shoonya uses a different tsym convention
(e.g. Fyers "NSE:NIFTY2670724000CE" -> Shoonya NFO tsym "NIFTY07JUL26C24000", "NSE:RELIANCE-EQ"
-> "RELIANCE-EQ"). Options are matched by (underlying, expiry date, option type, strike) against
Shoonya's downloadable symbol master, using the Fyers master for the real expiry date — so both
weekly and monthly contracts resolve without hard-coding tsym formatting rules. Cash equity is a
direct passthrough of the bare symbol."""
import io
import re
import time
import zipfile
import datetime

import requests
import pandas as pd

import symbol_master
from shoonya_client import _shoonya_session  # routes through SHOONYA_PROXY_URL if configured

# Shoonya publishes one master per segment; NFO covers index+stock F&O, NSE covers cash equity.
MASTER_URLS = {
    "NFO": "https://api.shoonya.com/NFO_symbols.txt.zip",
    "NSE": "https://api.shoonya.com/NSE_symbols.txt.zip",
}
CACHE_TTL = 24 * 3600

_cache: dict[str, pd.DataFrame] = {}
_cache_ts: dict[str, float] = {}
# (root, expiry_iso, opttype, strike) -> {"exch","tsym","token","lot_size"}
_option_index: dict[tuple, dict] = {}
_tsym_to_key: dict[str, tuple] = {}       # Shoonya tsym -> (root, expiry_iso, opttype, strike)
_fyers_option_index: dict[tuple, str] = {}  # (root, expiry_iso, opttype, strike) -> Fyers symbol
# Futures: keyed by (root, expiry_iso) since there's no strike/type.
_future_index: dict[tuple, dict] = {}
_tsym_to_fut_key: dict[str, tuple] = {}
_fyers_future_index: dict[tuple, str] = {}

# Expiry-encoding group matches: YYMDD weekly with a DIGIT month 1-9 (\d{5}), YY+[OND]+DD weekly
# with a LETTER month for Oct/Nov/Dec (\d{2}[OND]\d{2}), or YYMON monthly (\d{2}[A-Z]{3}).
_OPT_RE = re.compile(r"^([A-Z&-]+?)(\d{5}|\d{2}[OND]\d{2}|\d{2}[A-Z]{3})(\d+(?:\.\d+)?)(CE|PE)$")
# Fyers future body, e.g. "INDIGO26JULFUT" -> root INDIGO.
_FUT_RE = re.compile(r"^([A-Z&-]+?)(\d{2}[A-Z]{3})FUT$")


def _download(seg: str) -> pd.DataFrame:
    resp = _shoonya_session.get(MASTER_URLS[seg], timeout=30)
    resp.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        name = zf.namelist()[0]
        df = pd.read_csv(zf.open(name))
    df.columns = [c.strip() for c in df.columns]
    return df


def _get_master(seg: str) -> pd.DataFrame:
    now = time.time()
    if seg in _cache and now - _cache_ts.get(seg, 0) < CACHE_TTL:
        return _cache[seg]
    df = _download(seg)
    _cache[seg] = df
    _cache_ts[seg] = now
    return df


def _build_option_index():
    """Index NFO options by (root, expiry ISO date, CE/PE, strike) -> Shoonya contract."""
    if _option_index:
        return
    df = _get_master("NFO")
    for r in df.itertuples():
        opt = str(getattr(r, "OptionType", "") or "").upper()
        if opt not in ("CE", "PE"):
            continue
        try:
            expiry = _parse_shoonya_date(str(r.Expiry))
            strike = float(r.StrikePrice)
        except (ValueError, TypeError):
            continue
        key = (str(r.Symbol).upper(), expiry, opt, strike)
        tsym = str(r.TradingSymbol)
        _option_index[key] = {
            "exch": str(r.Exchange), "tsym": tsym,
            "token": str(r.Token), "lot_size": int(r.LotSize) if pd.notna(r.LotSize) else 1,
        }
        _tsym_to_key[tsym] = key


def _build_future_index():
    """Index NFO futures by (root, expiry ISO) -> Shoonya contract (Instrument FUTSTK/FUTIDX)."""
    if _future_index:
        return
    df = _get_master("NFO")
    for r in df.itertuples():
        if not str(getattr(r, "Instrument", "") or "").upper().startswith("FUT"):
            continue
        try:
            expiry = _parse_shoonya_date(str(r.Expiry))
        except (ValueError, TypeError):
            continue
        key = (str(r.Symbol).upper(), expiry)
        tsym = str(r.TradingSymbol)
        _future_index[key] = {
            "exch": str(r.Exchange), "tsym": tsym,
            "token": str(r.Token), "lot_size": int(r.LotSize) if pd.notna(r.LotSize) else 1,
        }
        _tsym_to_fut_key[tsym] = key


def _build_fyers_option_index():
    """(root, expiry ISO, CE/PE, strike) -> Fyers symbol, plus a parallel (root, expiry ISO) ->
    Fyers FUTURE symbol index, for mapping a broker position back to this app's Fyers symbol."""
    if _fyers_option_index or _fyers_future_index:
        return
    df = symbol_master.get_symbol_master()
    for r in df.itertuples():
        sym = str(r.symbol)
        body = sym.split(":")[-1].upper()
        if pd.isna(r.expiry_ts):
            continue
        try:
            expiry = datetime.datetime.fromtimestamp(int(r.expiry_ts)).date().isoformat()
        except (ValueError, TypeError, OSError):
            continue
        mo = _OPT_RE.match(body)
        if mo:
            _fyers_option_index.setdefault((mo.group(1), expiry, mo.group(4), float(mo.group(3))), sym)
            continue
        mf = _FUT_RE.match(body)
        if mf:
            _fyers_future_index.setdefault((mf.group(1), expiry), sym)


# NSE cash-segment instruments carry a "-XX" suffix (equity -EQ, T-bill -TB, govt security -GS,
# sovereign gold bond -GB, state loan -SG, NCD -N1…) and use the SAME trading symbol on Fyers,
# Zerodha and Shoonya — a direct NSE passthrough. F&O tsyms never contain a dash, so this can't
# collide with an option/future.
_NSE_CASH_SUFFIX = re.compile(r"-[A-Z0-9]{1,4}$")


def shoonya_to_fyers(tsym: str, exchange: str = "") -> str | None:
    """Reverse of fyers_to_shoonya: a Shoonya trading symbol -> this app's Fyers symbol, or None
    if it can't be matched. Handles options, futures, and all NSE cash instruments (-EQ/-TB/-GS/…)."""
    if _NSE_CASH_SUFFIX.search(tsym):
        return f"NSE:{tsym}"
    _build_option_index()
    _build_future_index()
    _build_fyers_option_index()
    key = _tsym_to_key.get(tsym)
    if key:
        return _fyers_option_index.get(key)
    fkey = _tsym_to_fut_key.get(tsym)
    if fkey:
        return _fyers_future_index.get(fkey)
    return None


def _parse_shoonya_date(s: str) -> str:
    """Shoonya expiry like "07-JUL-2026" / "07-Jul-2026" -> ISO "2026-07-07"."""
    return datetime.datetime.strptime(s.strip(), "%d-%b-%Y").date().isoformat()


def _parse_fyers_option(body: str):
    """Returns (root, opt_type) from a bare Fyers option body (no exchange prefix), or None.
    Strike is not returned here — it comes from the expiry-anchored match — but the regex
    confirms this is actually an option symbol."""
    m = _OPT_RE.match(body.upper())
    if not m:
        return None
    return m.group(1), m.group(4)


def fyers_to_shoonya(fyers_symbol: str) -> dict:
    """{"exch","tsym","token","lot_size"} for a Fyers symbol. Raises ValueError with a clear
    message if the contract can't be resolved (so order placement reports it per-leg)."""
    body = fyers_symbol.split(":")[-1]

    # NSE cash instruments (-EQ equity, -TB T-bill, -GS govt security, -GB SGB, …) share the same
    # tsym across brokers on the NSE segment.
    if _NSE_CASH_SUFFIX.search(body):
        return {"exch": "NSE", "tsym": body, "token": None, "lot_size": 1}

    # Futures: match (root, expiry) — no strike/type.
    fm = _FUT_RE.match(body.upper())
    if fm:
        expiry_ts = symbol_master.get_expiry_ts(fyers_symbol)
        if not expiry_ts:
            raise ValueError(f"No expiry date found for '{fyers_symbol}' in the Fyers symbol master")
        expiry_iso = datetime.datetime.fromtimestamp(int(expiry_ts)).date().isoformat()
        _build_future_index()
        hit = _future_index.get((fm.group(1).upper(), expiry_iso))
        if not hit:
            raise ValueError(f"No Shoonya future for {fm.group(1)} {expiry_iso}")
        return hit

    parsed = _parse_fyers_option(body)
    if not parsed:
        raise ValueError(f"Can't map '{fyers_symbol}' to a Shoonya symbol (unsupported instrument type)")
    root, opt_type = parsed

    # Strike + expiry come from the two masters: strike from the numeric tail via the Fyers
    # master's own strike field would be ideal, but parsing it off the symbol is unreliable for
    # both weekly/monthly, so anchor on the real expiry date (Fyers master) + the strike parsed
    # from the option regex tail.
    m = _OPT_RE.match(body.upper())
    strike = float(m.group(3))

    expiry_ts = symbol_master.get_expiry_ts(fyers_symbol)
    if not expiry_ts:
        raise ValueError(f"No expiry date found for '{fyers_symbol}' in the Fyers symbol master")
    expiry_iso = datetime.datetime.fromtimestamp(int(expiry_ts)).date().isoformat()

    _build_option_index()
    hit = _option_index.get((root.upper(), expiry_iso, opt_type, strike))
    if not hit:
        raise ValueError(f"No Shoonya contract for {root} {expiry_iso} {opt_type} {strike:g}")
    return hit
