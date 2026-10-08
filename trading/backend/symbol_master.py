import re
import time
import requests
import pandas as pd
from pathlib import Path
from datetime import date
import state_paths

CACHE_FILE = state_paths.state_path(".symbol_master_cache.csv")
CACHE_TTL = 24 * 3600  # refresh once a day

MASTER_URLS = {
    "NSE_CM": "https://public.fyers.in/sym_details/NSE_CM.csv",
    "NSE_FO": "https://public.fyers.in/sym_details/NSE_FO.csv",
    "BSE_CM": "https://public.fyers.in/sym_details/BSE_CM.csv",
}

COLUMNS = [
    "fytoken", "symbol_desc", "col3", "lot_size", "tick_size", "isin",
    "trading_session", "listing_date", "expiry_ts", "symbol", "col11",
    "col12", "col13", "short_name", "col15", "strike_price", "exchange_code",
    "col18", "col19", "col20", "col21",
]

_cache = {"df": None, "loaded_at": 0}

def _segment_for(symbol: str) -> str:
    if symbol.endswith("-EQ"):
        return "EQUITY"
    if symbol.endswith("-INDEX"):
        return "INDEX"
    if symbol.endswith("CE") or symbol.endswith("PE"):
        return "OPTION"
    if "FUT" in symbol:
        return "FUTURE"
    return "OTHER"

# rank: lower is better, used as a tiebreaker so common instrument types surface first
_SEGMENT_RANK = {"EQUITY": 0, "INDEX": 1, "FUTURE": 2, "OPTION": 3, "OTHER": 4}

def _download_all() -> pd.DataFrame:
    frames = []
    for name, url in MASTER_URLS.items():
        resp = requests.get(url, timeout=15)
        resp.raise_for_status()
        from io import StringIO
        df = pd.read_csv(StringIO(resp.text), header=None, names=COLUMNS, on_bad_lines="skip")
        frames.append(df[["symbol", "symbol_desc", "short_name", "lot_size", "expiry_ts"]])
    combined = pd.concat(frames, ignore_index=True)
    combined["segment"] = combined["symbol"].apply(_segment_for)
    combined.to_csv(CACHE_FILE, index=False)
    return combined

def get_symbol_master() -> pd.DataFrame:
    now = time.time()
    if _cache["df"] is not None and now - _cache["loaded_at"] < CACHE_TTL:
        return _cache["df"]

    if CACHE_FILE.exists() and now - CACHE_FILE.stat().st_mtime < CACHE_TTL:
        df = pd.read_csv(CACHE_FILE)
        if "lot_size" not in df.columns:
            df = _download_all()
        elif "segment" not in df.columns:
            df["segment"] = df["symbol"].apply(_segment_for)
    else:
        df = _download_all()

    _cache["df"] = df
    _cache["loaded_at"] = now
    return df

_lot_size_index: dict[str, int] = {}

def get_lot_size(symbol: str) -> int:
    if not _lot_size_index:
        df = get_symbol_master()
        for row in df.itertuples():
            if pd.notna(row.lot_size):
                _lot_size_index[row.symbol] = int(row.lot_size)
    return _lot_size_index.get(symbol, 1)

_expiry_index: dict[str, int] = {}

def get_expiry_ts(symbol: str) -> int | None:
    """Unix expiry timestamp for an F&O symbol from the Fyers master, or None for cash/unknown.
    Used to resolve a Fyers option to another broker's contract by its real expiry date."""
    if not _expiry_index:
        df = get_symbol_master()
        for row in df.itertuples():
            if pd.notna(row.expiry_ts):
                try:
                    _expiry_index[row.symbol] = int(row.expiry_ts)
                except (ValueError, TypeError):
                    pass
    return _expiry_index.get(symbol)

def _score(terms: list[str], symbol: str, desc: str, short_name: str) -> int:
    """Lower score = better match. Combines match quality with instrument-type preference."""
    sym = symbol.upper()
    sdesc = (desc or "").upper()
    sname = (short_name or "").upper()
    combined = f"{sym} {sdesc} {sname}"

    ticker = sym.split(":", 1)[1] if ":" in sym else sym
    full_query = " ".join(terms)

    if sname == full_query or ticker == full_query:
        quality = 0
    elif sname.startswith(full_query) or ticker.startswith(full_query):
        quality = 1
    elif re.search(rf"\b{re.escape(full_query)}", sdesc):
        quality = 2
    elif full_query in sname or full_query in ticker:
        quality = 3
    elif all(term in combined for term in terms):
        quality = 4
    else:
        quality = 5

    # Multi-term queries like "NIFTY 23000" match both NIFTY... and FINNIFTY... contracts
    # (NIFTY is a substring of FINNIFTY) and land in the same quality bucket — break the tie
    # by whether the instrument's name actually STARTS with the first term, so NIFTY contracts
    # rank above FINNIFTY/BANKNIFTY ones for "nifty ..." and vice versa for "finnifty ...".
    first = terms[0]
    first_term_prefix = 0 if (ticker.startswith(first) or sname.startswith(first)) else 1

    return quality * 100 + first_term_prefix * 10 + _SEGMENT_RANK.get(_segment_for(sym), 4)

def search(query: str, limit: int = 20, segment: str | None = None) -> list[dict]:
    df = get_symbol_master()
    terms = query.upper().split()
    if not terms:
        return []

    combined_upper = (
        df["symbol"].str.upper() + " " +
        df["symbol_desc"].str.upper().fillna("") + " " +
        df["short_name"].astype(str).str.upper().fillna("")
    )

    mask = pd.Series(True, index=df.index)
    for term in terms:
        mask &= combined_upper.str.contains(re.escape(term), na=False)

    if segment:
        mask &= df["segment"] == segment.upper()

    candidates = df[mask]
    if candidates.empty:
        return []

    scored = candidates.assign(
        _score=[
            _score(terms, row.symbol, row.symbol_desc, row.short_name)
            for row in candidates.itertuples()
        ]
    )
    # Within equal relevance, surface nearer expiries first — searching "NIFTY 23000" should
    # show this week's contract before next month's.
    scored = scored.assign(_expiry=pd.to_numeric(scored["expiry_ts"], errors="coerce").fillna(0))
    top = scored.sort_values(["_score", "_expiry"]).head(limit)
    records = top[["symbol", "symbol_desc", "segment", "lot_size"]].to_dict("records")
    for r in records:
        r["lot_size"] = int(r["lot_size"]) if pd.notna(r["lot_size"]) else 1
    return records

_TBILL_RE = re.compile(r"^NSE:(\d+)D(\d{2})(\d{2})(\d{2})-TB$")

def list_tbills() -> list[dict]:
    """GOI T-Bills traded on NSE, e.g. NSE:91D030926-TB = 91-day bill maturing 03/09/2026."""
    df = get_symbol_master()
    out = []
    for row in df.itertuples():
        m = _TBILL_RE.match(row.symbol)
        if not m:
            continue
        tenor_days, dd, mm, yy = m.groups()
        try:
            maturity = date(2000 + int(yy), int(mm), int(dd))
        except ValueError:
            continue
        out.append({
            "symbol": row.symbol,
            "desc": row.symbol_desc,
            "tenor_days": int(tenor_days),
            "maturity_date": maturity.isoformat(),
            "lot_size": int(row.lot_size) if pd.notna(row.lot_size) else 100,
        })
    return out

# Underlyings whose futures root symbol doesn't match their spot/index quote symbol.
_INDEX_ROOT_TO_SYMBOL = {
    "NIFTY": "NSE:NIFTY50-INDEX",
    "BANKNIFTY": "NSE:NIFTYBANK-INDEX",
    "FINNIFTY": "NSE:FINNIFTY-INDEX",
    "MIDCPNIFTY": "NSE:MIDCPNIFTY-INDEX",
    "NIFTYNXT50": "NSE:NIFTYNXT50-INDEX",
}

def list_fo_underlyings() -> list[dict]:
    """Every underlying with equity derivatives (stock + index F&O), derived from the
    FUTURE segment's clean root ticker (short_name) — every F&O underlying has at least
    one futures contract, so this is a reliable/simple way to enumerate the full universe."""
    df = get_symbol_master()
    futures = df[df["segment"] == "FUTURE"]
    roots = sorted(futures["short_name"].dropna().unique())
    out = []
    for root in roots:
        symbol = _INDEX_ROOT_TO_SYMBOL.get(root, f"NSE:{root}-EQ")
        out.append({"root": root, "symbol": symbol, "is_index": root in _INDEX_ROOT_TO_SYMBOL})
    return out
