"""
DRAFT — Zerodha headless auto-login (Phase 1 of the trading AI overhaul).

Reproduces the Kite web login the user does manually each morning, so the daily
access token can be refreshed unattended (scheduled ~08:30 IST). It does the exact
three POST/GET steps kite.zerodha.com performs, using the TOTP seed already in .env,
then hands the resulting request_token to the existing ZerodhaClient.exchange_request_token()
(which caches the token to the daily state file — same path the manual flow writes).

Flow:
    1. POST /api/login   {user_id, password}            -> request_id
    2. POST /api/twofa   {request_id, TOTP-from-seed}    -> authenticated session cookies
    3. GET  connect login URL (with those cookies)       -> 302 to redirect_uri?request_token=...
    4. ZerodhaClient.exchange_request_token(request_token) -> access_token cached

NOT wired into main.py and NOT scheduled yet. Nothing imports this. To test it by hand
once the env vars below are set:  python auto_login_zerodha.py

Requires in trading/backend/.env (values added by YOU — never committed):
    ZERODHA_USER_ID       e.g. TJ1191   (the Kite login id)
    ZERODHA_PASSWORD      the Kite login password
    ZERODHA_TOTP_SECRET   already present (base32 2FA seed)
    ZERODHA_API_KEY / ZERODHA_API_SECRET   already present
"""
import os
import urllib.parse

import pyotp
import requests

import zerodha_client
from zerodha_client import client as _zerodha_client, _ZERODHA_PROXIES

_KITE_WEB = "https://kite.zerodha.com"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
_TIMEOUT = 15


class ZerodhaLoginError(RuntimeError):
    """Raised when any step of the scripted login fails, with a human-readable reason."""


def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": _UA, "X-Kite-Version": "3"})
    # Route the login through the same fixed-IP proxy the API client uses, so the login
    # originates from the whitelisted IP too (no-op if ZERODHA_PROXY_URL is unset).
    if _ZERODHA_PROXIES:
        s.proxies.update(_ZERODHA_PROXIES)
    return s


def _extract_request_token(session: requests.Session, login_url: str) -> str:
    """Walk the redirect chain from the Kite connect login URL and pull request_token out of
    the first Location that carries it. We DON'T follow into the app's own redirect_uri (that
    would let our backend's callback consume the token first) — we stop as soon as we see it."""
    url = login_url
    for _ in range(10):
        resp = session.get(url, allow_redirects=False, timeout=_TIMEOUT)
        loc = resp.headers.get("Location")
        if not loc:
            # No more redirects. If the token wasn't seen, the session probably isn't authorized.
            raise ZerodhaLoginError(
                f"connect login did not redirect to a request_token (status {resp.status_code}). "
                "The Kite app may need a one-time manual authorization first."
            )
        params = urllib.parse.parse_qs(urllib.parse.urlparse(loc).query)
        if "request_token" in params:
            return params["request_token"][0]
        # Follow only while we stay on the kite domain; bail before leaving to redirect_uri.
        nxt = urllib.parse.urljoin(url, loc)
        if "kite.zerodha.com" not in urllib.parse.urlparse(nxt).netloc:
            raise ZerodhaLoginError("redirect left kite.zerodha.com before exposing request_token")
        url = nxt
    raise ZerodhaLoginError("too many redirects while resolving request_token")


def login_zerodha(force: bool = False) -> dict:
    """Refresh the Zerodha session unattended. Returns {ok, message}. Idempotent: if already
    logged in for today it skips the flow unless force=True."""
    if not force and _zerodha_client.is_logged_in():
        return {"ok": True, "message": "already logged in", "skipped": True}

    user_id = (os.environ.get("ZERODHA_USER_ID") or "").strip()
    password = (os.environ.get("ZERODHA_PASSWORD") or "").strip()
    totp_secret = (os.environ.get("ZERODHA_TOTP_SECRET") or "").strip()
    missing = [k for k, v in {
        "ZERODHA_USER_ID": user_id, "ZERODHA_PASSWORD": password, "ZERODHA_TOTP_SECRET": totp_secret,
    }.items() if not v]
    if missing:
        raise ZerodhaLoginError(f"missing env vars: {', '.join(missing)}")

    s = _session()

    # 1. Username + password -> request_id
    r = s.post(f"{_KITE_WEB}/api/login", data={"user_id": user_id, "password": password}, timeout=_TIMEOUT)
    if r.status_code != 200:
        raise ZerodhaLoginError(f"/api/login failed ({r.status_code}): {r.text[:200]}")
    body = r.json()
    if body.get("status") != "success" or "request_id" not in body.get("data", {}):
        raise ZerodhaLoginError(f"/api/login rejected: {body.get('message') or body}")
    request_id = body["data"]["request_id"]

    # 2. TOTP second factor -> authenticated cookies on the session
    totp_code = pyotp.TOTP(totp_secret).now()
    r2 = s.post(f"{_KITE_WEB}/api/twofa", data={
        "user_id": user_id, "request_id": request_id,
        "twofa_value": totp_code, "twofa_type": "totp", "skip_session": "true",
    }, timeout=_TIMEOUT)
    if r2.status_code != 200 or r2.json().get("status") != "success":
        raise ZerodhaLoginError(f"/api/twofa failed ({r2.status_code}): {r2.text[:200]}")

    # 3. Kite Connect login URL -> request_token from the redirect
    request_token = _extract_request_token(s, _zerodha_client.get_login_url())

    # 4. Hand off to the existing client, which exchanges + caches the daily token
    _zerodha_client.exchange_request_token(request_token)
    return {"ok": True, "message": "logged in", "skipped": False}


if __name__ == "__main__":
    # Manual test only (run by the user). Prints the outcome without touching the scheduler.
    # load .env here since the FastAPI app (main.py) isn't the entrypoint in this path.
    from dotenv import load_dotenv
    load_dotenv()
    try:
        print(login_zerodha(force=True))
    except Exception as e:
        print(f"LOGIN FAILED: {e}")
