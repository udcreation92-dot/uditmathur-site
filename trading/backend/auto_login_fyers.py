"""
DRAFT — Fyers headless auto-login (Phase 1 of the trading AI overhaul).

Reproduces the Fyers web login unattended using the internal `vagator` auth endpoints,
then hands the resulting auth_code to the existing FyersClient.exchange_auth_code()
(which generates + caches the daily access token, same file the manual flow writes).

Flow (Fyers v2 vagator + v3 token):
    1. POST vagator/send_login_otp_v2  {fy_id(b64), app_id:"2"}      -> request_key
    2. POST vagator/verify_otp         {request_key, otp=TOTP}       -> request_key
    3. POST vagator/verify_pin_v2      {request_key, pin(b64)}       -> vagator access_token
    4. POST api/v3/token  (Bearer vagator token)                     -> Url containing auth_code
    5. FyersClient.exchange_auth_code(auth_code)                     -> access_token cached

⚠️ These vagator hosts/paths are undocumented and Fyers changes them from time to time. If a
step fails, the error prints the exact endpoint + response so we can adjust (or switch this
broker to the Playwright fallback). NOT wired into main.py and NOT scheduled — nothing imports it.

To test by hand (after setting the env vars below):  python auto_login_fyers.py

Requires in trading/backend/.env (values added by YOU — never committed):
    FYERS_FY_ID          your Fyers login id (e.g. XU12345) — NOT the app client-id
    FYERS_TOTP_SECRET    base32 2FA seed (Fyers has none stored yet)
    FYERS_PIN            your 4-digit trading PIN
    FYERS_CLIENT_ID / FYERS_SECRET_KEY / FYERS_REDIRECT_URI   already present
"""
import base64
import os
import urllib.parse

import pyotp
import requests

from fyers_client import client as _fyers_client, _proxies

_SEND_OTP = "https://api-t2.fyers.in/vagator/v2/send_login_otp_v2"
_VERIFY_OTP = "https://api-t2.fyers.in/vagator/v2/verify_otp"
_VERIFY_PIN = "https://api-t2.fyers.in/vagator/v2/verify_pin_v2"
_TOKEN = "https://api-t1.fyers.in/api/v3/token"
_TIMEOUT = 15


class FyersLoginError(RuntimeError):
    """Raised when any step of the scripted login fails, with the endpoint + response for triage."""


def _b64(s: str) -> str:
    return base64.b64encode(s.encode("ascii")).decode("ascii")


def _post(session, url, payload, headers=None):
    r = session.post(url, json=payload, headers=headers or {}, timeout=_TIMEOUT)
    try:
        body = r.json()
    except ValueError:
        raise FyersLoginError(f"{url} returned non-JSON ({r.status_code}): {r.text[:200]}")
    return r, body


def login_fyers(force: bool = False) -> dict:
    """Refresh the Fyers session unattended. Returns {ok, message}. Idempotent: skips if already
    logged in for today unless force=True."""
    if not force and _fyers_client.is_logged_in():
        return {"ok": True, "message": "already logged in", "skipped": True}

    fy_id = (os.environ.get("FYERS_FY_ID") or "").strip()
    totp_secret = (os.environ.get("FYERS_TOTP_SECRET") or "").strip()
    pin = (os.environ.get("FYERS_PIN") or "").strip()
    client_id = (os.environ.get("FYERS_CLIENT_ID") or "").strip()      # e.g. XJUY6LS1TL-100
    redirect_uri = (os.environ.get("FYERS_REDIRECT_URI") or "").strip()
    missing = [k for k, v in {
        "FYERS_FY_ID": fy_id, "FYERS_TOTP_SECRET": totp_secret, "FYERS_PIN": pin,
        "FYERS_CLIENT_ID": client_id, "FYERS_REDIRECT_URI": redirect_uri,
    }.items() if not v]
    if missing:
        raise FyersLoginError(f"missing env vars: {', '.join(missing)}")

    # FYERS_CLIENT_ID is "<app_id>-<appType>", e.g. XJUY6LS1TL-100
    app_id, _, app_type = client_id.partition("-")
    if not app_type:
        raise FyersLoginError(f"FYERS_CLIENT_ID '{client_id}' is not in '<app_id>-<appType>' form")

    s = requests.Session()
    proxies = _proxies()
    if proxies:
        s.proxies.update(proxies)

    # 1. send login OTP
    _, b1 = _post(s, _SEND_OTP, {"fy_id": _b64(fy_id), "app_id": "2"})
    request_key = b1.get("request_key")
    if not request_key:
        raise FyersLoginError(f"send_login_otp had no request_key: {b1}")

    # 2. verify OTP (TOTP from the stored seed)
    _, b2 = _post(s, _VERIFY_OTP, {"request_key": request_key, "otp": pyotp.TOTP(totp_secret).now()})
    request_key = b2.get("request_key")
    if not request_key:
        raise FyersLoginError(f"verify_otp had no request_key (TOTP wrong/expired?): {b2}")

    # 3. verify PIN -> vagator access token
    _, b3 = _post(s, _VERIFY_PIN, {
        "request_key": request_key, "identity_type": "pin", "identifier": _b64(pin),
    })
    vagator_token = (b3.get("data") or {}).get("access_token")
    if not vagator_token:
        raise FyersLoginError(f"verify_pin had no access_token (PIN wrong?): {b3}")

    # 4. exchange vagator token for an auth_code against our app
    _, b4 = _post(s, _TOKEN, {
        "fyers_id": fy_id, "app_id": app_id, "redirect_uri": redirect_uri, "appType": app_type,
        "code_challenge": "", "state": "trading-app", "scope": "", "nonce": "",
        "response_type": "code", "create_cookie": True,
    }, headers={"Authorization": f"Bearer {vagator_token}"})
    url = b4.get("Url") or b4.get("url")
    if not url:
        raise FyersLoginError(f"api/v3/token had no Url with auth_code: {b4}")
    auth_code = urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get("auth_code", [None])[0]
    if not auth_code:
        raise FyersLoginError(f"no auth_code in returned Url: {url}")

    # 5. hand off to the existing client, which generates + caches the daily token
    _fyers_client.exchange_auth_code(auth_code)
    return {"ok": True, "message": "logged in", "skipped": False}


if __name__ == "__main__":
    from dotenv import load_dotenv
    load_dotenv()
    try:
        print(login_fyers(force=True))
    except Exception as e:
        print(f"LOGIN FAILED: {e}")
