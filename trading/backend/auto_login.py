"""
Broker auto-login orchestrator + morning scheduler.

Runs INSIDE the backend process (started from main.py like the other watchers) so the
refreshed daily tokens update the SAME in-memory broker-client singletons the API uses —
a separate script would only refresh the on-disk token files, which the running backend
wouldn't pick up.

Logs in Zerodha + Fyers. Shoonya is intentionally excluded for now — it's logged in
manually because its whitelisted egress IP keeps drifting (see the overhaul plan). Adding
it later is just one more entry in _BROKERS.

Schedule: ~08:30 IST on trading days (weekday and not an NSE holiday). Idempotent — each
broker's own login() skips if already logged in for the day, so a late backend start or a
mid-day restart just re-verifies. A single Telegram alert fires if any broker fails, so a
dead session is never a silent surprise at 9:15.
"""
import os
import subprocess
import sys
import threading
from datetime import datetime, date, time as dtime, timezone, timedelta

import requests

import holiday_calendar
import telegram_news
from auto_login_zerodha import login_zerodha
from auto_login_fyers import login_fyers

_BACKEND = "http://localhost:8000"
_SHOONYA_SCRIPT = os.path.join(os.path.dirname(__file__), "auto_login_shoonya.py")


def login_shoonya(force: bool = False) -> dict:
    """Shoonya login runs via Playwright (browser-only OAuth) in a SUBPROCESS — isolates the headless
    browser from the backend process. Returns {ok, message}. On failure the IP hint is added by the
    caller (whitelist drifts, so a failed Shoonya login is usually 'current IP not whitelisted')."""
    try:
        if not force and requests.get(f"{_BACKEND}/shoonya/auth/status", timeout=6).json().get("logged_in"):
            return {"ok": True, "message": "already logged in", "skipped": True}
    except Exception:
        pass
    args = [sys.executable, _SHOONYA_SCRIPT] + (["--force"] if force else [])
    try:
        subprocess.run(args, capture_output=True, text=True, timeout=150)
    except Exception as e:
        return {"ok": False, "message": f"shoonya login subprocess error: {e}"}
    try:
        if requests.get(f"{_BACKEND}/shoonya/auth/status", timeout=6).json().get("logged_in"):
            return {"ok": True, "message": "logged in", "skipped": False}
    except Exception:
        pass
    return {"ok": False, "message": "login did not complete"}


def _shoonya_ip_hint() -> str:
    """If the home IP has drifted off the Shoonya whitelist, return a Telegram-ready hint naming the
    new IP to whitelist — the usual cause of a Shoonya login failure."""
    try:
        g = requests.get(f"{_BACKEND}/shoonya/ip-guard", timeout=6).json()
        if g.get("changed") and not g.get("logged_in"):
            return (f"\n   ↳ Your IP changed to <b>{g.get('current_ip')}</b> (was {g.get('last_ok_ip')}) "
                    f"— whitelist it as the Primary IP on trade.shoonya.com's API-key page, then re-run "
                    f"/autologin/run.")
    except Exception:
        pass
    return ""


# broker label -> login callable(force: bool) -> {"ok": bool, "message": str, "skipped"?: bool}
_BROKERS = {
    "Zerodha": login_zerodha,
    "Fyers": login_fyers,
    "Shoonya": login_shoonya,   # Playwright subprocess; IP-change hint added on failure
}

_IST = timezone(timedelta(hours=5, minutes=30))  # box may not be on IST; pin it explicitly
_TARGET = dtime(8, 30)                            # 08:30 IST
_POLL = 60                                        # seconds between schedule checks
_SHOONYA_RETRY_DELAY = 240                        # 4 min — one bounded morning retry for Shoonya

_lock = threading.Lock()
_stop_event = threading.Event()
_thread: threading.Thread | None = None
_last_run_date: date | None = None
_last_result: dict = {"ran_at": None, "results": {}}


def _is_trading_day(d: date) -> bool:
    """Weekday and not an NSE holiday. Fail-open (treat as trading day) if the holiday feed
    hasn't loaded yet — attempting a login on a holiday is harmless; skipping a real day isn't."""
    if d.weekday() >= 5:  # Sat/Sun
        return False
    holidays = {h["date"] for h in holiday_calendar.get_all()}
    return d.isoformat() not in holidays


def _shoonya_ip_changed() -> bool:
    """True if the home IP has drifted off the Shoonya whitelist. Used to decide whether a failed
    Shoonya login is worth retrying — if the IP changed, a retry will just fail again (and burn an
    attempt), so we skip it; if the IP is unchanged, the failure is transient and a retry is safe."""
    try:
        return bool(requests.get(f"{_BACKEND}/shoonya/ip-guard", timeout=6).json().get("changed"))
    except Exception:
        return False  # can't tell -> treat as unchanged so the (safe, bounded) retry still runs


def run_all(force: bool = False, shoonya_retry: bool = False) -> dict:
    """Log in every configured broker. force=True re-logs even if already logged in today.
    Returns {broker: {ok, message}}. Sends ONE Telegram alert listing any failures.

    shoonya_retry=True (used by the morning scheduler) gives Shoonya exactly ONE extra attempt
    after a short delay IF its first attempt failed AND the IP hasn't changed — Shoonya's login is
    flaky enough that a single 08:30 miss is often transient, and this makes it self-heal without a
    dashboard click. Bounded at 2 attempts total, well short of the many-rapid-failures that lock
    the account; skipped on an IP-change failure (pointless) and when already logged in."""
    with _lock:
        results = {}
        for name, fn in _BROKERS.items():
            try:
                r = fn(force=force)
            except Exception as e:  # a login module raising is itself a failure to report
                r = {"ok": False, "message": str(e)}
            results[name] = r

        # Bounded morning self-heal: one more Shoonya try after a pause, only for a transient miss.
        if (shoonya_retry and not results.get("Shoonya", {}).get("ok")
                and not _shoonya_ip_changed()):
            _stop_event.wait(_SHOONYA_RETRY_DELAY)  # interruptible sleep; no-op if shutting down
            if not _stop_event.is_set():
                try:
                    results["Shoonya"] = login_shoonya(force=True)
                except Exception as e:
                    results["Shoonya"] = {"ok": False, "message": str(e)}

        # A fresh Fyers login refreshes the token, but the data socket's own auto-reconnect keeps
        # reusing the OLD token ("Please provide valid token") — so the whole live feed stays dead at
        # market open until rebuilt. Restart it here the moment Fyers re-logs in.
        if results.get("Fyers", {}).get("ok"):
            try:
                import fyers_ws
                fyers_ws.restart("fyers re-login")
            except Exception:
                pass

        failures = []
        for name, r in results.items():
            if not r.get("ok"):
                msg = f"{name}: {r.get('message')}"
                if name == "Shoonya":
                    msg += _shoonya_ip_hint()
                failures.append(msg)

        global _last_result
        _last_result = {"ran_at": datetime.now(_IST).isoformat(timespec="seconds"), "results": results}

        if failures:
            try:
                telegram_news.send_alert(
                    "⚠️ <b>Broker auto-login failed</b>\n" + "\n".join(failures)
                    + "\n\nLog in manually from the trading dashboard."
                )
            except Exception:
                pass
        return results


def _loop():
    global _last_run_date
    while not _stop_event.is_set():
        try:
            now = datetime.now(_IST)
            if (now.time() >= _TARGET
                    and _last_run_date != now.date()
                    and _is_trading_day(now.date())):
                _last_run_date = now.date()  # set BEFORE the (possibly 4-min) run so a slow retry
                run_all(force=False, shoonya_retry=True)  # can't re-trigger the daily run
        except Exception:
            pass
        _stop_event.wait(_POLL)


def ensure_started():
    global _thread
    if _thread is None or not _thread.is_alive():
        _stop_event.clear()
        _thread = threading.Thread(target=_loop, daemon=True)
        _thread.start()


def get_status() -> dict:
    return {
        "scheduled_target_ist": _TARGET.strftime("%H:%M"),
        "brokers": list(_BROKERS),
        "last": _last_result,
        "last_run_date": _last_run_date.isoformat() if _last_run_date else None,
    }
