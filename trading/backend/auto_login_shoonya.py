"""
Shoonya headless auto-login via Playwright. Shoonya's login is a browser-only OAuth flow and
api.shoonya.com blocks datacenter IPs, so this MUST run on the box (home IP) with a real browser —
HTTP replay (as used for Zerodha/Fyers) isn't possible.

It fills USER ID / PASSWORD / TOTP on Shoonya's OAuth page and submits; Shoonya then redirects to the
backend's registered redirect (`/shoonya/auth/redirect`), which exchanges the code and logs the
RUNNING backend's Shoonya client in. We then confirm via /shoonya/auth/status.

Selectors (from the live page 2026-10-03): #lgnusrid, #lgnpwd, #lgnotp, button text 'LOGIN'.
Requires in .env: SHOONYA_USERID, SHOONYA_PASSWORD, SHOONYA_TOTP_SECRET (client/secret already set).
Prereq: Playwright + chromium. Run:  python auto_login_shoonya.py
"""
import os
import time

import pyotp
import requests
from playwright.sync_api import sync_playwright

BACKEND = "http://localhost:8000"
_TIMEOUT = 45000  # ms for page waits


class ShoonyaLoginError(RuntimeError):
    pass


def _logged_in() -> bool:
    try:
        return bool(requests.get(f"{BACKEND}/shoonya/auth/status", timeout=6).json().get("logged_in"))
    except Exception:
        return False


def login_shoonya(force: bool = False) -> dict:
    if not force and _logged_in():
        return {"ok": True, "message": "already logged in", "skipped": True}

    userid = (os.environ.get("SHOONYA_USERID") or "").strip()
    password = (os.environ.get("SHOONYA_PASSWORD") or "").strip()
    totp_secret = (os.environ.get("SHOONYA_TOTP_SECRET") or "").strip()
    missing = [k for k, v in {"SHOONYA_USERID": userid, "SHOONYA_PASSWORD": password,
                              "SHOONYA_TOTP_SECRET": totp_secret}.items() if not v]
    if missing:
        raise ShoonyaLoginError(f"missing env vars: {', '.join(missing)}")

    try:
        oauth_url = requests.get(f"{BACKEND}/shoonya/auth/login-url", timeout=10).json()["url"]
    except Exception as e:
        raise ShoonyaLoginError(f"couldn't get Shoonya OAuth URL from backend: {e}")

    final_url = ""
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        try:
            page.goto(oauth_url, wait_until="domcontentloaded", timeout=_TIMEOUT)
            page.wait_for_selector("#lgnusrid", timeout=_TIMEOUT)
            page.fill("#lgnusrid", userid)
            page.fill("#lgnpwd", password)
            page.fill("#lgnotp", pyotp.TOTP(totp_secret).now())
            page.click("button:has-text('LOGIN')")
            # Shoonya -> backend /shoonya/auth/redirect (exchanges code) -> FRONTEND_URL?shoonya_login=...
            try:
                page.wait_for_url(lambda u: ("code=" in u) or ("shoonya_login" in u), timeout=_TIMEOUT)
            except Exception:
                pass
            final_url = page.url
        finally:
            ctx.close()
            browser.close()

    # The redirect does the exchange server-side; poll the backend until the session is live.
    for _ in range(6):
        if _logged_in():
            return {"ok": True, "message": "logged in", "skipped": False}
        time.sleep(2)
    raise ShoonyaLoginError(f"login did not complete (last url: {final_url}) — wrong password/TOTP, "
                            "IP not whitelisted on trade.shoonya.com, or the login page changed")


if __name__ == "__main__":
    import sys
    from dotenv import load_dotenv
    load_dotenv()
    # default: skip if already logged in (used by the orchestrator subprocess). --force to always try.
    try:
        print(login_shoonya(force="--force" in sys.argv))
    except Exception as e:
        print(f"LOGIN FAILED: {e}")
