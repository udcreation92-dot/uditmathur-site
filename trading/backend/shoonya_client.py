"""Shoonya (Finvasia Noren OMS) client — third broker alongside Fyers and Zerodha.

Shoonya migrated its API to an OAuth flow (the old NorenWClientTP password+TOTP login is
deprecated and now returns 502). Auth is now a browser redirect like Fyers/Zerodha:
  1. redirect the user to the OAuth login URL (getOAuthURL),
  2. Shoonya redirects back to our registered redirect URL with an auth `code`,
  3. exchange the code for an access token (getAccessToken) — valid for the trading day,
  4. all subsequent REST calls carry `Authorization: Bearer <access_token>` (injectOAuthHeader).
There is no refresh endpoint, so re-auth is a daily browser login (same as the other brokers).
Also note Shoonya now requires the caller's static IP to be whitelisted on trade.shoonya.com.

Built on the official `NorenRestApiOAuth` SDK. The access token is cached to disk and re-injected
on startup so restarts don't force a re-login within the same day. Requires SHOONYA_CLIENT_ID,
SHOONYA_API_SECRET (the "Secret Code"), and SHOONYA_USERID from the API-key page.
"""
import os
import json
import hashlib
import threading
import datetime
from pathlib import Path

import requests
import NorenRestApiPy.NorenApi as _noren_module
from NorenRestApiPy.NorenApi import NorenApi
import state_paths

API_HOST = "https://api.shoonya.com/NorenWClientAPI/"
WS_HOST = "wss://api.shoonya.com/NorenWSAPI/"
OAUTH_URL = "https://api.shoonya.com/OAuthlogin/authorize/oauth"
GEN_ACS_TOK_URL = API_HOST + "GenAcsTok"
TOKEN_FILE = state_paths.state_path(".shoonya_token.json")

# Shoonya enforces an IP whitelist on the account (residential ISPs hand out dynamic IPs that
# drift, breaking the whitelist repeatedly). SHOONYA_PROXY_URL routes ALL Shoonya traffic through
# a fixed egress IP (e.g. a TrueIP dedicated proxy) so the whitelisted IP never has to change.
# Format: http://username:password@host:port  (from the proxy provider's dashboard).
#
# The SDK's NorenApi module calls the bare `requests.post`/`requests.get` functions directly
# (not through a Session), so a plain `proxies=` kwarg can't be threaded through its public
# methods. Instead we swap the `requests` name INSIDE THAT MODULE ONLY for a pre-configured
# Session (Session.post/.get have the same call signature) — this leaves Fyers/Zerodha, which
# import `requests` in their own modules, completely unaffected.
_SHOONYA_PROXY_URL = os.environ.get("SHOONYA_PROXY_URL", "").strip()


def _build_shoonya_session() -> requests.Session:
    session = requests.Session()
    if _SHOONYA_PROXY_URL:
        session.proxies = {"http": _SHOONYA_PROXY_URL, "https": _SHOONYA_PROXY_URL}
    return session


_shoonya_session = _build_shoonya_session()
_noren_module.requests = _shoonya_session


class ShoonyaError(Exception):
    pass


class ShoonyaClient:
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                inst = cls._instance
                inst._api = NorenApi(host=API_HOST, websocket=WS_HOST)
                inst._access_token = None
                inst._uid = None
                inst._actid = None
                inst._token_date = None
                inst._injected = False
        return cls._instance

    # ---- credentials (from .env) ----
    @property
    def _client_id(self) -> str:
        # OAuth client_id from the API-key page (the "Client Id", e.g. FA24828_U).
        return os.environ.get("SHOONYA_CLIENT_ID") or os.environ["SHOONYA_VENDOR_CODE"]

    @property
    def _secret_code(self) -> str:
        return os.environ["SHOONYA_API_SECRET"]

    @property
    def userid(self) -> str:
        return os.environ["SHOONYA_USERID"]

    def _has_credentials(self) -> bool:
        return bool(os.environ.get("SHOONYA_USERID") and os.environ.get("SHOONYA_API_SECRET")
                    and (os.environ.get("SHOONYA_CLIENT_ID") or os.environ.get("SHOONYA_VENDOR_CODE")))

    # ---- token persistence ----
    def _today(self) -> str:
        return datetime.date.today().isoformat()

    def _load_cached_token(self):
        if self._access_token:
            return
        if TOKEN_FILE.exists():
            try:
                d = json.loads(TOKEN_FILE.read_text())
                self._access_token = d.get("access_token")
                self._uid = d.get("uid")
                self._actid = d.get("actid")
                self._token_date = d.get("date")
            except Exception:
                pass

    def _save_token(self, refresh_token: str = None):
        try:
            TOKEN_FILE.write_text(json.dumps({
                "access_token": self._access_token, "refresh_token": refresh_token,
                "uid": self._uid, "actid": self._actid, "date": self._token_date,
            }))
        except Exception:
            pass

    def _inject(self):
        """Re-attach the cached access token to the SDK so REST calls are authenticated. Must be
        called after loading a cached token (e.g. on a fresh process) before any API call."""
        self._api.injectOAuthHeader(self._access_token, self._uid, self._actid)
        self._api.set_credentials(self._access_token, self._uid, self._actid)
        self._injected = True

    def _ensure_session(self):
        self._load_cached_token()
        if not self._access_token or self._token_date != self._today():
            raise ShoonyaError("Shoonya session expired or not connected — click Connect Shoonya "
                               "to log in again (OAuth token is valid for the trading day only).")
        if not self._injected:
            self._inject()

    # ---- OAuth ----
    def get_oauth_url(self) -> str:
        if not self._has_credentials():
            raise ShoonyaError("Shoonya credentials not set in backend/.env "
                               "(SHOONYA_USERID, SHOONYA_CLIENT_ID, SHOONYA_API_SECRET)")
        return self._api.getOAuthURL(OAUTH_URL, self._client_id)

    def exchange_auth_code(self, auth_code: str) -> dict:
        """Exchanges the OAuth `code` (from the redirect) for an access token and caches it.

        Posts to GenAcsTok directly instead of going through the SDK's getAccessToken — the SDK
        swallows Shoonya's actual error message (emsg) at logger.debug level, which is invisible
        by default, so every failure looked like the same generic "invalid/expired code" message
        regardless of the real cause (wrong secret, wrong client_id, reused code, IP not
        whitelisted, etc). Posting directly lets us surface exactly what Shoonya says."""
        if not self._has_credentials():
            raise ShoonyaError("Shoonya credentials not set in backend/.env")
        auth_code = (auth_code or "").strip()
        client_id = self._client_id
        secret = self._secret_code
        checksum = hashlib.sha256((client_id + secret + auth_code).encode("utf-8")).hexdigest()
        payload = "jData=" + json.dumps({"code": auth_code, "checksum": checksum, "uid": self.userid})
        try:
            resp = _shoonya_session.post(GEN_ACS_TOK_URL, data=payload, timeout=15)
        except requests.RequestException as e:
            raise ShoonyaError(f"Shoonya token exchange request failed: {e}")
        try:
            result = resp.json()
        except ValueError:
            raise ShoonyaError(f"Shoonya token exchange returned a non-JSON response "
                               f"(HTTP {resp.status_code}): {resp.text[:300]}")
        if "access_token" not in result:
            emsg = result.get("emsg") or result.get("message") or json.dumps(result)
            raise ShoonyaError(
                f"Shoonya token exchange failed: {emsg}. Common causes: the code was already "
                "used or has expired (codes are single-use and expire within a couple of "
                "minutes — get a fresh one via Connect Shoonya), SHOONYA_CLIENT_ID/API_SECRET "
                "in .env don't match the API-key page, or this machine's IP isn't whitelisted "
                "on trade.shoonya.com.")
        access_token = result["access_token"]
        uid = result.get("USERID", self.userid)
        refresh_token = result.get("refresh_token")
        actid = result.get("actid", uid)
        self._api.injectOAuthHeader(access_token, uid, actid)
        self._access_token = access_token
        self._uid = uid
        self._actid = actid
        self._token_date = self._today()
        self._injected = True  # getAccessToken already injected the header
        self._save_token(refresh_token)
        return {"user_id": uid, "actid": actid}

    def is_logged_in(self) -> bool:
        self._load_cached_token()
        if not self._access_token or self._token_date != self._today():
            return False
        try:
            if not self._injected:
                self._inject()
            return self._api.get_limits() is not None
        except Exception:
            return False

    def logout(self):
        try:
            self._ensure_session()
            self._api.logout()
        except Exception:
            pass
        self._access_token = self._uid = self._actid = self._token_date = None
        self._injected = False
        if TOKEN_FILE.exists():
            TOKEN_FILE.unlink()

    # ---- read APIs ----
    def get_limits(self) -> dict:
        self._ensure_session()
        return self._api.get_limits() or {}

    def get_positions(self) -> list:
        self._ensure_session()
        return self._api.get_positions() or []

    def get_holdings(self, product: str = "C") -> list:
        self._ensure_session()
        return self._api.get_holdings(product_type=product) or []

    def get_order_book(self) -> list:
        self._ensure_session()
        return self._api.get_order_book() or []

    def get_trade_book(self) -> list:
        self._ensure_session()
        return self._api.get_trade_book() or []

    # ---- trading APIs ----
    def place_order(self, exchange: str, tradingsymbol: str, transaction_type: str, quantity: int,
                    price_type: str, product: str, price: float = 0, trigger_price: float = 0,
                    retention: str = "DAY", remarks: str = "trading-dashboard") -> dict:
        """transaction_type: 'B'/'S'; price_type: 'MKT'|'LMT'|'SL-LMT'|'SL-MKT';
        product: 'I' (intraday) | 'C' (delivery/CNC) | 'M' (NRML/margin)."""
        self._ensure_session()
        return self._api.place_order(
            buy_or_sell=transaction_type, product_type=product, exchange=exchange,
            tradingsymbol=tradingsymbol, quantity=int(quantity), discloseqty=0,
            price_type=price_type, price=price or 0, trigger_price=trigger_price or None,
            retention=retention, remarks=remarks,
        ) or {}

    def cancel_order(self, order_no: str) -> dict:
        self._ensure_session()
        return self._api.cancel_order(order_no) or {}

    def modify_order(self, order_no: str, exchange: str, tradingsymbol: str, quantity: int,
                     price: float, price_type: str = "LMT") -> dict:
        """Re-price/re-qty a resting order. Noren needs the exchange + tsym + new qty on modify."""
        self._ensure_session()
        return self._api.modify_order(
            orderno=order_no, exchange=exchange, tradingsymbol=tradingsymbol,
            newquantity=int(quantity), newprice_type=price_type, newprice=price,
        ) or {}


client = ShoonyaClient()
