"""
Trading MCP server (Phase 2) — READ-ONLY tools exposed to Claude (mobile + desktop) over Tailscale
Funnel. Standalone server on port 8787; Funnel publishes it on the box's public *.ts.net origin.

Because Funnel gives us the whole origin, this ONE server serves both the OAuth 2.0 shim Claude's
connector requires (discovery at the domain root + auto-approving authorize/token) AND the MCP
JSON-RPC endpoint — no Cloudflare Worker needed (contrast accounts-mcp-worker, which only existed
because Supabase couldn't own /.well-known). The shared secret Claude receives via /token is
MCP_SECRET from .env; the connector URL you paste into Claude is just this server's root URL.

Tools (all read-only — NO order placement): list_strategies, get_strategy, roi_expiries, roi_solve,
get_funds, get_positions. They proxy to the local trading API (localhost:8000).

Run:  python mcp_server.py     (then expose with: tailscale funnel 8787)
Requires MCP_SECRET in trading/backend/.env (a long random string you choose).
"""
import json
import os

import requests
import uvicorn
from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

load_dotenv()

SECRET = (os.environ.get("MCP_SECRET") or "").strip()
# Public origin Claude reaches us at (behind Tailscale Funnel), e.g.
# https://laptop-xxxx.tailXXXX.ts.net:8443 — used in the OAuth discovery docs so they advertise
# the PUBLIC endpoints, not the internal 127.0.0.1 one. Falls back to the request's base_url.
PUBLIC_ORIGIN = (os.environ.get("MCP_PUBLIC_ORIGIN") or "").strip().rstrip("/")
BACKEND = "http://localhost:8000"
AUTH_CODE = "trading_auth_code"
PORT = 8787


def _origin(request: "Request") -> str:
    return PUBLIC_ORIGIN or str(request.base_url).rstrip("/")

CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
}

app = FastAPI(title="Trading MCP")


def _json(body, status=200, extra=None):
    return JSONResponse(body, status_code=status, headers={**CORS, **(extra or {})})


# ── local trading API helpers ────────────────────────────────────────
def _get(path, params=None):
    return requests.get(BACKEND + path, params=params, timeout=90).json()


def _post(path, body):
    return requests.post(BACKEND + path, json=body, timeout=90).json()


def _multi(paths: dict) -> dict:
    out = {}
    for name, path in paths.items():
        try:
            out[name] = _get(path)
        except Exception as e:
            out[name] = {"error": str(e)}
    return out


# ── tool implementations ─────────────────────────────────────────────
def t_list_strategies(a):
    return _get("/strategies")


def t_get_strategy(a):
    return _get(f"/strategies/{a['name']}")


def t_roi_expiries(a):
    p = {"underlying": a["underlying"]} if a.get("underlying") else None
    return _get("/roi/expiries", p)


def t_roi_solve(a):
    body = {k: a[k] for k in ("capital", "target_roi_pct", "underlying", "expiry_index", "roi_basis") if k in a}
    return _post("/roi/solve", body)


def t_get_funds(a):
    return _multi({"fyers": "/orders/funds", "zerodha": "/zerodha/funds", "shoonya": "/shoonya/funds"})


def t_get_positions(a):
    return _multi({"fyers": "/orders/positions", "zerodha": "/zerodha/positions", "shoonya": "/shoonya/positions"})


def t_preview_order(a):
    return _post("/order/preview", a)


def t_place_order(a):
    return _post("/order/place", a)


def t_get_trading_mode(a):
    return _get("/order/mode")


def t_set_trading_mode(a):
    return _post("/order/mode", {"mode": a["mode"]})


# ── cash-segment scalping ────────────────────────────────────────────
def _norm_equity(sym: str) -> str:
    """'RELIANCE' -> 'NSE:RELIANCE-EQ'; leave an already-qualified Fyers symbol as-is."""
    s = (sym or "").strip().upper()
    if ":" in s:
        return s
    if not s.endswith("-EQ"):
        s += "-EQ"
    return "NSE:" + s


def t_arm_scalp(a):
    """Preview (no confirm) or arm (confirm=true) a cash scalp. Qty = floor(max_loss/|sl-entry|)."""
    symbol = _norm_equity(a["symbol"])
    entry, sl, target = float(a["entry_price"]), float(a["sl_price"]), float(a["target_price"])
    max_loss = float(a.get("max_loss", 100))
    side = (a.get("side") or "BUY").upper()
    trade_type = (a.get("trade_type") or "MIS").upper()
    broker = (a.get("broker") or "shoonya").lower()
    d = abs(sl - entry)
    qty = int(d and (max_loss // d))
    preview = {"symbol": symbol, "side": side, "entry_price": entry, "sl_price": sl,
               "target_price": target, "max_loss": max_loss, "qty": qty,
               "trade_type": trade_type, "broker": broker,
               "worst_case_loss": round(qty * d, 2)}
    if qty < 1:
        return {"ok": False, "error": "tradable qty < 1 — widen max_loss or tighten the SL distance", "preview": preview}
    if not a.get("confirm"):
        return {"preview": preview, "note": "Show the user. To arm it, call arm_scalp again with confirm=true.",
                "reminder": "Arming commits a real conditional trade (fires when price hits entry, if auto-trade is ON)."}
    return _post("/scalp", {"symbol": symbol, "side": side, "entry_price": entry, "sl_price": sl,
                            "target_price": target, "max_loss": max_loss, "trade_type": trade_type,
                            "broker": broker, "name": a.get("name"), "note": a.get("note")})


def t_list_scalps(a):
    return _get("/scalp/list")


def t_cancel_scalp(a):
    return _post(f"/scalp/{int(a['scalp_id'])}/cancel", {})


def t_exit_scalp(a):
    return _post(f"/scalp/{int(a['scalp_id'])}/exit", {})


def t_set_scalp_auto(a):
    return _post("/scalp/auto", {"on": bool(a["on"])})


TOOLS = {
    "list_strategies": {
        "fn": t_list_strategies,
        "description": "List the named trading strategies the user has configured (name, title, summary).",
        "schema": {"type": "object", "properties": {}},
    },
    "get_strategy": {
        "fn": t_get_strategy,
        "description": "Get one strategy's full definition — how_to_run steps, roll_rule, guardrails, params. Read this before running a strategy the user names.",
        "schema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]},
    },
    "roi_expiries": {
        "fn": t_roi_expiries,
        "description": "List available option expiries for an underlying (default Nifty) with their index and days-to-expiry, so you can pick expiry_index for roi_solve.",
        "schema": {"type": "object", "properties": {"underlying": {"type": "string", "description": "e.g. NSE:NIFTY50-INDEX (default)"}}},
    },
    "roi_solve": {
        "fn": t_roi_solve,
        "description": "The deterministic ROI-target option-selling solver. Given capital and a target ROI, returns the short strangle (sell CE + sell PE) near that ROI, sized to the capital, plus a ladder of nearby rungs. NEVER compute strikes/margin/ROI yourself — always use this.",
        "schema": {
            "type": "object",
            "properties": {
                "capital": {"type": "number", "description": "₹ margin to deploy, e.g. 600000"},
                "target_roi_pct": {"type": "number", "description": "target ROI %, e.g. 20"},
                "expiry_index": {"type": "integer", "description": "from roi_expiries; 0 = nearest"},
                "roi_basis": {"type": "string", "enum": ["annualized", "absolute"], "description": "'annualized' for weekly/monthly, 'absolute' for same-day/expiry-day"},
                "underlying": {"type": "string", "description": "default NSE:NIFTY50-INDEX"},
            },
            "required": ["capital", "target_roi_pct"],
        },
    },
    "get_funds": {
        "fn": t_get_funds,
        "description": "Available funds/margin across all three brokers (Fyers, Zerodha, Shoonya).",
        "schema": {"type": "object", "properties": {}},
    },
    "get_positions": {
        "fn": t_get_positions,
        "description": "Current open positions across all three brokers. Use to check exposure or find legs that need rolling (e.g. a short option now within 5% of spot).",
        "schema": {"type": "object", "properties": {}},
    },
    "get_trading_mode": {
        "fn": t_get_trading_mode,
        "description": "Current order-execution mode: 'dry_run' (orders are simulated, nothing sent to a broker), 'live' (real orders), or 'killed' (kill switch — all placement refused). ALWAYS check this before proposing to place.",
        "schema": {"type": "object", "properties": {}},
    },
    "set_trading_mode": {
        "fn": t_set_trading_mode,
        "description": "Change the order-execution mode. Only do this when the user EXPLICITLY asks (e.g. 'go live', 'stop trading'/'kill'). 'killed' is the kill switch.",
        "schema": {"type": "object", "properties": {"mode": {"type": "string", "enum": ["dry_run", "live", "killed"]}}, "required": ["mode"]},
    },
    "preview_order": {
        "fn": t_preview_order,
        "description": "Show EXACTLY what a short strangle order would send (both SELL legs, qty, limits, est margin/premium/brokerage) and the guardrail verdict — WITHOUT placing anything. Always call this and show the user before placing. Use the ce_symbol/pe_symbol/lots and the bids from roi_solve.",
        "schema": {
            "type": "object",
            "properties": {
                "ce_symbol": {"type": "string", "description": "Fyers CE symbol from roi_solve, e.g. NSE:NIFTY...CE"},
                "pe_symbol": {"type": "string", "description": "Fyers PE symbol from roi_solve"},
                "lots": {"type": "integer"},
                "ce_limit": {"type": "number", "description": "the current CE bid from roi_solve (ce_bid)"},
                "pe_limit": {"type": "number", "description": "the current PE bid from roi_solve (pe_bid)"},
                "broker": {"type": "string", "description": "execution broker; default shoonya"},
                "fill_mode": {"type": "string", "enum": ["protective", "exact"], "description": "'protective' (DEFAULT) sells just below the bid so it fills even if price ticks down; 'exact' sells at the bid"},
            },
            "required": ["ce_symbol", "pe_symbol", "lots", "ce_limit", "pe_limit"],
        },
    },
    "place_order": {
        "fn": t_place_order,
        "description": "Place (or, in dry_run, SIMULATE) the short strangle. Requires confirm=true and only AFTER the user has seen preview_order and said yes. In dry_run it logs a simulated order; in live it places real SELL LIMIT orders and the order-watcher tracks fills. Never call with confirm=true unless the user explicitly approved this specific order.",
        "schema": {
            "type": "object",
            "properties": {
                "ce_symbol": {"type": "string"},
                "pe_symbol": {"type": "string"},
                "lots": {"type": "integer"},
                "ce_limit": {"type": "number", "description": "the ce_bid from roi_solve"},
                "pe_limit": {"type": "number", "description": "the pe_bid from roi_solve"},
                "broker": {"type": "string", "description": "default shoonya"},
                "fill_mode": {"type": "string", "enum": ["protective", "exact"], "description": "'protective' (default) or 'exact' — must match what the user saw in preview_order"},
                "confirm": {"type": "boolean", "description": "must be true; set only after explicit user approval"},
            },
            "required": ["ce_symbol", "pe_symbol", "lots", "ce_limit", "pe_limit", "confirm"],
        },
    },
    "arm_scalp": {
        "fn": t_arm_scalp,
        "description": "Preview or arm a cash-segment scalp (equity, not options). Qty is auto-computed from max_loss and the SL distance (floor(max_loss/|sl-entry|)). Call WITHOUT confirm to preview the qty + worst-case loss and show the user; call WITH confirm=true only after they approve. It then fires a LIMIT entry when price hits entry and auto-manages SL/target. Default broker shoonya, default MIS.",
        "schema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string", "description": "equity, e.g. RELIANCE or NSE:RELIANCE-EQ"},
                "side": {"type": "string", "enum": ["BUY", "SELL"]},
                "entry_price": {"type": "number"},
                "sl_price": {"type": "number", "description": "stop-loss price"},
                "target_price": {"type": "number"},
                "max_loss": {"type": "number", "description": "max ₹ loss (sizes the qty); default 100"},
                "trade_type": {"type": "string", "enum": ["MIS", "CNC"], "description": "default MIS"},
                "broker": {"type": "string", "description": "default shoonya"},
                "confirm": {"type": "boolean", "description": "true to actually arm; only after user approval"},
            },
            "required": ["symbol", "side", "entry_price", "sl_price", "target_price"],
        },
    },
    "list_scalps": {
        "fn": t_list_scalps,
        "description": "List all scalps (waiting/open/closed) with live quotes, P&L, and the global auto-trade toggle.",
        "schema": {"type": "object", "properties": {}},
    },
    "cancel_scalp": {
        "fn": t_cancel_scalp,
        "description": "Cancel a WAITING scalp (not yet entered) by its scalp_id.",
        "schema": {"type": "object", "properties": {"scalp_id": {"type": "integer"}}, "required": ["scalp_id"]},
    },
    "exit_scalp": {
        "fn": t_exit_scalp,
        "description": "Manually exit an OPEN scalp now (market-protective exit) by its scalp_id.",
        "schema": {"type": "object", "properties": {"scalp_id": {"type": "integer"}}, "required": ["scalp_id"]},
    },
    "set_scalp_auto": {
        "fn": t_set_scalp_auto,
        "description": "Turn the global scalp AUTO-TRADE on/off. Off = armed scalps won't auto-enter (manual only).",
        "schema": {"type": "object", "properties": {"on": {"type": "boolean"}}, "required": ["on"]},
    },
}


def _call_tool(name, args):
    tool = TOOLS.get(name)
    if not tool:
        return {"content": [{"type": "text", "text": f"unknown tool: {name}"}], "isError": True}
    try:
        data = tool["fn"](args or {})
        return {"content": [{"type": "text", "text": json.dumps(data, default=str)}]}
    except Exception as e:
        return {"content": [{"type": "text", "text": f"tool error: {e}"}], "isError": True}


# ── OAuth 2.0 shim (mirrors accounts-mcp-worker) ─────────────────────
@app.options("/{path:path}")
def _options(path: str):
    return Response("ok", headers=CORS)


@app.get("/.well-known/oauth-protected-resource")
@app.get("/.well-known/oauth-protected-resource/{rest:path}")
def _oauth_protected(request: Request, rest: str = ""):
    origin = _origin(request)
    return _json({"resource": origin, "authorization_servers": [origin], "bearer_methods_supported": ["header"]})


@app.get("/.well-known/oauth-authorization-server")
@app.get("/.well-known/openid-configuration")
def _oauth_as(request: Request):
    origin = _origin(request)
    return _json({
        "issuer": origin,
        "authorization_endpoint": f"{origin}/authorize",
        "token_endpoint": f"{origin}/token",
        "registration_endpoint": f"{origin}/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code"],
        "code_challenge_methods_supported": ["S256", "plain"],
        "token_endpoint_auth_methods_supported": ["none"],
        "scopes_supported": ["mcp"],
    })


@app.post("/register")
async def _register(request: Request):
    try:
        reg = await request.json()
    except Exception:
        reg = {}
    import time
    return _json({
        "client_id": "trading-mcp",
        "client_id_issued_at": int(time.time()),
        "redirect_uris": reg.get("redirect_uris", []),
        "token_endpoint_auth_method": "none",
        "grant_types": ["authorization_code"],
        "response_types": ["code"],
    }, status=201)


@app.get("/authorize")
def _authorize(redirect_uri: str = "", state: str = ""):
    if not redirect_uri:
        return _json({"error": "invalid_request"}, status=400)
    sep = "&" if "?" in redirect_uri else "?"
    loc = f"{redirect_uri}{sep}code={AUTH_CODE}" + (f"&state={state}" if state else "")
    return Response(status_code=302, headers={**CORS, "Location": loc})


@app.post("/token")
def _token():
    return _json({"access_token": SECRET, "token_type": "Bearer", "expires_in": 31536000, "scope": "mcp"})


# ── MCP JSON-RPC endpoint (root) ─────────────────────────────────────
def _bearer_ok(request: Request) -> bool:
    authz = request.headers.get("authorization", "")
    return authz.lower().startswith("bearer ") and authz[7:].strip() == SECRET


@app.get("/")
def _health():
    return _json({"ok": True, "server": "trading-mcp"})


@app.post("/")
async def _rpc(request: Request):
    if not _bearer_ok(request):
        origin = _origin(request)
        return _json({"error": "unauthorized"}, status=401,
                     extra={"WWW-Authenticate": f'Bearer resource_metadata="{origin}/.well-known/oauth-protected-resource"'})
    body = await request.json()
    method = body.get("method")
    rpc_id = body.get("id")
    params = body.get("params") or {}

    if method == "initialize":
        result = {
            "protocolVersion": params.get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "trading", "version": "1.0.0"},
        }
    elif method in ("notifications/initialized", "notifications/cancelled"):
        return Response(status_code=202, headers=CORS)  # notification — no body
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": [{"name": n, "description": t["description"], "inputSchema": t["schema"]}
                            for n, t in TOOLS.items()]}
    elif method == "tools/call":
        result = _call_tool(params.get("name"), params.get("arguments"))
    else:
        return _json({"jsonrpc": "2.0", "id": rpc_id, "error": {"code": -32601, "message": f"method not found: {method}"}})

    return _json({"jsonrpc": "2.0", "id": rpc_id, "result": result})


if __name__ == "__main__":
    if not SECRET:
        raise SystemExit("MCP_SECRET is not set in trading/backend/.env — add a long random string first.")
    uvicorn.run(app, host="127.0.0.1", port=PORT)
