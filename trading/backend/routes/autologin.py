"""Manual trigger + status for broker auto-login. The scheduler runs it automatically ~08:30 IST;
these endpoints let the user (or a dashboard button) run it on demand or check the last result."""
from fastapi import APIRouter

import auto_login

router = APIRouter(prefix="/autologin", tags=["autologin"])


@router.post("/run")
def run(force: bool = True):
    """Log in all configured brokers now. force defaults True for a manual run."""
    return auto_login.run_all(force=force)


@router.post("/shoonya")
def run_shoonya():
    """Run ONLY the Shoonya automated (Playwright) login, once. For the dashboard's
    'Auto-login Shoonya' button so the user can re-connect after re-whitelisting their IP
    without opening Claude. ONE attempt per call — the caller (button click) controls retries;
    this never loops, because repeated failed Shoonya logins lock the account. On failure the
    IP-drift hint is appended so the UI can tell the user which IP to whitelist."""
    r = auto_login.login_shoonya(force=True)
    if not r.get("ok"):
        hint = auto_login._shoonya_ip_hint()
        if hint:
            r = {**r, "ip_hint": hint}
    return r


@router.get("/status")
def status():
    return auto_login.get_status()
